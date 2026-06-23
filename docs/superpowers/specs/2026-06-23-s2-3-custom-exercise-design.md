# S2.3 カスタム演習 — Design Spec

- 起票日: 2026-06-23
- フェーズ: S2.3(カスタム演習)
- スコープ確定: OT 承認済(本 spec の「確定スコープ」節は OT 合意事項。spec 凍結対象)
- 前提調査: 同 sprint の fact-finding(実コード全文裏取り)。本 spec の「確定事実」節は再裏取り済。
- 本 spec はデザイン記録。タスク分割は writing-plans で別途。

---

## 1. 概要 / 確定スコープ

カスタム演習 = **「フィルタで出題集合を抽出 → 回答セッション」**。

回答セッション以降の機構(`StudySessionHost → SessionRunner → review-events → /api/review-events/bulk → server FSRS 再計算 → pullBack`)は **smart と完全に同一を流用**する。見た目・回答挙動は smart と同一(FSRS on/off も同じに効く)。

custom 固有の新規部分は以下 4 点のみ:

- (a) **カード選定器**(due を効かせず、フィルタ条件のみで出題集合を決める新規 client 選定経路)
- (b) **フィルタフォーム**(既存テーブルのフィルタ部品を session 文脈で再ホスト + 「試験」述語を追加)
- (c) **custom mode 配線**(mode 別の選定分岐 + UI ラベルの parametrize + custom route/entry)
- (d) **設定のセッション件数項目**(smart/custom 別フィールド + 「上限なし」対応)

server 永続(`studySessions.query` へのフィルタ条件保存)は **v1 スコープ外**(§9)。

---

## 2. 確定事実(実コード裏取り済)

spec の設計判断はすべて以下の実コード事実に基づく。引用は `file:line`。

### 2.1 セッション実行機構は選定方法に非依存で丸ごと再利用可能

- `study/smart/page.tsx`(RSC): auth → `userSettings`(sessionLimit default 20 / fsrsMode default false、`page.tsx:27-28`)→ `getSessionCards`(server fallback)→ `<StudySessionHost cards mode="smart">`。
- `StudySessionHost`(client, mount `useEffect`、`study-session-host.tsx:56-98`): `getDueCardsFromDexie` 優先 → 0件/throw で server props fallback → 0件で empty UI → `createStudySession`(session_id 採番 + Dexie 行)→ `<SessionRunner>`。
- `SessionRunner` は `sessionId` と `cards: Card[]` 実体を受け、回答ごとに `recordAnswerEvent` を Dexie `answer_events` へ即 insert(`review-events.ts:118`)、`FLUSH_THRESHOLD=5` / セッション終了で `/api/review-events/bulk` へ flush。
- → **回答〜FSRS反映の機構は「どうカードを選んだか」に依存しない**。custom は (cards, mode) を差し替えるだけで同機構に乗る。

### 2.2 server bulk route は mode で分岐しない = custom も同一 FSRS 経路【最重要】

- `app/api/review-events/bulk/route.ts`:
  - zod `sessionSchema.mode = z.enum(['smart', 'custom'])`(`route.ts:70`)→ **custom を既に受理**。
  - Phase 0 で `studySessions` upsert に `mode: session.mode` をそのまま書く(`route.ts:527`)。
  - `processSession` の FSRS replay(`replayCard`、`route.ts:264-284`)・reviews/cards/study_days 更新は **全 applicable event に対して mode 無関係に実行**。`if (mode === ...)` のような分岐は route 全体に**存在しない**。
- → **custom session の FSRS 再計算は smart と完全同一経路。server 側の FSRS 変更は不要**(本 spec の「タスクに含めるか」確認事項は「不要」で確定)。

### 2.3 mode='custom' のデータ層予約は端まで通る(ただし挙動側に 2 つの gap)

