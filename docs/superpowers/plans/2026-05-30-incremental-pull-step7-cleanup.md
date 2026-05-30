# 増分 pull Step 7「後片付け(旧 endpoint 廃止 + study-days now 削除 + 重複/冗長掃除)」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 増分 pull 化(step 1-6)で rollback 用に残していた旧 full-snapshot endpoint と、それに伴って dead 化した DB 入口 / cursor を撤去し、増分 pull 化を完了させる。新機能なし・純粋な dead code 掃除と冗長排除。

**Architecture:** client は step 3 で統合 `/api/pull` に移行済(旧 `/api/cards/pull`・`/api/exams/pull` を叩く参照は grep ゼロ・確認済)。旧 route を削除すると、その唯一の非 test caller だった `getAllCardsForUser` / `getAllExamsForUser` が dead 化するので同時撤去。`study-days/pull` の `now` は dead-write(client が `lastStudyDayPullAt` へ書くが読み手ゼロ・確認済)なので、response→client write→cursor 定数まで連鎖撤去。delta 関数・mapper・lock util は生存のため温存。

**Tech Stack:** Next.js route handlers, Drizzle(server DB 入口), Dexie sync helper, Vitest。新規ライブラリなし。削除と小 refactor のみ。

**位置づけ (spec 整合):** 確定 spec `docs/superpowers/specs/2026-05-29-incremental-pull-design.md` §6 step 7 / §7-B / §7-E。本 step 完了で増分 pull 化 step 1-7 が完結する。

---

## 着手前の前提補正(plan 調査で判明、OT 判断要)

実コード grep で **task brief / spec の 2 前提が実態とズレ**ていた。Task 1 はこの補正前提で組む:

1. **`getAllExamsForUser` は dead(task brief の「upload page が使うので残す」は誤り)。** upload page (`app/(app)/app/upload/page.tsx:89`) が使うのは `getActiveExamsForUser`(`lib/exams/list.ts:23`)で、**別関数**。`getAllExamsForUser`(`lib/db/exams-pull.ts:27`)の非 test caller は旧 `/api/exams/pull` のみ → 旧 route 削除で dead。`getAllCardsForUser`(`lib/db/cards-pull.ts:23`)も同様に旧 `/api/cards/pull` が唯一 caller → dead。**両方撤去**する。
2. **`study-days/pull` の `now` dead-write は確認済。** `lib/sync/study-days.ts:77` が `sync_meta.lastStudyDayPullAt` へ `now` を書くが、`lastStudyDayPullAt` の **read site は repo 全体でゼロ**(write + test のみ)。spec §7-E の「読まれていない dead-write」を実コードで確定。よって削除は無害。

---

## 全体制約(各タスク共通、冒頭一度のみ)

- **削除の完了条件**(TDD 代替):`pnpm test` 全 green(削除した対象の test は同時削除、残る test は回帰なし)+ `pnpm build` 成功 + `pnpm exec tsc --noEmit` で dangling import ゼロ。各 Task は削除前に「参照ゼロ」を grep で再確認してから消す。
- **refactor は実装ロジック不変**:study-days の `now` 撤去は「dead-write を消すだけ」で mirror 反映挙動(studyDays 配列の clear+bulkPut)は不変。test で挙動不変を担保。
- **温存するもの(消さない)**:`getCardsDelta` / `getExamsDelta` / `toClientCard` / `toClientExam` / `maxIso`(統合 `/api/pull` が使用)、`study-days/pull` 本体と `getAllStudyDaysForUser`(study_days は据え置き)、lock util(B 参照)。
- **review/commit 規律**:本 step は外部 endpoint 削除 + client sync logic 変更を含むため、step 1-6 と同じく `superpowers:requesting-code-review` 必須経路を通す。CLAUDE.md「重要 Fix の裏取り」=**削除 / 外部副作用**に該当 → **review pass → `[no-review]` commit → stg smoke → `[reviewed]` amend**。
- **過渡期 404 の整理(段階廃止しない根拠を plan に明記)**:deploy 後、cache に残った旧 client が削除済 `/api/cards/pull`・`/api/exams/pull` を叩くと 404 になりうる。だが**ユーザー0**のため実害なし(hard reload で新 client が `/api/pull` を叩く)。410/308 等の段階廃止は導入せず**即削除**でよい。

---

## File Structure

