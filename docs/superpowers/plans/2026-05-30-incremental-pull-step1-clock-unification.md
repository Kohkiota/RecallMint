# 増分 pull Step 1「クロック統一」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cursor 比較に乗る 3 箇所の打刻 (card inline 編集 / 復習 bulk push の `updated_at`、tombstone の `deleted_at`) を Node の `new Date()` (App クロック) から SQL `now()` (DB クロック) に統一する。schema は変更しない。

**Architecture:** drizzle の `.set()` / `.values()` に渡す値を `sql\`now()\`` に差し替えるだけの局所変更。FSRS 計算結果 (due/last_review 等、cursor 列でない) は ISO bind のまま据え置く。unit test は getDb を mock するため「渡された SQL 式が `now()` を render すること」までを検証し、実 DB クロックで打たれること・drizzle `$onUpdate` 先勝ち挙動は stg smoke で裏取りする。

**Tech Stack:** Next.js 15 server actions / API route, Drizzle ORM (`sql` template), Postgres, Vitest (mock-only unit)。

**位置づけ (spec 整合):** 確定 spec `docs/superpowers/specs/2026-05-29-incremental-pull-design.md` §2.4 / §6 step 1。本 step は後続 step 2 以降の「ストリーム別 inclusive cursor 比較」が App↔DB クロック skew で取りこぼさない前提を作る。schema・endpoint・client は触らない。

---

## 全体制約 (各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。
- **検証手法 (重要・全タスク共通)**: unit は getDb mock で実 DB を叩かないため、捕捉した `.set()/.values()` の対象列が
  **drizzle `SQL` 式で、render 結果が `now()` を含む**ことを assert する。render は
  `new (await import('drizzle-orm/pg-core')).PgDialect().sqlToQuery(value as SQL).sql` で取得し `toContain('now()')`。
  (現状の `new Date()` / ISO bind は `SQL` でない or param bind になるため fail する = 正しい red。)
- **実 DB クロック挙動・`$onUpdate` 先勝ちは unit で検証不能** → stg smoke (末尾) で裏取りする。
- `sql\`now()\`` は DB 側評価で JS Date を bind しないため Drizzle #5789 (timestamptz serializer) と無関係に安全。
- schema 不変。`toPgTimestamptz` helper は due/last_review 用に残す (削除しない)。
- 命名/型/絶対ルール: server action の owner-scope (`WHERE user_id`) を壊さない。既存制御フロー・revalidate は不変。
- **review/commit 規律**: feat/fix は `superpowers:requesting-code-review` 必須経路。Task 3/4 (削除経路 = tombstone) は
  CLAUDE.md「重要 Fix の裏取り」対象 → review pass → tag 無し commit → OT 実機確認 → `--amend` で `[reviewed]`。
  Task 1/2 は review pass で `[reviewed]` 可 (OT 判断で stg smoke を先行させてもよい)。
- test 実行: `pnpm test <path>` (= `vitest run`)。単体名指定は `pnpm exec vitest run <path> -t "<name>"`。

---

## File Structure (変更対象)

| 変更 file | 責務 | test file |
|---|---|---|
| `app/(app)/app/exams/[id]/_actions/update-card-field.ts` | (a) inline 編集 1 列 UPDATE。`sql` import 追加 + `.set` に `updatedAt: sql\`now()\`` | 同 dir `update-card-field.test.ts` (`dbState.setArg` 捕捉) |
| `app/api/review-events/bulk/route.ts` | (b) 復習 bulk の cards VALUES UPDATE。SET 句の `updatedAt` のみ `sql\`now()\`` 化 | `route.test.ts` (`state.bulkUpdateCapture.set` 捕捉) |
| `app/(app)/app/exams/[id]/_actions/delete-card.ts` | (c1) card tombstone INSERT。`deletedAt: sql\`now()\`` (`sql` import 済) | `delete-card.test.ts` |
| `app/(app)/app/exams/_actions/delete-exam.ts` | (c2) exam+配下 card tombstone 網羅 INSERT。`sql` import 追加 + `const now` を `sql\`now()\`` に | `delete-exam.test.ts` (`insertedTombstoneRows` 捕捉) |

---

## Task 1: (a) card inline 編集 `updated_at` → now()

**Files:** Modify `app/(app)/app/exams/[id]/_actions/update-card-field.ts` (import 行 `:3`, `.set` 行 `:144`) / Test `update-card-field.test.ts`

**目的**: inline 編集が `updated_at` を DB クロックで打つ。**制約**: `built.data` の各列はそのまま、`updatedAt` のみ追加。
`.set` に明示指定することで schema の `$onUpdate(()=>new Date())` より優先される (Drizzle: 明示列は onUpdate 不発火 — DB 挙動は stg smoke で確認)。**完了条件**: 下記 test green + 既存 case 全通過 + review。