- 予約は端まで存在: `ClientStudySession.mode: 'smart'|'custom'`(`client-db.ts:113-124`)/ `createStudySession`(`review-events.ts:46`)/ flush payload `session.mode`(`review-events.ts:331`)/ server zod(`route.ts:70`)/ `studySessions.mode` text `$type<'smart'|'custom'>`(`schema.ts`)。型・runtime 共に custom を拒否しない。
- **gap-1(選定が mode 非対応)**: `StudySessionHost` は mount で **常に `getDueCardsFromDexie`(due 駆動)を呼ぶ**(`study-session-host.tsx:62`)。mode による選定分岐は無い。custom は選定器を差し替える配線が必須。
- **gap-2(UI ラベル hardcode)**: 見出し「スマート復習」が 2 箇所 hardcode — `SessionRunner` h1(`session-runner.tsx:416`)と `StudySessionHost` empty UI h1(`study-session-host.tsx:111`)。custom 流用時にラベル parametrize が必要。

### 2.4 既存カード選定 = due 駆動のみ(custom は due gate なし)

- Dexie 経路 `get-dexie-session-cards.ts`: `cards` index `[user_id+due]` を `between([uid,'0'],[uid,nowIso], true, true)` + `.limit(N)`、index 順 = due ASC、`toCard` で server `Card` 型へ変換して返す。
- server 経路 `get-session-cards.ts`: `where(userId AND due ≤ now) order by due ASC limit N`。
- いずれも条件 = 「tenant + due ≤ now」、順序 = due ASC。tag/回答状態/streak の絞り込みは無い。

### 2.5 フィルタ述語は純関数だが入力 shape は ClientCard(snake_case)+ join 済 tags 前提

- `card-filter-predicates.ts` は import ゼロ・副作用ゼロ・component/TanStack 非依存(全文確認)。
  - `matchesTagFilter(tags: Array<{category:{id}, option:{id}}>, filter: Record<string,string[]>)`
  - `matchesAnswerState(card: {answered:boolean, last_correct?:boolean|null}, state)`
  - `matchesStreakFilter(streak:number, filter:{op,value}|null|undefined)`
- TanStack 結合は **アダプタ側**(`exam-card-table-columns.tsx:44-51` の `filterFn`)にあり、述語自体はどこからでも呼べる。
- **型不整合**: 述語は **snake_case**(`answered`/`last_correct`/`current_streak`)= **ClientCard 形**を要求。セッションの `resolvedCards` は **server `Card`(camelCase: `lastCorrect`/`currentStreak`、`schema.ts:307-310`)**。→ 述語は **server Card[] に直接当たらない**。`toCard` 変換**前**の生 ClientCard に当てる必要がある。

### 2.6 tag join は exam-card-table の inline useMemo にしか無い

- `exam-card-table.tsx:66-105`: `useLiveQuery` で 4 store(`cards` where exam_id / `tag_categories` / `tag_options` / `card_tags`)を読み、`useMemo` 内で `ExamCardRow[]`(`{card: ClientCard, tags: Array<{category, option}>}`)へ join。
- この join 実装は **再利用可能な helper として抽出されていない**。Dexie mirror store(`card_tags`/`tag_categories`/`tag_options`)自体は揃っている。

### 2.7 フィルタ UI: バー全体は TanStack 密結合、部品は再ホスト容易

- `ExamCardTableFilterBar`(`exam-card-table-filter-bar.tsx`)は `table: Table<ExamCardRow>` を受け `getColumn().getFilterValue()/setFilterValue()` / `setColumnFilters([])` で read/write。**丸ごとは TanStack 外で使えない**。
- 部品は疎結合化容易: 回答状態 4値 `<select>` / streak op `<select>`+number input は local state へ差し替え自明。tag は `CardTagAddPopover` を**無改造で流用**(`exam-card-table-filter-bar.tsx:208-222`)。`CardTagAddPopover`(`card-tag-add-popover.tsx`)は props `categories/options/allAssignedOptionIds/onToggle/tagEditCallbacks/trigger` のみで table 非依存・汎用。filter-bar が「外部 map 駆動の純タグ選択 UI」として成立を実証済。