| 変更 | file | 責務 |
|---|---|---|
| Delete | `app/api/cards/pull/route.ts` + `route.test.ts` | 旧 cards full-snapshot endpoint(client 移行済) |
| Delete | `app/api/exams/pull/route.ts` + `route.test.ts` | 旧 exams full-snapshot endpoint(client 移行済) |
| Modify | `lib/db/cards-pull.ts` | dead `getAllCardsForUser` 撤去(`getCardsDelta`/re-export は温存)。header コメントの旧 route 記述を更新 |
| Modify | `lib/db/exams-pull.ts` | dead `getAllExamsForUser` 撤去(`getExamsDelta`/`toClientExam` 温存)。header コメント更新 |
| Modify | `lib/db/cards-pull.test.ts` / `exams-pull.test.ts` | `getAll*ForUser` 対象 test があれば削除(delta/mapper test は温存)※存在は実装時 grep |
| Modify | `app/api/study-days/pull/route.ts` | response から `now` フィールド削除(`{ studyDays }` のみ返す) |
| Modify | `lib/sync/study-days.ts` | body 型の `now?`、`typeof now !== 'string'` 検証、`sync_meta` write を撤去。tx scope から `db.sync_meta` を外す |
| Modify | `lib/sync/sync-meta.ts` | dead 化した `lastStudyDayPullAt` key を `SYNC_META_KEYS` から撤去 |
| Modify | `lib/sync/study-days.test.ts` / `sync-meta.test.ts` / `study-days/pull/route.test.ts` | `now` / `lastStudyDayPullAt` を参照する assertion を撤去・更新 |

---

## Task 1: 旧 endpoint 廃止 + dead DB 入口撤去(本来スコープ A-1 / A-2)

**Files:** Delete `app/api/cards/pull/`(route+test)/ `app/api/exams/pull/`(route+test)。Modify `lib/db/cards-pull.ts` / `lib/db/exams-pull.ts`(+ 各 `.test.ts`)。

**目的:** rollback 用に残していた旧 full-snapshot endpoint を削除し、それで dead 化する DB 入口を撤去する。**制約:** Clerk `WHERE user_id` 強制点は `getCardsDelta`/`getExamsDelta` 側に存続(削除は dead 関数のみ)。delta 関数・mapper・`maxIso` は温存(統合 `/api/pull` が使用)。**完了条件:** 下記参照ゼロ確認 + `pnpm test` green + `pnpm build` + `tsc --noEmit` で dangling import ゼロ + Critical 0 + `[reviewed]`。

- [ ] **Step 1: 参照ゼロ再確認(削除前ガード)**
  Run: `grep -rn "/api/cards/pull\|/api/exams/pull" --include=*.ts --include=*.tsx app lib | grep -iv "test\|^.*//"`(コメント除く実 fetch がゼロを確認)、`grep -rn "getAllCardsForUser\|getAllExamsForUser" app lib --include=*.ts | grep -v ".test.ts"`(残り caller が当該 route のみを確認)。
  Expected: client fetch ゼロ / caller は削除対象 route のみ。
- [ ] **Step 2: 旧 route 4 ファイル削除**
  `app/api/cards/pull/route.ts` `route.test.ts` / `app/api/exams/pull/route.ts` `route.test.ts` を削除。
- [ ] **Step 3: dead DB 入口撤去**
  `lib/db/cards-pull.ts` の `getAllCardsForUser`(現 23-27 行)を削除。`lib/db/exams-pull.ts` の `getAllExamsForUser`(現 27-31 行)を削除。両 file の header コメント(旧 `/api/cards|exams/pull route が利用する`)を「統合 `/api/pull` の delta 入口」へ更新。`cards-pull.ts:21` の `export { toClientCard, toCard }` re-export は、`@/lib/db/cards-pull` から import している外部参照を grep し**ゼロなら同時撤去 / 残れば温存**。
- [ ] **Step 4: 対象 test 整理**
  `cards-pull.test.ts` / `exams-pull.test.ts` に `getAll*ForUser` を対象とする test があれば削除(`getCardsDelta`/`getExamsDelta`/`toClientCard`/`toClientExam`/`toCard` の test は温存)。
- [ ] **Step 5: 回帰確認**
  Run: `pnpm test`(全 green、削除 test は消えている)/ `pnpm build` / `pnpm exec tsc --noEmit`。
  Expected: PASS、dangling import ゼロ。