- [ ] **Step 1: 失敗 test を追加** — 任意 field (例 `title`) 更新時、`dbState.setArg.updatedAt` が `SQL` 式で
  render が `now()` を含むことを assert (PgDialect render、共通手法)。既存 `setArg` には現状 `updatedAt` が無いので red。
- [ ] **Step 2: red 確認** — `pnpm exec vitest run "app/(app)/app/exams/[id]/_actions/update-card-field.test.ts" -t "now"` → FAIL (`updatedAt` undefined / SQL でない)。
- [ ] **Step 3: 最小実装** — import に `sql` を追加 (`import { and, eq, sql } from 'drizzle-orm'`)、`.set(built.data)` を
  `.set({ ...built.data, updatedAt: sql\`now()\` })` に変更。
- [ ] **Step 4: green 確認** — 同 test + ファイル全体 `pnpm test "…/update-card-field.test.ts"` → PASS。
- [ ] **Step 5: review → commit** — `requesting-code-review` 経路。`fix(exams): inline 編集の updated_at を now() 化` + `[reviewed]`。

---

## Task 2: (b) 復習 bulk push `updated_at` → now()

**Files:** Modify `app/api/review-events/bulk/route.ts` (`:333` SET 句の `updatedAt`) / Test `route.test.ts`

**目的**: bulk push が cards.updated_at を DB クロックで打つ。**制約**: VALUES UPDATE の **SET 句内の `updatedAt` のみ**変更。
VALUES 句 (`v(id, due, …)`) は `updated_at` を含まないため不変。FSRS 値 (`v.due`/`v.last_review` = ISO bind) は据え置き。
`toPgTimestamptz`/`new Date()` の他用途は残す。**完了条件**: 下記 test green + 既存 bulk test 全通過 + review。

- [ ] **Step 1: 失敗 test を追加** — bulk POST 成功 path で `state.bulkUpdateCapture.set.updatedAt` を取り、render が
  `now()` を含むことを assert (共通手法)。現状は `$N::timestamptz` (Date param bind) のため red。
