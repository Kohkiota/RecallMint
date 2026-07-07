# DDD リファクタ P1 — domain 純粋層抽出 実装 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(task 単位 fresh subagent + task 間 review)。Steps は checkbox 追跡。

**Goal:** I/O 同居の pure fn を pure module へ carve-out し、lib→app 逆依存を 1 件解消し、byte-identical な二重実装を single source 化する(全て挙動不変)。

**Architecture:** 純粋ロジックの移設のみ。新規挙動ゼロ。既存 test suite が回帰網。P0 の contract/golden(5 面 77 test)が「契約面に波及していない」ことの客観判定。

**Tech Stack:** TypeScript strict / Vitest / ESLint flat config(`no-restricted-imports` allowlist)。

- SSoT: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(D-1〜D-6)
- Spec: `docs/superpowers/specs/2026-07-07-ddd-p1-domain-extraction-design.md`(§ 参照は同 spec)
- 前提: HEAD `a11afca`(P0 完了)

## Global Constraints(全 task 共通・冒頭一度)

- **挙動不変(behavior-preserving)**。凍結契約(D-2: payload/error code/HTTP status/日本語文言/cache header/revalidatePath/tombstone entity_type/op 名/ops イベント名)に一切触れない。
- **Dexie の store/index/型の形を変えない**(D-6 発火なし)。触る必要が出たら停止し OT 相談。
- carve-out 先の pure module は **app/ や I/O(`getDb`/`getClientDb`/`stripe`/`logger`)を import しない**(lint + 目視で確認)。
- 各 code task の**完了条件(共通・per-task gate)**: ① 対象 test(当該 task が触る test file)+ `pnpm test:contract`(77・P0 golden 回帰検知)exit 0 ② `pnpm typecheck` exit 0 ③ whole-repo `pnpm lint --max-warnings=0` exit 0 ④ **Task3/4/5 のみ `pnpm build` exit 0**(carve-out/move で import 経路が変わり、pure fn 参照先に server-only module が残ると client 参照で server-only 混入 → typecheck 通過・build で落ちる。§6.3 load-bearing import。build が最後の砦。verbatim dedup(Task1/2)/ 型 relocate(Task6・runtime erase)は新規 server 依存を引く経路が構造上できず per-task build 不要=Task8 集約)⑤ canonical review(全 code task・`superpowers:requesting-code-review` デフォルト経路・template 改変なし)+ Codex(`scripts/ai/codex-review.sh`・**Task3/4/5 のみ**)で未解決 Critical 0 / Important 0 ⑥ commit 末尾 `[reviewed]`。**full `pnpm test`(2979)は Task8 に集約**。
- commit type = `refactor(scope): …`(logic 変更なし)。**Task 4 は決済 module(`lib/stripe/subscription.ts`)に触れる**ため review 必須(重要 fix 裏取り準拠、[reviewed] 付与前に慎重確認)。
- **既存 test は原則そのまま(挙動同一)**。変えるのは import 経路・mock 対象・test file 位置のみ。新規 characterization は書かない(唯一の例外 = Task 1 の `compareTagEntry` unit test)。
- 移設する関数本体は **verbatim**(コピー時に 1 文字も変えない)。本 plan は本体を再掲せず source の行範囲を指す(転記 drift 防止)。
- **行番号は参照補助**(`a11afca` 時点)。実装 HEAD が進むと劣化するため、必ず **symbol ベース**(`rg`/grep)で対象を再特定してから編集する(Codex 論点)。
- **import style**: app→lib は `@/lib/...` エイリアス / 同一ディレクトリ内は relative `./`(既存規約に一致させる。移設後に style が散らないこと)。
- **export 最小化**: 新 pure module は wrapper/consumer が実際に要る symbol のみ export(`addDays`/`compareTagEntry` は利用実体があるため export。予測的 export をしない=YAGNI・Codex 論点)。
- **各 carve-out task の pure 判定確認**: 新 module が値 import で app/ や I/O(`getDb`/`getClientDb`/`stripe` client/`logger`/Next runtime)を引かないことを目視 + `rg "^import"` で確認(外部 SDK の `import type` は許容)。
- module 名は本 plan で確定(spec §3.1/§4 の「例」を確定値に固定)。`lib/streak-core.ts` は既存の flat pure file(`lib/fsrs.ts`/`lib/jst.ts`)と同列の単一目的 pure file として配置(domain 別 folder 化しない=単一 file ゆえ)。
- **review 粒度(OT 確定)**: canonical review = 全 code task。Codex review + per-task build = **リスク task Task 3 / 4 / 5 のみ**(A1 carve-out / A2 決済 / B 境界・lint)。Task 1・2・6 は verbatim 移設・型 relocate ゆえ canonical のみ(Codex/build は Task8 集約)。Task 7 は review 対象外。

