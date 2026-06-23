# S2.3 カスタム演習 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)で実装する。

**Goal:** フィルタ(試験 × tag × 回答状態 × streak)で出題集合を抽出し、smart と同一のセッション機構で演習する「カスタム演習」を実装する。

**Architecture:** 回答セッション以降(SessionLauncher → SessionRunner → review-events → bulk flush → server FSRS → pullBack)は smart と共有。custom 固有は (a) client 選定器 (b) フィルタフォーム (c) mode 配線 (d) 設定の件数項目(smart/custom 別 + 上限なし)のみ。

**Spec(唯一の起点):** `docs/superpowers/specs/2026-06-23-s2-3-custom-exercise-design.md`

## Global Constraints

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① テスト可能(該当 unit test green)② review Critical 0 ③ `[reviewed]`(feat/fix は canonical `superpowers:requesting-code-review` 経路必須)。
- 述語適用は **ClientCard(snake_case)**、SessionRunner 供給は **server Card(camelCase)**。選定器内で「述語 → `toCard` 変換」の順序厳守(§spec 2.5)。
- tenant 分離: Dexie 読みは必ず `user_id === userId` を効かせる。
- DB nullable 表現: `null = 上限なし`、行不在 = 既定値(smart 20 / custom 20)。両者を `?? 20` で潰さない(spec §4.2)。
- Test: Vitest。Dexie 絡みは fake-indexeddb(`get-dexie-session-cards.test.ts` 準拠)。純関数は node 環境。AI/課金は非該当。
- `--no-verify` 全面禁止。lint は eslint.config.mjs が正本。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` exit 0(報告に1行明記)。
- schema/型を広く触るため追加で `pnpm typecheck` + `pnpm build` exit 0。
- review dispatch の観点 list に whole-repo lint 実行確認を含める(CC + reviewer 2 経路)。
- stg smoke 対象 task: T1(table 置換)/ T7(smart host refactor)/ T11(custom 一気通貫)/ T9(共有 popover 改修)。push 後 OT 指示で DevTools MCP 実走。

---

### Task 1: tag join 共有 helper 抽出 + table 置換(Q-1)

**目的:** `exam-card-table.tsx:88-105` の inline join を純関数 `joinCardTags` に抽出し、table を置換(pure refactor)。custom 選定器が同 join を共用する基盤。

**Files:** Create `lib/cards/join-card-tags.ts` / `lib/cards/join-card-tags.test.ts`。Modify `exam-card-table.tsx`(join を helper 呼出へ)、`exam-card-table-columns.tsx:25`(`ExamCardRow` を helper の型へ alias)。

**Interfaces(Produces):**
- `export type CardWithTags = { card: ClientCard; tags: Array<{ category: ClientTagCategory; option: ClientTagOption }> }`
- `export function joinCardTags(cards: ClientCard[], cardTags: ClientCardTag[], categories: ClientTagCategory[], options: ClientTagOption[]): CardWithTags[]`
- `exam-card-table-columns.ts`: `export type ExamCardRow = CardWithTags`(既存 import 互換維持)。

**制約:** 挙動完全不変(option 不在/category 不在の skip ロジックを現行どおり保持)。Dexie 非依存(既読配列を受ける)。

**完了条件:** join helper unit test green(option/category 欠落 skip、複数 tag グルーピング)。`exam-card-table.test.tsx` 既存 green。table 置換は canonical review + stg smoke 対象。

---

### Task 2: 試験述語 matchesExamFilter

**目的:** `card-filter-predicates.ts` に試験フィルタ述語を既存パターンで追加。

**Files:** Modify `app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts`。Test `card-filter-predicates.test.ts`(追記)。

**Interfaces(Produces):** `export function matchesExamFilter(card: { exam_id: string }, examIds: string[]): boolean`(`examIds` 空 → true、非空 → `examIds.includes(card.exam_id)`)。

**制約:** 純関数・副作用なし。入力は snake_case `exam_id`。複数試験 = OR(集合 IN)。

**完了条件:** unit test green(空配列 pass / 一致 pass / 不一致 fail / 複数 OR)。

---

### Task 3: custom 選定器 get-custom-session-cards

**目的:** Dexie 全 exam 横断読み → join(T1)→ 述語 AND(T2 + 既存3)→ order 分岐 → cap → `toCard` で server Card[]。

**Files:** Create `lib/cards/get-custom-session-cards.ts` / `.test.ts`。

**Interfaces(Consumes:** `joinCardTags`/`matchesExamFilter`/`matchesTagFilter`/`matchesAnswerState`/`matchesStreakFilter`/`toCard`/`sortLikeServer`。**Produces:**
- 入力型 `CustomSessionCriteria = { userId: string; examIds: string[]; tagFilter: TagFilterValue; answerState: AnswerStateFilter; streakFilter: StreakFilterValue | null; order: 'random' | 'sequential'; limit: number | null }`
- `export async function getCustomSessionCards(c: CustomSessionCriteria, rng?: () => number): Promise<Card[]>`

**制約:** cards は `db.cards.where('user_id').equals(userId).toArray()`(due gate なし)。card_tags は対象 card_id 集合に `anyOf` で絞る(table と同方針)。順序: `sequential`→`sortLikeServer` / `random`→Fisher-Yates(`rng` 既定 `Math.random`、test 注入可)。`limit===null` は cap 無効(slice 省略)。**順序適用 → cap → toCard** の順。

**完了条件:** fake-indexeddb test green: 述語 AND の絞り込み / cross-exam / tenant 分離 / sequential=sortLikeServer 順 / random=注入 rng で決定的順列 / limit 件数 cap / limit=null 全件 / 出力が camelCase server Card。

---

### Task 4: userSettings schema 拡張 + migration

**目的:** `sessionLimit` を nullable 化 + `customSessionLimit integer`(nullable, default 20)追加。`null = 上限なし`。

**Files:** Modify `lib/db/schema.ts:488`(`.notNull()` 除去、`.default(20)` 維持)+ `customSessionLimit: integer('custom_session_limit').default(20)` 追加。生成 migration `drizzle/migrations/0021_*.sql`。

**制約:** `ClientUserSettings`(Dexie)は触らない(Q-5: pull writer 不在を確認済、RSC 読みのみ)。破壊的変更可(prod user 0)。

**完了条件:** `pnpm db:generate` で 0021 migration 生成 → SQL を目視確認(ALTER DROP NOT NULL + ADD COLUMN)。`pnpm typecheck` exit 0(`UserSettings.sessionLimit: number | null` 波及)。migration の適用(`db:migrate`)は環境操作 = OT。

---

### Task 5: 保存 action(上限なし対応 + custom)

**目的:** smart/custom それぞれの件数を保存。`null` で上限なし。

**Files:** Modify `save-session-limit.ts`(signature `value: number | null`)。Create `_actions/save-custom-session-limit.ts`。Test 両者。

**Interfaces(Produces):**
- `saveSessionLimit(value: number | null): Promise<ActionResult<void>>`
- `saveCustomSessionLimit(value: number | null): Promise<ActionResult<void>>`

**制約:** validation = `value === null || (Number.isInteger(value) && 1 <= value <= 200)`、外れたら `{ ok:false, error:'1〜200 で指定してください' }`。upsert は既存 lazy-init pattern(insert + onConflictDoUpdate、conflict branch で `updatedAt` 明示)。custom は `customSessionLimit` 列。

**完了条件:** unit test green(null 保存 / 範囲内 / 範囲外 reject / 非整数 reject)。

---

### Task 6: 設定 UI(上限なしトグル + 2 フォーム)

**目的:** `SessionLimitForm` を `number | null` 対応(上限なしトグル)+ 保存 action を prop 化し、設定画面に smart/custom 2 つ並べる。

**Files:** Modify `session-limit-form.tsx`(prop 追加: `onSave: (v:number|null)=>Promise<ActionResult>`, `label?`, `initial: number | null`)。Modify `settings/page.tsx`(nullable 読み + 2 フォーム)。Test 追記。

**制約:** 上限なし = checkbox。checked 時 `value=null`・数値 input disable・preset disable。`settings/page.tsx` 読み: `const row = settingsRows[0]; const smart = row ? row.sessionLimit : 20; const custom = row ? row.customSessionLimit : 20`(null は維持、行不在のみ 20)。学習設定 section(`page.tsx:135-154`)内に「smart 用」「custom 用」見出しで 2 つ配置。custom フォームは `onSave={saveCustomSessionLimit}`。

**完了条件:** form test green(上限なし toggle で null 送信 / 数値送信 / message 表示)。両フォーム render。

---

### Task 7: SessionLauncher 抽出 + SessionRunner 見出し prop(Q-6 確定)

**目的:** StudySessionHost からセッション起動部(createStudySession + sessionId 状態機 + empty/loading + SessionRunner render)を共有 `SessionLauncher` に抽出。smart はそれに委譲。custom も再利用。gap-2(見出し hardcode)を解消。

**Files:** Create `app/(app)/app/study/_components/session-launcher.tsx` / test。Modify `study-session-host.tsx`(選定後 `<SessionLauncher>` へ委譲)、`session-runner.tsx:416`(見出し prop 化)。

**Interfaces(Produces):**
- `SessionLauncher` props `{ cards: Card[]; fsrsMode: boolean; mode: 'smart' | 'custom'; examId?: string; heading: string; emptyState: React.ReactNode }`。`cards.length===0`→`emptyState`、else StrictMode-safe `createStudySession`(cancelled flag 踏襲)→ sessionId 採番 → `<SessionRunner heading={heading}>`。
- `SessionRunner` に `heading?: string`(既定 `'スマート復習'`、`:416` h1 で使用)。

**制約(Q-6 条件):** smart 既存挙動を回帰させない — 選定(due Dexie/server fallback)と選定中 Loading は **StudySessionHost に残す**。SessionLauncher は「解決済 cards を受けて起動」だけを担う。smart の empty 文言/CTA は `emptyState` に現行どおり渡す。

**完了条件:** SessionLauncher test green(空→emptyState / 非空→createStudySession 1 回 + SessionRunner / StrictMode 二重 mount で session 1 件)。`study-session-host.test.tsx` / `session-runner.test.tsx` 既存 green(heading 既定で不変)。smart canonical review + stg smoke 対象。

---

### Task 8: smart 上限なし伝播

**目的:** smart 側も「上限なし」を効かせる(OT 決定)。`limit: number | null` を選定器まで通す。

**Files:** Modify `get-session-cards.ts` / `get-dexie-session-cards.ts`(`limit: number | null`、null で `.limit()` 省略)。Modify `study/smart/page.tsx`(nullable 読み)、`study-session-host.tsx`(`sessionLimit: number | null`)。Test 追記。

**制約:** `get-session-cards`: null なら `.limit()` を chain しない。`get-dexie-session-cards`: 同様に between range のまま `.limit` 省略。`page.tsx:27` を `const row = settingsRows[0]; const sessionLimit = row ? row.sessionLimit : 20`。

**完了条件:** 選定器 test green(limit=null 全件 / 数値 cap 維持)。smart page/host 型整合 typecheck exit 0。

---

### Task 9: CardTagAddPopover に selectOnly prop(filter 専用、Q-7)

**目的:** custom フィルタの tag 選択で新規作成/編集導線を出さないため、popover に選択専用モードを追加。Grid-2 filter の編集導線混入 quirk を custom で繰り返さない。

**Files:** Modify `card-tag-add-popover.tsx`(`selectOnly?: boolean` 追加、既定 false = 現行)。Test 追記。

**制約:** `selectOnly===true` のとき: stage1 combobox の「新規作成」行・kebab(編集導線)・createCategoryType 経路を非表示/無効化。`tagEditCallbacks` は型上 optional 化はせず、selectOnly 時に create/edit を render しないことで未使用にする(no-op 注入で凌がない)。既存 filter-bar / TagCell 呼出は `selectOnly` 未指定で挙動不変。

**完了条件:** popover test green(selectOnly で新規作成行・kebab 非表示 / 選択 toggle は機能 / 既定 false で全既存 test green)。shared component のため canonical review + stg smoke 対象。

**判断ポイント(報告対象):** selectOnly prop 追加 vs custom 専用の簡易 tag selector 自作。本 plan は前者(単一 source 維持、Q-1 と同principle)を採用。OT 異論あれば差し替え。

---

### Task 10: custom フィルタフォーム

**目的:** 試験 multiselect + tag(selectOnly popover)+ 回答状態 select + streak select/input + 出題順セレクタ を local state で集約し、確定条件を親へ渡す。

**Files:** Create `study/custom/_components/custom-filter-form.tsx` / test。

**Interfaces(Produces):** `CustomFilterForm` props `{ userId: string; onStart: (c: Omit<CustomSessionCriteria,'userId'|'limit'>) => void }`。内部 `useLiveQuery` で `exams`(`where('user_id').equals(userId)`)/ `tag_categories` / `tag_options` を Dexie から読む。出題順 = 「ランダム / 順番どおり」select(`order`)。

**制約(Q-7):** `categories/options/exams` は Dexie mirror 読みのみ。`CardTagAddPopover` は `selectOnly` + 選択 props のみ(tagEditCallbacks の新規/編集導線を出さない)。フィルタ値型は既存(`TagFilterValue`/`AnswerStateFilter`/`StreakFilterValue`)を流用、回答状態/streak の UI は filter-bar 実装を local-state 版に再ホスト。出題順デフォルト = `sequential`(国試系の順番演習を既定。OT 異論あれば変更)。

**完了条件:** form test green(各条件の local state 更新 / onStart payload に 5 条件が乗る / 出題順切替)。

---

### Task 11: custom route + フロー配線(一気通貫)

**目的:** `/app/study/custom` を新設。フォーム → 演習開始 → 選定器 → SessionLauncher。RSC で custom 件数を読み props 注入。

**Files:** Create `study/custom/page.tsx`(RSC: auth + userSettings の `customSessionLimit` 読み)、`study/custom/_components/custom-session-flow.tsx`(client: フォーム保持 → onStart で `getCustomSessionCards` 実行 → resolved cards を `SessionLauncher` へ)、`study/custom/loading.tsx`。Test。

**Interfaces(Consumes):** `CustomFilterForm`/`getCustomSessionCards`/`SessionLauncher`。RSC は `customLimit: number | null` を flow に渡す。

**制約:** flow は「フォーム表示 → start で選定中 Loading → 0 件なら custom 用 empty(『条件に一致するカードがありません』+ 条件変更 CTA)→ 非空なら `<SessionLauncher mode='custom' heading='カスタム演習' emptyState={...}>`」。`fsrsMode` も smart と同様 RSC 読みで渡す(同じに効く)。selection は client(Dexie)、limit は RSC 由来 props。

**完了条件:** flow test green(start→選定→launcher / 0 件→empty)。stg smoke 一気通貫(フィルタ→開始→回答→flush→server 反映→pullBack)対象。Q-3 実装詳細(unlimited cap 無効化は T3 で実装済、巨大集合の目安件数表示の要否)を本 task で最終判断し、出すなら抽出件数を form に表示(警告ではない)。

---

### Task 12: エントリ配線

**目的:** dashboard の「カスタム演習（準備中）」を有効化 + header nav 追加。

**Files:** Modify `dashboard-actions.tsx:92-99`(disabled 撤去 + `<Link href="/app/study/custom" prefetch={false}>`)、`app-header.tsx:35`(custom nav link 追加、`prefetch={false}` 統一)。Test 追記。

**制約:** skeleton 分岐(`:71-74`)の placeholder も実 link に更新。文言は「カスタム演習」。

**完了条件:** dashboard-actions test green(custom link 表示)。

---

## Self-Review(spec 対応)

- spec §3.2 選定器 → T3 / §3.3 試験述語 → T2 / §3.4 join 抽出 → T1 / §3.5 フォーム → T10(+T9 selectOnly)/ §4 設定 → T4-T6 / §2.3 gap-1(mode 配線)→ T7+T11 / gap-2(ラベル)→ T7 / smart 上限なし → T8 / エントリ → T12。
- Q-6 確定 = T7 SessionLauncher 抽出(smart は選定を保持し起動を委譲)。Q-2 = T3/T10 の order セレクタ。Q-3 = T3(cap 無効化)+ T11(目安表示判断)。
- 型整合: `CardWithTags`(T1)= `ExamCardRow` alias / `CustomSessionCriteria`(T3)を T10/T11 が consume / `SessionLauncher` heading prop(T7)を T11 が渡す / action signature `number | null`(T5)を T6 が呼ぶ。
- 未確定で plan に残す判断: T9 の tag-UI 機構(selectOnly prop 採用、OT 異論余地)/ T10 出題順デフォルト(sequential 採用)/ T11 巨大集合 目安表示の要否。