- [ ] **Step 2: red 確認** — `pnpm exec vitest run "app/api/review-events/bulk/route.test.ts" -t "now"` → FAIL。
- [ ] **Step 3: 最小実装** — `:333` を `updatedAt: sql\`now()\`,` に変更 (`sql` は import 済)。コメントを「DB クロックで打刻 (cursor 統一、#5789 と無関係)」に更新。
- [ ] **Step 4: green 確認** — `pnpm test "app/api/review-events/bulk/route.test.ts"` → PASS (VALUES decoder / 既存 case に影響なしを確認)。
- [ ] **Step 5: review → commit** — `requesting-code-review` 経路。`fix(study): 復習 bulk push の updated_at を now() 化` + `[reviewed]` (push 経路のため stg smoke 先行を OT 判断で選択可)。

---

## Task 3: (c1) delete-card `deleted_at` → now()

**Files:** Modify `app/(app)/app/exams/[id]/_actions/delete-card.ts` (`:64` tombstone INSERT) / Test `delete-card.test.ts`

**目的**: card 削除 tombstone を DB クロックで打つ。**制約**: `.values({...})` の `deletedAt` のみ。`sql` は import 済。
`.values()` chainable 方式は維持 (`sql\`now()\`` は #5789 を踏まない)。**完了条件**: test green + 既存 idempotent/owner-scope case 全通過 + **裏取り**。

- [ ] **Step 1: 失敗 test を追加/改修** — 削除成功時に捕捉した card tombstone の `deletedAt` が `SQL` 式で render が
  `now()` を含むことを assert。既存に `toBeInstanceOf(Date)` の assert があれば本変更で red 化するので合わせて改修。
- [ ] **Step 2: red 確認** — `pnpm exec vitest run "app/(app)/app/exams/[id]/_actions/delete-card.test.ts" -t "now"` → FAIL。
- [ ] **Step 3: 最小実装** — `deletedAt: new Date()` を `deletedAt: sql\`now()\`` に変更。
- [ ] **Step 4: green 確認** — `pnpm test "…/delete-card.test.ts"` → PASS。
- [ ] **Step 5: review → commit (裏取り)** — review pass → **tag 無し** commit `fix(exams): card 削除 tombstone の deleted_at を now() 化` → OT 実機確認 → `git commit --amend` で `[reviewed]`。

---

## Task 4: (c2) delete-exam `deleted_at` → now() (exam+配下 card 同一 tx now())

**Files:** Modify `app/(app)/app/exams/_actions/delete-exam.ts` (import `:4`, `const now` `:71` 周辺) / Test `delete-exam.test.ts`

**目的**: exam 削除時の網羅 tombstone (exam 1 + card N) を全て同一 DB 時刻で打つ。**制約**: `const now = new Date()` を廃し、
各 tombstoneRow の `deletedAt` を `sql\`now()\`` に。Postgres の `now()` は tx 開始時刻 (transaction_timestamp) で
**同一 tx 内一定** → exam/全 card で同値 (spec の「同一 statement 内 now() 一定」前提と整合)。**完了条件**: test green +
3 行/1 行/idempotent case 全通過 + **裏取り**。

- [ ] **Step 1: 失敗 test を改修** — `insertedTombstoneRows` 各行の `deletedAt` を `toBeInstanceOf(Date)` → 「`SQL` 式で
  render が `now()` を含む」に書き換え (exam 1件 + card 2件 / card なし 1件 の両 case)。
- [ ] **Step 2: red 確認** — `pnpm exec vitest run "app/(app)/app/exams/_actions/delete-exam.test.ts" -t "now"` → FAIL (現状 `new Date()` で Date instance)。
- [ ] **Step 3: 最小実装** — import に `sql` 追加 (`import { and, eq, sql } from 'drizzle-orm'`)、`const now = new Date()` を削除し
  各 row の `deletedAt` を `sql\`now()\`` に変更 (exam 行 + `childCardIds.map` 内の card 行)。
- [ ] **Step 4: green 確認** — `pnpm test "…/delete-exam.test.ts"` → PASS。
- [ ] **Step 5: review → commit (裏取り)** — review pass → **tag 無し** commit `fix(exams): exam 削除 tombstone の deleted_at を now() 化` → OT 実機確認 → `--amend` で `[reviewed]`。

---

## このステップ単体の stg smoke 観点

unit では検証できない「実 DB クロック」「`$onUpdate` 先勝ち」「tx 内 now() 一定」を stg で裏取りする
(DevTools MCP で Network reqid / IDB / DB 値を証跡化)。OT 依頼は不要 (課金 API 非経由、Claude Code 実行可)。

1. **card inline 編集**: 試験詳細で 1 field 編集 → 当該 card の `updated_at` がサーバー時刻 (編集前後のサーバー now 範囲内) に
   更新され、かつ「編集していない他列」は変化なし。`$onUpdate` の旧 App クロックでなく DB クロックであること
   (= DB の `now()` と整合、App 時計とずれていても DB 基準)。
2. **復習 push**: スマート復習で数問回答 → bulk flush 後、対象 cards の `updated_at` が DB クロックに更新。
   FSRS 値 (due/stability/last_review) は従来どおり正しく入る (回帰なし)。
3. **card 削除**: 1 枚削除 → tombstone の `deleted_at` が DB クロック。一覧/件数は従来どおり (機能回帰なし)。
4. **exam 削除**: 配下 card 複数の exam を削除 → exam tombstone と全 card tombstone の `deleted_at` が
   **全件同一値** (同一 tx now())。再削除 idempotent。
5. **回帰**: 4 経路とも既存挙動 (owner-scope / idempotent / revalidate / エラー時 ActionResult) が不変。

---

## Self-Review (spec 整合)

- spec §2.4 の (a)(b)(c) 3 箇所をそれぞれ Task 1/2/(3+4) でカバー。schema 不変・打刻のみ now() 化を厳守。
- spec §6 step 1 の「既存 test を now() 経路へ更新」を各 Task Step 1 で実施。
- 後続 step 2 (統合 /api/pull の inclusive cursor) の前提 = 全 cursor 列が DB クロック、を本 step で成立させる。
- 未確定・placeholder なし。test 戦略 (PgDialect render → `now()` 含有) を共通制約として明示済。

---

## 実装前に確認・判断が要る点 (実コード再確認で判明)

- **U1 (unit の限界、要 OT 認識)**: getDb mock のため unit は「`now()` を render する SQL を渡したこと」までしか保証できない。
  実 DB クロックで打たれること・`$onUpdate` がスキップされること・tx 内 now() 一定は **stg smoke でのみ裏取り**。
  この限界を許容する前提で plan を確定 (代替: 実 DB を使う integration test は本リポの方針 (test では実 DB/実 API 禁止寄り) と
  ずれるため非採用)。
- **U2 (Task 2 のタグ判断)**: 復習 bulk push は「外部副作用」ではない (DB 書込のみ) が push 経路の中核。CLAUDE.md 裏取り
  4 categoryには非該当だが、OT が stg smoke 先行 ([reviewed] を smoke 後) を選ぶ余地あり。既定は通常 review → [reviewed]。
- **U3 (commit 粒度)**: Task 3/4 は同一論理変更 (tombstone clock)。本 plan は file 別 2 commit としたが、OT 希望なら
  1 commit (`fix(exams): tombstone deleted_at を now() 化`) に統合可。
- spec との食い違いは検出されず (spec §2.4 の記述は実コードと一致: (a) `$onUpdate` 発火、(b) SET 句 ISO bind、
  (c) delete-exam の `const now` 使い回し、をいずれも実コードで確認済)。