---

### Task 1: `compareTagEntry` 抽出(C2 — tag comparator 2 段 wrapper)

**目的:** 3 app site にコピペされた「category 比較 → tiebreak option 比較」の 2 段 comparator を `lib/tags/sort-comparator.ts` に単一化。

**Files:**
- Modify: `lib/tags/sort-comparator.ts`(`sortByKeyThenCreated` の隣に追加)
- Modify(test): `lib/tags/sort-comparator.test.ts`(`compareTagEntry` unit 追加)
- Modify: `app/(app)/app/exams/[id]/_lib/tag-sort-key.ts:22-26` / `_components/exam-card-table-tag-cell.tsx:81-85` / `_components/card-tags-section.tsx:559-569`

**制約:** 新関数は generic 構造型で受ける:
```ts
export function compareTagEntry<
  C extends { sort_key?: string | null; created_at: string },
  O extends { sort_key?: string | null; created_at: string },
>(a: { category: C; option: O }, b: { category: C; option: O }): number {
  const catCmp = sortByKeyThenCreated(a.category, b.category)
  if (catCmp !== 0) return catCmp
  return sortByKeyThenCreated(a.option, b.option)
}
```
- site 置換: `tag-sort-key.ts`・`exam-card-table-tag-cell.tsx` は inline comparator を `compareTagEntry` 呼出へ(`[...tags].sort(compareTagEntry)` 化可)。import を `sortByKeyThenCreated` → `compareTagEntry` に差替(両 file は他所で `sortByKeyThenCreated` 未使用)。
- `card-tags-section.tsx` は `.find` 解決 + 欠落 guard(`if (!optA...) return 0`)を**その場に残し**、末尾 3 行のみ `compareTagEntry({ category: catA, option: optA }, { category: catB, option: optB })` へ。import 同様差替。

**完了条件:** 新 unit(category 差 → option tiebreak → created_at tiebreak の順序を検証、最低 3 case)追加し fail→pass 確認。これは **characterization でなく新 API `compareTagEntry` の unit test**(spec「新規 characterization 不要」と非矛盾・Codex 論点)。3 site 利用の既存 component/lib test green。+ Global 共通完了条件。

---

### Task 2: `computeStreak`+`addDays` hoist(C1 — 二重実装 dedup)

**目的:** server/client で byte-identical な `computeStreak`+`addDays` を共有 pure module へ hoist。二段構え wrapper は温存。

**Files:**
- Create: `lib/streak-core.ts`(`computeStreak` + `addDays` を export。本体 = `lib/db/streak.ts:13-46` verbatim + doc コメント)
- Modify: `lib/db/streak.ts`(local `computeStreak`/`addDays`(5-46)削除 → `import { computeStreak, addDays } from '@/lib/streak-core'`。`getReviewStatsForUser` 温存)
- Modify: `lib/client/streak.ts`(local 定義(21-49)削除 → 同 import。`STREAK_WINDOW_DAYS`/`StreakStats`/`getStreakStatsFromDexie` 温存)
- Modify(test): `lib/db/streak.test.ts:11` / `lib/client/streak.test.ts:8`

**制約:**
- `addDays` は wrapper の lowerBound 算出でも使うため新 module から両方 export。window 算出(server `-60` 直値 / client `-(STREAK_WINDOW_DAYS-1)`= 同値)は**各 wrapper に残す**(挙動同一)。
- test re-point: `computeStreak` のみ `from '@/lib/streak-core'` に変更。`getReviewStatsForUser`/`getStreakStatsFromDexie` は `from './streak'` のまま。**両 test file 温存**(統合しない・spec §3.3 条件)。
- DB/Dexie wrapper 本体は触らない(§4.1 二段構え)。

**完了条件:** `streak.test.ts` ×2 green(各 `computeStreak` 6 case + wrapper)。+ Global 共通完了条件。

---

### Task 3: `deriveExamStatuses` carve-out(A1 — 純粋層抽出)

**目的:** pure `deriveExamStatuses`+定数 `STALE_PROCESSING_MS` を DB 関数同居 file から pure module へ抽出。