- [ ] **Step 6: review → commit**
  `superpowers:requesting-code-review` 必須経路 → review pass → `[no-review]` commit(下記 commit 1)。

---

## Task 2: study-days/pull の `now` dead-write 撤去 + dead cursor 削除(本来スコープ A-3 / E-b)

**Files:** Modify `app/api/study-days/pull/route.ts` / `lib/sync/study-days.ts` / `lib/sync/sync-meta.ts`(+ 各 `.test.ts`)。

**目的:** cursor として読まれていない `now`(dead-write)を server response → client write → cursor 定数まで連鎖撤去し、study-days pull の役割を「90 日 full-window snapshot replace」のみへ明確化。**制約:** studyDays mirror の clear+bulkPut 挙動は不変(`now` 撤去で壊さない)。study_days 据え置き方針(増分化しない)を維持。**完了条件:** test で「`now` なし response でも studyDays が正しく mirror される」を担保 + `pnpm test` green + `tsc --noEmit` + Critical 0 + `[reviewed]`。

- [ ] **Step 1: client 側 test を先に更新(失敗化)**
  `lib/sync/study-days.test.ts`:`now` を含まない response でも `{ ok: true, count }` を返し studyDays が bulkPut される、を期待に変更。`lastStudyDayPullAt` への write を確認していた assertion(現 41/98/109/125 行付近)を削除。`sync-meta.test.ts`:`lastStudyDayPullAt` 定数 assertion(現 13-14 行)を削除。
  Run: `pnpm test lib/sync/study-days.test.ts`(現実装は `now` 必須のため新期待で FAIL することを確認)。
- [ ] **Step 2: client 実装から `now` 撤去**
  `lib/sync/study-days.ts`:`PullApiClient` / `defaultClient` の body 型から `now?: string` を削除、分割代入を `const { studyDays } = response.body` に、検証を `if (!Array.isArray(studyDays))` に、`sync_meta.put({ lastStudyDayPullAt, ... })` を削除、tx scope を `db.transaction('rw', db.study_days, ...)` へ(`db.sync_meta` を外す)。
- [ ] **Step 3: dead cursor 定数撤去**
  `lib/sync/sync-meta.ts`:`SYNC_META_KEYS.lastStudyDayPullAt`(現 14 行)を削除。
- [ ] **Step 4: server response から `now` 撤去**
  `app/api/study-days/pull/route.ts`:`{ studyDays: [], now: ... }`(現 35 行)と `{ studyDays, now: ... }`(現 43 行)を `{ studyDays: [] }` / `{ studyDays }` に。`study-days/pull/route.test.ts` が `now` を assert していれば更新。
- [ ] **Step 5: 回帰確認**
  Run: `pnpm test` / `pnpm build` / `pnpm exec tsc --noEmit`。Expected: PASS。
- [ ] **Step 6: review → commit**
  `requesting-code-review` 必須経路 → review pass → `[no-review]` commit(下記 commit 2)。

---

## B. 重複/冗長候補の棚卸し(やる / 見送る / OT 判断)

増分 pull 化(step 1-6)で生じた重複・冗長を増分 pull 周辺に限定して棚卸しした結果:

| 候補 | 実体 | 評価 | 判定 |
|---|---|---|---|
| **B1. lock util 複製** | `MinimalLockManager` 型 + `resolveLocks` が `lib/sync/review-flush.ts:72-96` と `lib/sync/pull.ts:161-183` に重複(構造同一、callback の戻り型のみ `FlushOutcome` vs `PullGuardOutcome`)。`runGuardedFlush`/`runGuardedPull` 本体は pull が in-flight flag を持ち**非対称**(共通化不可)。 | 価値=2 file の ~25 行重複解消。リスク=`[reviewed]` 済 2 file の再 touch + generic 型(`MinimalLockManager<T>` / `resolveLocks<D>`)導入で抽象度↑。pull.ts:159 に **U2「共通 util 抽出はしない、複製で可」採択**が明記、第 3 consumer 未出。 | **見送り(OT 判断に回す)**。spec §3.5 / memory「3 つ目の consumer 未出の抽象化は急がない」に整合。OT が「やる」判断なら別 commit(下記 commit 3-任意)。 |
| **B2. step 3 撤去残骸 `pullAllCards`/`pullAllExams`** | repo 全体で**定義ゼロ**(step 3 で既に撤去済、残骸なし)。 | — | **対応不要**。 |
| **B3. 旧 route を指す stale コメント** | `cards-pull.ts:3` / `exams-pull.ts:3`(「`/api/cards|exams/pull` route が利用する」)。削除後に虚偽化。 | 価値=低(doc 整合)。リスク=ほぼ無(Task 1 で同 file を触る)。 | **やる**(Task 1 Step 3 に内包、header コメント更新として実施)。 |
| **B4. `toCard`/`toClientCard` re-export(`cards-pull.ts:21`)** | `toCard` は `get-dexie-session-cards.ts:20` が `cards-mapper` から**直接** import(re-export 非経由)。`@/lib/db/cards-pull` 経由の外部 import 有無は未確定。 | 価値=低。リスク=低(1 行)。 | **Task 1 Step 3 で grep し dead なら撤去 / 生存なら温存**(条件付きやる)。 |

