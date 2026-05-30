# 増分 pull Step 5b「pull-back 再設計(実送信成功 gate)」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Step 5 stg smoke 観点1 FAIL(pull-back が bulk commit と race し stale 取得)を、**pull-back の発火条件を「実際に events を send して成功した(`syncedEventIds` 非空)」に限定**することで構造的に解消する。skip(in-flight 確保中の空振り)・session-only・失敗では発火させない。

**Architecture:** 弁別子は `FlushResult.syncedEventIds.length > 0`。`syncedEventIds` は `flushPendingEvents` が `await client.post` で 200 を得た**後**にのみ非空になり、bulk route は 200 返却前に tx commit 済(FSRS 値 + `updatedAt=now()`)。よって `syncedEventIds` 非空を gate にすれば pull-back は必ず commit 後に走る。`classifyFlushResults` の `'ok'` を「failed 無し **かつ** 実 sync ≥1 件」に再定義し、'ok'-gate の既存 2 経路(session 完了 / controller onFlushed)を自動是正、threshold flush に hook を追加する。

**Tech Stack:** TypeScript strict, Vitest + jsdom + fake-indexeddb + DI mock。新規ライブラリなし。

**位置づけ:** Step 5 の修正。確定 spec `docs/.../2026-05-29-incremental-pull-design.md` §3.3、再設計方針(所与・OT 確定)、pre-investigation `docs/superpowers/sessions/2026-05-30-incremental-pull-step5-pull-back-redesign-investigation.md`。

---

## 既存 Step 5 commit との関係(R4・確定)

step 5 実装 4 commit(`f178f47` onFlushed / `a1adbf9` pullBack helper / `e2b7004` trigger 配線 / `df1b3e4` session-runner 配線、全 push 済 `origin/develop`・[no-review])は **rewrite せず、本 plan の修正を上に積む(additive)**。理由: push 済履歴の rewrite 回避 + 修正は「`classifyFlushResults` 再定義 + threshold hook 追加」で自然に additive。`df1b3e4` の session 完了 hook(`classifyFlushResults==='ok'`)は再定義で**そのまま正しくなる**ため変更しない。**再 smoke PASS 後に step5 全 feat commit(既存 4 + 本 plan の feat)を filter-branch で [reviewed] 化**(step1-4 同手順、OT force-push)。

---

## 全体制約(各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。test 実行 `pnpm test <path>`、型は `pnpm exec tsc --noEmit`。
- **弁別子**: 「pull-back を発火させてよい」= **実送信成功** = `results.some(r => r.syncedEventIds.length > 0)`。skip(`attempted:0`)/ session-only(events 無し)/ 失敗 / 空(`[]`)では発火しない。
- **`classifyFlushResults` の retry 分類は不変**: 失敗時の rate-limited / transient / permanent ロジック・閾値は一切変えない。変えるのは「failed 無し」分岐のみ('ok' vs 'no-pending' の振り分け)。controller の retry 挙動(`review-flush.ts:212-222`、'ok'/'no-pending' は同じ「retry しない」分岐)は不変。
- **pull-back の二重化は step 4 in-flight guard に委ねる**: 複数経路が近接発火しても `runGuardedPull` が `/api/pull` を 1 本に絞る(`pull.inflight_skip`)。study_days は idempotent full-replace のため複数許容(step4 U3)。
- **pull-back は fire-and-forget**(`pullBack` helper、`void...catch`)。flush ループ / session UI を block しない。失敗 silent。
- **R2(確定)**: skip は `'no-pending'` に畳む(専用 'skipped' outcome は新設しない、最小)。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。復習 push 経路の配線 = 外部副作用該当のため **review pass → `[no-review]` commit → UI 再 smoke → `[reviewed]` amend**。

---

## File Structure