**Files:**
- Create: `lib/exams/derive-exam-statuses.ts`(`STALE_PROCESSING_MS`(=`source-doc-status.ts:28`)+ `deriveExamStatuses`(41-89)verbatim。import なし)
- Modify: `lib/exams/source-doc-status.ts`(該当定義削除 → `import { STALE_PROCESSING_MS, deriveExamStatuses } from './derive-exam-statuses'`。DB 関数 3 本温存)
- Move(test): `lib/exams/source-doc-status.test.ts` → `lib/exams/derive-exam-statuses.test.ts`(`git mv`、import を `'./derive-exam-statuses'` に。※現 test は `deriveExamStatuses` のみ test、DB fn test なし)
- Modify consumer:
  - `app/(app)/app/upload/_actions/process.ts:26` → `STALE_PROCESSING_MS` を `@/lib/exams/derive-exam-statuses` から
  - `app/api/exams/status/route.ts:24-28` → import 分割: `STALE_PROCESSING_MS,deriveExamStatuses` を derive-exam-statuses から / `reconcileStaleProcessing` は source-doc-status のまま

**制約:**
- `upload/page.tsx`(`hasActiveProcessingUpload`)/ `exam-status-poll.ts`・`exam-status-live.tsx`(comment のみ)は**変更不要**。実装時に `rg "deriveExamStatuses|STALE_PROCESSING_MS" app/(app)/app/_components/` で symbol import が実在しないことを確認してから「変更不要」を確定(Codex 論点: consumer 範囲の実 HEAD 確認)。
- `api/exams/status/route.test.ts` の `vi.mock('@/lib/exams/source-doc-status')` は `reconcileStaleProcessing` のみ override ゆえ**変更不要**(deriveExamStatuses は derive-exam-statuses から real で来る)。green で確認。
- **DB 関数(`getExamStatusMap`/`reconcile…`/`hasActive…`)の test は現状不在**(source-doc-status.test.ts は pure fn 専用)。test move でこの未カバーが可視化されるが、P1 は挙動不変 phase ゆえ新規追加しない(既存 route.test.ts が経路 test を担保)。残リスクとして報告に 1 行記す。

**完了条件:** derive-exam-statuses.test.ts + route.test.ts green。**`pnpm build` exit 0**(リスク task)。+ Global 共通完了条件。

---

### Task 4: `classifyChange`+`getPendingState` carve-out(A2 — 純粋層抽出 / 決済 module)

**目的:** pure `classifyChange`/`getPendingState`(+`PendingState`)を Stripe I/O 同居 file から pure module へ抽出。

**Files:**
- Create: `lib/stripe/subscription-changes.ts`(`classifyChange`(17-24)+ `getPendingState`(37-48)+ `PendingState`型(31-35)verbatim。`getPendingState` の型のみ `import type Stripe from 'stripe'`。値 import なし)
- Modify: `lib/stripe/subscription.ts`(該当定義削除 → `import { classifyChange, getPendingState, type PendingState } from './subscription-changes'`。I/O 関数群 + error class 2 種温存。`import Stripe from 'stripe'` 値 import は残す=`Stripe.errors` で使用中)
- Modify consumer(import 分割):
  - `app/(app)/app/upgrade/actions.ts:11-20` → `classifyChange,getPendingState` を subscription-changes から / I/O・error は subscription のまま
  - `app/(app)/app/upgrade/page.tsx:2-5` → `getPendingState` を subscription-changes から / `resolveActiveSubscription` は subscription のまま
- Modify(test):
  - `app/(app)/app/upgrade/actions.test.ts` → **意図** = `getPendingState` だけを新 module 側で mock し、`classifyChange` は real 維持。手段 = `subscription-changes` に `vi.mock` を新設して `getPendingState: mockGetPendingState`(`classifyChange` は importOriginal で real)、既存 `vi.mock('@/lib/stripe/subscription')` から `getPendingState` override を除去(I/O mock は残す)。**正確な Vitest 構文(importOriginal spread 形)は実装時に既存 mock style に合わせて確定**(Codex 論点: mock 例の脆さ回避)。assertion import(85-88)に `getPendingState` があれば subscription-changes へ
  - `lib/stripe/subscription.test.ts:46-55` → `classifyChange,getPendingState` の import を `'./subscription-changes'` に分割(`describe('classifyChange'/'getPendingState')` block は温存)

**制約:** 決済経路の mock 差替は誤ると「実装は同じでも test が別物を検証」に陥る(Codex リスク)。mock の real/override 境界を明示し actions.test.ts 全 case green を厳格確認。`getPendingState` の `import type Stripe from 'stripe'` が**値 import でない**ことを確認(pure 判定)。error class(`NoSubscriptionError`/`AmbiguousSubscriptionError`)は subscription.ts に残す(I/O が throw)。