### 2.8 設定のセッション件数

- schema: `userSettings.sessionLimit integer notNull default 20`(`schema.ts:488`)、`fsrsMode boolean notNull default false`(`schema.ts:489`)。
- 保存: `saveSessionLimit`(`save-session-limit.ts:9-31`)= `Number.isInteger && 1..200` validation → `userSettings` upsert。
- UI: `SessionLimitForm`(`session-limit-form.tsx`)= preset `[10,20,50]` + free input `min1 max200`。`settings/page.tsx:34` が server-side で `sessionLimit` を読み `initial` として渡す。学習設定 section は `settings/page.tsx:135-154`。
- Dexie mirror `ClientUserSettings`(`client-db.ts:103-109`)= `session_limit` + `fsrs_mode` のみ。**custom 用 field は無い**。

---

## 3. アーキテクチャ / データフロー

### 3.1 custom の全体フロー(smart との差分を明示)

```
[dashboard] カスタム演習 button (enable + Link)
   ↓
/app/study/custom  ← 新規 route
   ├─ フィルタフォーム画面 (新規): 試験 × tag × 回答状態 × streak を AND 指定
   │     ↓ 「演習開始」
   ├─ カード選定器 (新規, client): Dexie 直読 + 4-store join → ClientCard[] に
   │     述語 AND 適用 → cap 適用 → toCard 変換 → server Card[]
   │     ↓
   └─ セッション実行 (smart と同一機構を流用):
         StudySessionHost(mode='custom', cards) → createStudySession(mode='custom')
           → SessionRunner → review-events → bulk flush → server FSRS → pullBack
```

smart との唯一の構造差: **smart は page mount で自動的に due 集合を引いて即セッション開始**。custom は **フィルタフォームという前段画面を挟み、ユーザーが条件を確定して「演習開始」を押してから選定 → セッション**。

### 3.2 カード選定器(新規)詳細

- 入力: userId, フィルタ条件(examIds[], tagFilter, answerState, streakFilter), `order: 'random' | 'sequential'`, cap(number | unlimited)。
- 処理:
  1. Dexie 4-store 読み込み(§3.4 の共有 join helper を使用)。cards は **全 exam 横断**(`where('user_id')` 相当)で読む。due gate は**かけない**。
  2. `{card: ClientCard, tags}[]` に対し述語を AND 適用:
     `matchesExamFilter(card, examIds) && matchesTagFilter(tags, tagFilter) && matchesAnswerState(card, answerState) && matchesStreakFilter(card.current_streak, streakFilter)`
  3. **並べ替え(ユーザー選択式、Q-2 確定)**:
     - `order='sequential'` → `sortLikeServer`(`inline-card-list.tsx` の sort_key 安定順 = sort_key NULLS-LAST 辞書順 + created_at tiebreak)。国試系の「順番どおり演習」用途。
     - `order='random'` → シャッフル(ドリル用途)。
     - due ASC は custom では**使わない**(smart 専用)。
  4. cap 適用(unlimited 時は cap 無効化 = `.limit`/`slice` 省略。Q-3 = plan の実装詳細)。
  5. `toCard`(`lib/db/cards-mapper.ts`)で **server `Card[]` へ変換**して返す(SessionRunner が camelCase の `title`/`questionText`/`options`/`explanationText` を読むため)。
- 配置案: `lib/cards/get-custom-session-cards.ts`(`get-dexie-session-cards.ts` と同階層の sibling)。
- 出題順デフォルト値は plan で決める。

### 3.3 「試験」述語(新規)

- `card-filter-predicates.ts` に既存パターンを踏襲して追加:
  ```
  export function matchesExamFilter(card: { exam_id: string }, examIds: string[]): boolean
  // examIds 空 = 絞り込みなし(true)。非空なら examIds.includes(card.exam_id)。
  ```