**OT 判断に回す論点は B1 のみ**(下記報告)。

---

## Commit 単位素案

- **Commit 1(Task 1)**:`refactor(pull): 旧 /api/cards|exams/pull 廃止 + dead getAll*ForUser 撤去 [no-review]→[reviewed]`
  旧 route 4 file 削除 + dead DB 入口 2 関数撤去 + header コメント更新。実装ロジック(live path)不変。
- **Commit 2(Task 2)**:`refactor(sync): study-days/pull の now dead-write 撤去 + lastStudyDayPullAt cursor 削除 [no-review]→[reviewed]`
  server response + client write + cursor 定数の連鎖撤去。mirror 挙動不変。
- **Commit 3(任意・OT 承認時のみ)**:`refactor(sync): pull/flush lock util を共通化(B1)` — 既定は**作らない**。

各 commit: `requesting-code-review` 必須経路 → review pass → `[no-review]` commit → stg smoke → `[reviewed]` amend(削除 / 外部副作用 = 裏取り対象)。

---

## stg smoke 観点(掃除後の回帰確認、DevTools MCP で証跡化)

掃除で挙動が変わっていないことを確認(全観点 = 従来どおり動く):

1. **演習読込**:dashboard / smart-session が cards mirror から従来どおり読める(統合 `/api/pull` 経由、旧 endpoint 不在で 404 を踏まない)。
2. **試験一覧**:`ExamListLive` が exams/cards mirror から従来どおり描画(`/api/pull` delta + tombstone 反映)。
3. **pull-back**:復習 flush 成功後の pull-back が `/api/pull` を 1 本叩き mirror 反映(step 5b 経路不変)。
4. **全トリガー**:mount / visibilitychange / online + 一覧に効く 5 操作の `runGuardedPull` 相乗りが従来どおり `/api/pull` を叩く(旧 endpoint への参照ゼロを Network で確認)。
5. **study-days**:`/api/study-days/pull` が `{ studyDays }`(now なし)を返し、dashboard streak / todayCount が **study_days mirror から壊れず**算出される(`now` 削除で mirror 不破損を実証)。
6. **Network 確認**:旧 `/api/cards/pull`・`/api/exams/pull` への request が**一切発生しない**ことを reqid 一覧で確認。

(課金 API は不使用のため OCR 実走は不要。study-days / pull / 一覧の回帰のみ。)

---

## Self-Review(spec §6 step 7 / §7-B / §7-E 照合)

- **§6 step 7「旧 endpoint 廃止」** → Task 1(route 削除 + dead 入口撤去)。✅
- **§7-B「旧 cards/exams pull は段階移行のうえ最終廃止」** → Task 1 で即削除(過渡期 404 は user 0 で無害、段階廃止しない根拠を全体制約に明記)。✅
- **§7-E「study-days/pull の now 削除、dead-write を実コード確認」** → Task 2(read site ゼロを plan 調査で確定済、連鎖撤去)。✅
- **本 step で step 1-7 完了** → 旧 full-snapshot 経路が消え、増分 `/api/pull` が cards/exams の唯一の pull 経路に。✅
- **B 掃除**:B1=見送り(OT)/ B2=不要 / B3=やる(内包)/ B4=条件付き。新機能ゼロ・churn 最小化を優先。✅
- **placeholder スキャン**:削除タスクのため新規コードなし、各 Step は対象 file:行 と grep/コマンドを明記。✅