| 変更 file | 責務 |
|---|---|
| Modify `lib/sync/review-flush.ts` | `classifyFlushResults` の `'ok'` 再定義(failed 無し かつ 実 sync ≥1 → 'ok'、さもなくば 'no-pending')。retry 分岐は不変 |
| Modify `lib/sync/review-flush.test.ts` | classify の新仕様 unit(skip→'no-pending' / session-only→'no-pending' / 実 sync→'ok')。既存 ok/transient/rate-limited/permanent/空 は維持 |
| Modify `app/(app)/app/study/smart/_components/session-runner.tsx` | threshold flush(`:287-289`)の戻り値を受け、`classifyFlushResults([r])==='ok'` で `pullBack('threshold-flush')`。session 完了(`:312`)はコード不変 |
| Modify `app/(app)/app/study/smart/_components/session-runner.test.tsx` | threshold flush 実 sync→pull-back / threshold skip→不発 / **race regression**(threshold 実 sync + 完了 skip → 1 回のみ) |
| Modify `docs/.../2026-05-29-incremental-pull-design.md` | §3.3 再修正(R5、doc・[no-review]) |

**型・シグネチャ(不変・再利用)**: `classifyFlushResults(results: FlushResult[]): FlushOutcome`(シグネチャ不変、戻り値の振り分けのみ変更)/ `FlushResult.syncedEventIds: string[]` / `pullBack(reason: string): void` / `flushPendingEvents(sessionId): Promise<FlushResult>` / `flushAllPendingEvents(): Promise<FlushResult[]>`。reason 文字列: `'threshold-flush'`(新)/ `'session-complete'`(既存)/ `'flush'`(既存 controller)。

---

## Task 1: `classifyFlushResults` の `'ok'` を実送信成功に再定義

**Files:** Modify `lib/sync/review-flush.ts` / Test `lib/sync/review-flush.test.ts`

**目的**: skip(`attempted:0`、in-flight 空振り)/ session-only / 空振りを `'ok'` から除外し、`'ok'` を「実際に event を sync した」に限定する。これで 'ok'-gate の既存 2 経路(session 完了・controller onFlushed)が自動的に正される。
**制約**: 失敗分類(rate-limited / transient / permanent)・順序は不変。シグネチャ不変。
**完了条件**: 下記 test green + 既存 classify/controller/onFlushed/runGuardedFlush test 不変通過 + tsc。

**実装の骨子**(`review-flush.ts:52-61` の `if (failures.length === 0) return 'ok'` のみ変更):
```ts
if (failures.length === 0) {
  // 'ok' = 実際に 1 件以上 sync できた場合のみ。 skip(in-flight 空振り)/ session-only
  // (events 無し)は何も sync していない → pull-back 対象外なので 'no-pending' に畳む
  // (controller の retry 挙動は 'ok'/'no-pending' 同分岐のため不変。pull-back gate のみ是正)。
  const syncedAny = results.some((r) => r.syncedEventIds.length > 0)
  return syncedAny ? 'ok' : 'no-pending'
}
```