- 入力 shape は ClientCard の `exam_id`(snake_case)で既存述語と整合。複数試験 OR(集合 IN)= カテゴリ内 OR と同じ意味論。他述語との合成は AND(§3.2)。

### 3.4 tag join 共有 helper 抽出(Q-1 確定 = 案A)

**確定**: 現状の inline join(`exam-card-table.tsx:88-105`)を純関数へ抽出し、**table と custom 選定器が共用**する。drift 二重保持(custom 別実装)は採らない。

- 抽出する純関数(Dexie 非依存 = 既読配列を受ける):
  ```
  // lib/cards/join-card-tags.ts
  joinCardTags(cards: ClientCard[], cardTags: ClientCardTag[],
               categories: ClientTagCategory[], options: ClientTagOption[]): ExamCardRow[]
  ```
- `exam-card-table.tsx` の inline useMemo を本 helper 呼び出しへ**置換**する(= table を 1 箇所触る → **canonical review + stg smoke 対象**、§5/§7)。置換は既存挙動を変えない pure refactor として行う。
- `ExamCardRow` 型の置き場は要検討(現在 `exam-card-table-columns.tsx:25` に export。共有するなら中立な場所へ移す or re-export)。実装詳細は plan。

### 3.5 フィルタフォーム(新規)

- session 文脈の独立フォーム。TanStack columnFilters ではなく **local state** で条件値を保持: `examIds` / `TagFilterValue` / `AnswerStateFilter` / `StreakFilterValue` + **`order: 'random' | 'sequential'`**(出題順セレクタ)。
- **出題順セレクタ(Q-2 確定)**: 「ランダム / 順番どおり(sort_key 安定順)」をユーザーが選ぶ UI 要素を配置。値は選定器(§3.2 step 3)へ渡す。国試系で順番演習に意味があるための仕様。
- 部品の流用:
  - tag: `CardTagAddPopover` を無改造流用(filter-bar と同じ adapter pattern)。
  - 回答状態 / streak: filter-bar の `<select>` / input 実装を local-state 版に再ホスト。
  - 試験: 新規 multiselect(Dexie `exams` mirror から候補。複数選択)。
- **マスタ供給 / 編集導線(Q-7 確定 = フィルタ専用に絞る)**: custom フォームは `categories`/`options`/`exams` を **Dexie mirror から読むのみ**(`useLiveQuery`、table meta 経由とは別経路)。**`tagEditCallbacks`(タグ新規作成・編集導線)は出さない** — `CardTagAddPopover` には選択用 props のみ渡す。Grid-2 filter popover に編集導線が混入した quirk を custom 側では繰り返さない。
- 部品再ホストの drift を避けるため filter-bar との共通化余地も検討対象だが、filter-bar 自体は `table` 依存で直接共有不可。下位の純 UI 片の共有可否は plan 判断。

---

## 4. 設定のセッション件数(新規・smart/custom 別・上限なし対応)

### 4.1 要件(OT 確定)

- smart 用 / custom 用を**別フィールド**で持つ(性質が異なるため共有しない)。
- 設定 UI は**同一コンポーネントを 2 つ並べる**。
- **両方に「上限なし」を選択肢追加**(smart 側にも追加 = OT 決定)。

### 4.2 三点セット(DB / 型 / UI)— Q-4 確定 = 案A(nullable, `null = 上限なし`)

**確定**: nullable int で「`null = 上限なし`」を表す。RecallMint はユーザー 0(prod 含む)で破壊的変更が自由なため、既存値保護を動機とする sentinel 案(`0=unlimited`)や別 flag 案は**採らない**。