**完了条件:** subscription.test.ts / actions.test.ts / page 型 green。**`pnpm build` exit 0**(決済 module の carve-out = server-only 混入リスク最大。抜いた先 `subscription-changes.ts` が Stripe **server** module を引く経路を残さないこと。build が最後の砦)。canonical + Codex review(決済ゆえ慎重)。+ Global 共通完了条件。

---

### Task 5: `card-filter-predicates` を `lib/cards/` へ移動(B — 逆依存解消 + lint 機構実証)

**目的:** 完全 pure な `card-filter-predicates.ts` を app→lib へ移し、唯一の lib→app allowlisted 逆依存を消滅させ、P0 lint allowlist を初削除する。

**Files:**
- Move: `app/(app)/app/exams/[id]/_lib/card-filter-predicates.ts` → `lib/cards/card-filter-predicates.ts`(`git mv`)+ co-located test `card-filter-predicates.test.ts` も同ディレクトリへ `git mv`(import を `'./card-filter-predicates'` 維持)
- Modify importer(全て `@/lib/cards/card-filter-predicates` へ):
  - `lib/cards/get-custom-session-cards.ts:15-23`(lib→lib 化)
  - `app/(app)/app/study/custom/_components/custom-filter-form.tsx:21`
  - `_components/exam-card-table-condition-bar.tsx:14-15` / `exam-card-table-columns.tsx:31` / `exam-card-table-columns.test.tsx:24` / `exam-card-table-filter-editors.tsx:24-25`
  - `_lib/card-filter-labels.ts:5` / `_lib/column-pinning.test.ts`(相対 `./card-filter-predicates` → `@/lib/cards/card-filter-predicates`)
- Modify: `eslint.config.mjs` — `files: ['lib/cards/get-custom-session-cards.ts']` の allowlist block(79-82 付近)を**削除**
- Modify: `tests/lint/import-boundary.test.ts:103-109` — 当該 it を「get-custom-session-cards.ts が `@/app` import を持たない = restricted message 0(逆依存消滅)」旨に更新。**assert は「当該 exception/@app import 不在」を検証する形にし、allowlist 件数(「N 件」)をハードコードしない**(P2 以降の allowlist 増減で偽陽性 fail するため・OT 指示)

**制約:**
- **`card-filter-labels.ts` は移動しない**(lib からの import 元なし=逆依存を持たない。YAGNI)。app→lib import に変えるのみ。
- 移動後に `rg "card-filter-predicates"` で**旧 path(`_lib/card-filter-predicates` / 相対 `../_lib/...`)の残存ゼロ**を acceptance にする(Codex 論点: 網羅保証)。
- allowlist 削除後に whole-repo `pnpm lint --max-warnings=0` が **green** = 逆依存消滅の機能実証(判断2 条件)。赤なら移動漏れ→停止して原因 fix。lint は境界を完全表現しないため `rg` 目視も併用。

**完了条件:** lint green かつ **get-custom-session-cards.ts の当該 allowlist exception が消滅**(件数固定でなく「当該 exception 不在」を条件にする=Codex 論点)。`card-filter-predicates.test.ts`/`get-custom-session-cards.test.ts`/`exam-card-table-columns.test.tsx` green。import-boundary.test.ts green。**`pnpm build` exit 0**(app→lib move で import 経路変化・リスク task)。+ Global 共通完了条件。

---

### Task 6: `CustomSessionCriteria` 型 relocate(A3 — 型 edge・Task 5 依存)

**目的:** pure `seed-from-criteria.ts` が Dexie 結合 module から型を引く edge を解消。**Task 5 完了後**に実施(predicate 型が lib/cards に在る前提)。

**Files:**
- Create: `lib/cards/custom-session-criteria.ts`(type-only。`CustomSessionCriteria`型(`get-custom-session-cards.ts:32-42`)を移設。依存型(`TagFilterValue`/`AnswerStateFilter`/`StreakFilterValue`)は `@/lib/cards/card-filter-predicates` から **`import type`** で引く(predicates は runtime logic を持つため必ず type-only import・Codex 論点))
- Modify: `lib/cards/get-custom-session-cards.ts`(型定義削除 → `import type { CustomSessionCriteria } from './custom-session-criteria'`)
- Modify importer(全て `@/lib/cards/custom-session-criteria` へ):
  - `lib/cards/seed-from-criteria.ts:5`(← これで pure seed の infra 型依存が切れる = 本 task の核心)
  - `lib/cards/seed-from-criteria.test.ts` / `get-custom-session-cards.test.ts` / `app/(app)/app/study/custom/_components/custom-session-flow.tsx` / `custom-filter-form.tsx`