- [ ] **Step 1: 失敗 test 群**(`describe('classifyFlushResults')` に追加。`fr()` helper 既存):
  1. **skip(`attempted:0`, syncedEventIds 空, failedEventIds 空)→ 'no-pending'**: `classifyFlushResults([fr({ attempted: 0 })])` が `'no-pending'`(現状 'ok' のはず=回帰核心)。
  2. **session-only(syncedEventIds 空 + sessionSynced:true + httpStatus:200, failed 空)→ 'no-pending'**: `fr({ attempted: 0, sessionSynced: true, httpStatus: 200 })` → `'no-pending'`。
  3. **実 sync(syncedEventIds 非空)→ 'ok'**(既存 `fr({ attempted: 2, syncedEventIds: ['a','b'] })` → 'ok' を維持、必要なら明示追加)。
  4. **複数 result の一部 sync → 'ok'**: `[fr({syncedEventIds:['a']}), fr({attempted:0})]` → `'ok'`(1 件でも実 sync があれば)。
  - 既存の '空→no-pending' / 'transient' / 'rate-limited' / 'permanent' は不変通過すること。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/sync/review-flush.test.ts -t "classifyFlushResults"` → 観点1/2 が FAIL(現状 'ok')。
- [ ] **Step 3: 実装** — 上記骨子。
- [ ] **Step 4: green** — `pnpm test lib/sync/review-flush.test.ts` 全 PASS(controller/onFlushed/runGuardedFlush/backoff 含む)。`pnpm exec tsc --noEmit` clean。
- [ ] **Step 5: commit** — `fix(sync): classifyFlushResults の 'ok' を実 sync ≥1 件に限定 (skip/session-only を pull-back 対象外化)` + `[no-review]`。

---

## Task 2: threshold flush に pull-back hook を追加(U6 反転)

**Files:** Modify `session-runner.tsx` / Test `session-runner.test.tsx`

**目的**: daily=5=threshold で実 sync を担うのが threshold flush(`flushPendingEvents`)になるため、その実送信成功時に pull-back を発火させる(= 観点1 FAIL の主因の解消経路)。
**制約**: threshold flush の戻り値を `classifyFlushResults([r])==='ok'`(= 実 sync)で gate。skip/失敗では不発。`recordAnswerEvent` の fire-and-forget・silent 失敗・閾値ロジックは不変。session 完了(`:312`)は**変更しない**(Task 1 で自動是正済)。
**完了条件**: 下記 test green + 既存 session-runner test 不変通過 + tsc。

**実装の骨子**(`session-runner.tsx:287-289`):
```tsx
if (pending >= FLUSH_THRESHOLD) {
  const r = await flushPendingEvents(sessionId)
  // 実 sync(syncedEventIds 非空)のときだけ pull-back: threshold flush が実送信を担う
  // 場合(daily=threshold)に commit 後の FSRS 値を戻す。skip/失敗では発火しない。
  if (classifyFlushResults([r]) === 'ok') pullBack('threshold-flush')
}
```
`classifyFlushResults` / `pullBack` は既に import 済(`:67-68`)。

- [ ] **Step 1: 失敗 test**(`session-runner.test.tsx`、新規 describe 例 `'threshold flush で pull-back'`。`mockFlushPendingEvents` 既存、`mockPullBack` 既存、`classifyFlushResults` は real):
  1. **threshold 実 sync → pull-back('threshold-flush')**: 5 問回答で `pending>=5` を踏ませ、`mockFlushPendingEvents.mockResolvedValue({ attempted:1, syncedEventIds:['e1'], failedEventIds:[], sessionSynced:true, reachable:true, httpStatus:200 })` → `mockPullBack` が `'threshold-flush'` で呼ばれる(`waitFor`)。
  2. **threshold skip(`attempted:0, syncedEventIds:[]`)→ pull-back なし**: `mockFlushPendingEvents.mockResolvedValue({ attempted:0, syncedEventIds:[], failedEventIds:[], sessionSynced:false, reachable:false, httpStatus:0 })` → threshold 経路の `pullBack('threshold-flush')` が呼ばれない。
  3. **race regression(最重要)**: threshold flush 実 sync(`syncedEventIds:['e1']`)+ session 完了 `flushAllPendingEvents` が skip 結果(`[{attempted:0, syncedEventIds:[], failedEventIds:[]}]`)を返す → `pullBack` は **`'threshold-flush'` で 1 回のみ**、`'session-complete'` では呼ばれない(完了経路は Task 1 再定義で 'no-pending' → 不発)。これが smoke FAIL の回帰防止。
  - 既存の「session 完了 flush で pull-back」test(Task 4 由来、`syncedEventIds:['e1']` で 'ok')は不変通過すること。5 問到達駆動は既存 `reachFinished` 等の helper を流用。`FLUSH_THRESHOLD=5` 到達には `mockCountPendingAnswerEvents` の戻り値制御が要る場合があるため既存 test の閾値駆動方法を確認して流用。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/study/smart/_components/session-runner.test.tsx" -t "threshold"` → FAIL。
- [ ] **Step 3: 実装** — 上記骨子。
- [ ] **Step 4: green** — 同 test 全 PASS(既存 session/flush/rating/finished/session-complete-pullback 維持)+ tsc clean。
- [ ] **Step 5: commit** — `fix(sync): threshold flush の実 sync 成功時に pull-back を発火 (race 解消、U6 反転)` + `[no-review]`。

---

## Task 3: spec §3.3 の再修正(R5)

**Files:** Modify `docs/superpowers/specs/2026-05-29-incremental-pull-design.md`