- **DB**: `sessionLimit` を **`notNull` 解除**(nullable 化)+ `customSessionLimit integer`(nullable, default null)を追加。default 値の扱い(smart 既存 `default 20` を維持するか、行不在 fallback に寄せるか)は plan で確定。
- **型**: `UserSettings`(server `$inferSelect`)/ `ClientUserSettings` の該当 field を `number | null` に。
- **fallback 意味論(明確化)**: 値の解釈を 2 段で定義する —
  - **行/列が null** → **上限なし**(unlimited)。
  - **行不在(user_settings 行そのものが無い)** → 既存どおり smart=20 相当の既定。custom 既定値は plan で確定。
  - → `study/*/page.tsx` / `settings/page.tsx` の現行 `?? 20` は「行不在 fallback」と「明示 null=unlimited」を**区別する分岐**へ書き換える(両者を `?? 20` で潰さない)。
- **UI**: 「上限なし」トグル/チェック + 数値入力(unlimited 選択時は数値 input を無効化)。`SessionLimitForm` を unlimited 対応に拡張 or ラッパ化(plan)。

### 4.3 cap の選定器への伝播(Q-5 確定 = RSC server 読み)

- custom 選定器の cap = customSessionLimit(`null` = 無制限 = `.limit`/`slice` 省略、Q-3 = plan 実装詳細)。
- **値の読み取り経路(確定)**: 既存 smart と同形で **RSC(`study/custom/page.tsx`)が server `userSettings` を読み props で渡す**。custom 選定は client だが limit 値は RSC 由来で問題なし。**Dexie mirror(`ClientUserSettings`)への custom limit field 追加はしない**(pull mapping 不変)。

### 4.4 大規模集合の目安表示(検討事項、警告ではない)

- unlimited で巨大集合を引いた場合の 1 セッション長大化に対し、フィルタフォームに**抽出見込み件数の目安表示**を出す程度(警告/ブロックではない)。実装是非と表示位置は plan で詰める。

---

## 5. 影響コンポーネント / 新規ファイル / 既存流用

### 新規
- `app/(app)/app/study/custom/page.tsx`(RSC: auth + settings 読み + フォーム画面 host)
- フィルタフォーム component(`study/custom/_components/` 配下)
- カード選定器 `lib/cards/get-custom-session-cards.ts`
- 試験述語 `matchesExamFilter`(`card-filter-predicates.ts` に追記)
- tag join 共有 helper `lib/cards/join-card-tags.ts`(Q-1 確定 = 抽出する)
- 試験 multiselect UI(custom 用)
- 設定: custom 用 `SessionLimitForm` の 2 つ目配置 + 「上限なし」対応(component 改修 or ラッパ)

### 既存改修
- `dashboard-actions.tsx`: 右ボタン enable + `Link href="/app/study/custom"`(現 disabled placeholder、`:92-99` / `:71-74`)
- `app-header.tsx`: custom nav link 追加(現コメントのみ、`:35`)
- `StudySessionHost`: mode 別選定分岐(gap-1)+ ラベル parametrize(gap-2)。※ smart 既存挙動を壊さない設計が必須。host を mode 対応に拡張するか、custom 用 host を分けるかは plan 判断。
- `SessionRunner`: 見出し hardcode「スマート復習」の parametrize(gap-2、`:416`)
- `card-filter-predicates.ts`: `matchesExamFilter` 追記
- `exam-card-table.tsx`: join を共有 helper 呼び出しへ置換(Q-1 確定、pure refactor。**canonical review + stg smoke 対象**)
- schema(`userSettings`)+ `ClientUserSettings` + saveSessionLimit + settings page/form: smart/custom 別 field + unlimited(§4)

### 既存流用(無改造)
- `SessionRunner` の回答機構 / `review-events.ts` / `/api/review-events/bulk`(§2.2: custom 受理済)/ `pullBack` / `toCard`
- `CardTagAddPopover`(無改造、adapter で流用)
- `card-filter-predicates.ts` の既存 3 述語

---

## 6. データフロー上の不変条件 / 注意