**制約:** 型のみ・runtime erase ゆえ trivially behavior-preserving。**scope 判断**: 新 file 1 個追加が見合わない/リスクと判断したら本 task を defer し OT に一行報告(spec §4.1 A3 の defer 許容)。defer 時も他 task に影響なし。

**完了条件:** typecheck green + 全 test green。`seed-from-criteria.ts` が `get-custom-session-cards`(Dexie 結合)を import しないこと確認。+ Global 共通完了条件。

---

### Task 7: V5 filter 代数 confirm-only(コード変更なし)

**目的:** spec §4.4 の格下げ根拠を記録。3 重コピーが無いことを確認するだけ。

**Files:** なし(確認 + 報告のみ)

**制約:** `card-filter-predicates`(述語)/ `card-filter-labels`(ラベル)が単一 source で、`condition-bar`→`filter-editors` が協働 import であることを grep で確認。残留 inline op list があれば列挙して report に記す(統合はしない)。

**完了条件:** 何を grep/確認し何をもって「三重コピーなし」と判断したかの**証跡**を Task 8 の docs 更新に記録(Codex 論点: confirm-only も証跡必須)。コード変更ゼロ。

---

### Task 8: 最終 gate + SSoT 完了記録(docs)

**目的:** phase 完了の whole-repo gate を通し、SSoT 進捗表に P1 完了 + HEAD SHA + 再スキャン結果を記録する(Codex 論点: SSoT 更新を task flow に組込・漏れ防止)。

**Files:**
- Modify: `docs/plans/2026-07-06-ddd-refactor-design-decisions.md`(P1 行: 状態→完了 / 完了時 HEAD SHA / 再スキャン記録欄に Task1-7 結果 + Task7 の V5 confirm 証跡 + Task3 の DB fn 未カバー残リスク / 変更履歴 1 行)

**制約:**
- P1 実装中の SSoT 状態遷移(spec 起草中→実装中)は該当 task の commit と**同 commit**で行う(SSoT 運用注記)。本 Task 8 は最終「完了」記録のみを担う。
- code refactor commit と docs status commit を混ぜず、本 docs 更新は独立 commit(`docs(plans): P1 完了・SSoT 更新 [no-review]`・Codex 論点: review 粒度保全)。

**完了条件:** whole-repo `pnpm lint --max-warnings=0` / `pnpm typecheck` / `pnpm test`(contract 含む)全 exit 0 を最終確認し報告に「whole-repo lint exit 0 確認済」明記。SSoT P1 = 完了 + SHA 記録。docs commit 済。

---

## Self-Review(spec 突合)

- **Spec coverage:** carve-out A1=Task3 / A2=Task4 / 型 A3=Task6 / 逆依存 B=Task5 / dedup C1=Task2・C2=Task1 / V5 格下げ=Task7 / latent 不純=非目標(§8.1・触らない)。全 spec work item に task 対応あり。
- **Placeholder scan:** module 名・行範囲・import 分割点は全て確定値。TBD なし。「本体 verbatim」は移設操作の明示(placeholder でない)。
- **Type consistency:** `compareTagEntry`(Task1)/ `computeStreak`,`addDays`(Task2)/ `STALE_PROCESSING_MS`,`deriveExamStatuses`(Task3)/ `classifyChange`,`getPendingState`,`PendingState`(Task4)/ `CustomSessionCriteria`(Task6)の名称は全 task で一貫。
- **依存順序:** Task6 のみ Task5 依存。Task8 は全 task 後(最終 gate + SSoT 完了記録)。Task1-5 は任意順、subagent-driven で逐次。
- **SSoT/gate:** 状態遷移(実装中)は各 commit 同梱、完了 + HEAD SHA は Task8 で確定(Codex 論点反映)。

## Codex plan cross-check(plan 確定前・CLAUDE.md「plan 段階の Codex 協調」)

`scripts/ai/codex-plan-review.sh` を **OT の plan 確定前**に 1 回実行。入力 = spec + grounding を主、本 plan ドラフトは参考添付(anchor 防止)。取りまとめ(CC/Codex どちらの論点か明示)て OT へ提示 → OT 承認で plan 確定。