**目的**: §3.3 の前回補正(`7dbbf29`)を再設計に合わせて正す。**実装ロジック変更なし(doc)→ review skip 可、[no-review]**。
**完了条件**: §3.3 に以下を追記反映。
- pull-back の発火条件は「flush が**実際に event を sync した**(`syncedEventIds` 非空)」。`classifyFlushResults` の `'ok'` を実 sync ≥1 件に再定義してこれを表現。
- hook は **3 経路**(threshold flush / session 完了 flush / controller onFlushed)すべてに置き、各々 skip/空振り/失敗では発火しない。
- skip(in-flight 空振り)を `'ok'` と扱った Step 5 初版が観点1 FAIL を招いた点と是正を 1-2 行で併記(pre-investigation / 本 plan へ参照)。

- [ ] **Step 1**: §3.3 の該当補正ブロックを上記趣旨に更新。
- [ ] **Step 2: commit** — `docs(spec): §3.3 pull-back 発火条件を「実 sync 成功」へ再修正 (3 経路 hook + classifyFlushResults 'ok' 再定義)` + `[no-review]`。

---

## この step の stg smoke(再 FAIL 防止・daily=threshold を明示的に踏む)

認証済 staging + DevTools(Network reqid 順序・Console `pull.*`・IDB cards/sync_meta)。課金非依存(FSRS は bulk push)。

1. **通常フロー pull-back(主観点・daily=5=threshold を明示的に踏む)**: スマート復習 5 問(= threshold)回答 → 完了。Network で `POST /api/review-events/bulk` の **commit(200)後**に `/api/pull?since_cards=..` が走り(reqid 順序で bulk→pull を確認)、IDB cards の回答 5 枚が **FSRS 後値(due/stability/last_review/updated_at 前進)**に更新、`cards_cursor` 前進、dashboard dueCount が **減少**(再 mount 不要 live)。**前回 FAIL(cursor 据え置き・stale)が解消していること**を最重要確認。
2. **二重 pull 防止**: pull-back は threshold/完了 経路から発火しうるが、`runGuardedPull` in-flight guard で `/api/pull` は 1 本(Console `pull.inflight_skip` で間引き観測)。study_days 複数可。
3. **skip では不発**: (観点1 が PASS であれば skip 経路は発火していない=暗黙確認)。補助として、4 問で完了する状況が作れる場合は threshold 未到達 → 完了 flush 実 sync → pull-back を確認(任意)。
4. **失敗時不発**: offline 完了 → bulk 失敗 → pull-back の `/api/pull` 出ない。online 復帰の背景回復 flush 実 sync 時に pull-back。
5. **回帰**: step 4 の mount/visibility/online トリガー・in-flight skip 不変。

全観点 PASS で step5 全 feat commit(既存 4 + 本 plan feat 2)を filter-branch で `[reviewed]` 化(R4)。FAIL は amend せず報告で停止。

---

## Self-Review(整合)

- 観点1 FAIL の root cause(skip→'ok' 誤分類で premature pull-back)→ Task 1(classify 再定義)+ Task 2(threshold hook + race regression test)で解消。
- 所与方針「各送信経路の末尾に hook、実送信成功時のみ発火、skip は別物、classifyFlushResults 相当を修正」→ Task 1(成功判定修正)+ Task 2(threshold 末尾 hook)+ 既存 session 完了/controller hook が自動是正、で充足。
- placeholder なし。型整合: `classifyFlushResults`(シグネチャ不変)/ `syncedEventIds` / `pullBack(reason)` を一貫使用。
- 既存 Step 5 commit は additive 修正(R4)。spec 再修正(R5)。

---

## 実装前に確認・判断が要る点(pre-investigation R1-R5 を継承)

- **R1**(確定): `classifyFlushResults` の 'ok' 再定義で対応(別 predicate / `runGuardedFlush` 型変更はしない)。
- **R2**(確定): skip → 'no-pending'(専用 'skipped' は作らない)。
- **R3**(確定): threshold flush に hook 追加(U6 反転)。
- **R4**(確定): 既存 4 commit は additive 修正、再 smoke PASS 後に step5 全 feat を [reviewed] 化。
- **R5**(確定): spec §3.3 再修正(Task 3)。
- 食い違い: なし。