- 述語適用は **ClientCard(snake_case)**、SessionRunner 供給は **server Card(camelCase)**。選定器内で **フィルタ後に `toCard` 変換**する順序を厳守(逆順だと述語が当たらない)。
- custom は cross-tenant 防止のため Dexie 読みで `user_id` 一致を必ず効かせる(table の `filteredCards.filter(c => c.user_id === userId)`、`exam-card-table.tsx:74` と同等)。server 側は bulk route の owner-scoped IN(`route.ts:166-169`)+ `setWhere`(`route.ts:541`)が既に担保。
- session の `card_ids` は server で initial insert のみ(再送で空配列に倒れない、`route.ts:542-545`)。custom も選定スナップショットがそのまま乗る。

---

## 7. テスト方針(概略、詳細は plan)

- 純関数 `matchesExamFilter`: Vitest(既存 `card-filter-predicates.test.ts` に追記)。
- 選定器 `get-custom-session-cards`: Dexie fake/mock で join + 述語 AND + cap + toCard 変換を検証(`get-dexie-session-cards.test.ts` 準拠)。
- join helper: 純関数 unit test。table の既存挙動回帰(置換時)。
- 設定 unlimited: saveSessionLimit validation(unlimited 表現)+ form。
- E2E/stg smoke: フィルタ → 演習開始 → 回答 → flush → server 反映 → pullBack の一気通貫(DevTools MCP)。join helper 置換時は table 側 smoke も対象。
- AI/課金は本 sprint 非該当。

---

## 8. Open Questions(残)

Q-1 / Q-2 / Q-4 / Q-5 / Q-7 は OT 確定済(本文へ畳み込み: Q-1=§3.4, Q-2=§3.2/§3.5, Q-4=§4.2, Q-5=§4.3, Q-7=§3.5)。残る論点:

- **Q-6(StudySessionHost の mode 対応方式)= plan で確定**: 既存 host を mode 分岐に拡張 vs custom 用 host を分離。**条件**: smart 既存挙動(mount での due 自動選定 + Dexie/server fallback + empty UI 一元判断 + session_id 採番)を回帰させないこと。gap-1(選定 hardcode、`study-session-host.tsx:62`)/ gap-2(ラベル hardcode、`session-runner.tsx:416` / `study-session-host.tsx:111`)の両方を満たす構造を plan で決める。
- **Q-3(plan の実装詳細)**: unlimited 時の cap 無効化(`.limit`/`slice` 省略)と、巨大集合時の抽出見込み件数の目安表示(警告ではない、§4.4)の要否・形・表示位置。

---

## 9. v1 Deferred(将来スコープ)

- **`studySessions.query` への フィルタ条件 server 永続**: schema 列は client/server 両方に存在(`client-db.ts:119` / `schema.ts` / `route.ts` zod は query 未受理)。ただし現行 flush payload は query を**送っていない**(`review-events.ts:326-347`)。v1 は **cardIds スナップショットのみ永続**、query 永続は v1 スコープ外。
- **再実行可能な preset**(保存したフィルタ条件で再演習)は query 永続の上に乗る将来機能。v1 非対象。

---

## 10. 要確認サマリ(plan で詰める残点)

- **Q-6**: StudySessionHost の mode 対応方式(host 拡張 vs custom host 分離)。smart 既存挙動の回帰防止が条件。
- **Q-3**: unlimited の cap 無効化と巨大集合の目安表示(実装詳細)。
- §4.2 の default 値確定: smart `default 20` 維持 / custom 既定値 / 行不在 fallback の最終形。
- §3.2: 出題順デフォルト値(random / sequential)。
- 確定済の前提(推測ではなく裏取り済): server submit 経路は §2.2 で「mode 非分岐 = custom 同一 FSRS」、フィルタ述語の snake_case 入力(§2.5)、tag join 抽出可能性(§2.6)。
