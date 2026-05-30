# 増分 pull Step 4「pull ガード + トリガー拡張」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** step 3 で稼働した増分 pull (`pullDelta`) に、1 タブ内 in-flight guard + 多タブ Web Locks の二重防御を被せ (`runGuardedPull`)、pull-trigger を mount のみから mount + visibilitychange(visible) + online へ拡張する。

**Architecture:** `lib/sync/pull.ts` に `runGuardedPull` を新設。module-scope の in-flight boolean (実行中の重複 kick を skip = exam-status-live 型) を最外に置き、その内側を Web Locks (`recallmint:pull`、`ifAvailable:true` skip、非対応は lock なし fallback = review-flush の `runGuardedFlush` と同型) で囲み `pullDelta` を実行する。`pull-trigger.tsx` は review-flush-trigger と同型の listener (visibilitychange/online) を登録し、各トリガーで `runGuardedPull` + `pullAllStudyDays` を kick、unmount で listener 解除。`pullDelta` 本体は不変。

**Tech Stack:** Web Locks API (`navigator.locks`), Dexie, React (`useEffect` listener), Vitest + fake-indexeddb + DI mock (locks / pull)。

**位置づけ (spec 整合):** 確定 spec §3.4 (トリガー拡張) / §3.5 (in-flight guard + Web Locks)。§8-2 の読込側未充足項目「pull in-flight / 多タブ Web Locks / フォーカス・再接続トリガー」を埋める。**ガードの効果は「正しさ」でなく「多タブ無駄打ち削減 + cursor read→write 競合の回避」** (正しさは server 冪等 + inclusive cursor + bulkPut/bulkDelete 冪等で既に担保。step 3 smoke で実証済)。

---

## 全体制約 (各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。
- **二重防御の役割分担**: **1 タブ内 = in-flight guard** (module-scope boolean、同 JS context の並走 kick を skip) / **多タブ間 = Web Locks** (`ifAvailable:true`、leader 1 タブのみ実行)。実行順は **in-flight (最外・per-tab cheap) → Web Locks (cross-tab) → pullDelta**。in-flight が先なので同タブ内 2 回目は lock を試さず即 skip (lock churn 回避)。
- **in-flight は skip-if-running (rerun coalesce しない)**: `exam-status-live.tsx:54-93` の `inFlight` boolean 型。pull は retry timer を持たず、並走 kick (二重 mount / 同時トリガー) は同じデータを取りに行くため**捨てて 1 本に絞る**のが正しい (push controller の `running`+`rerunRequested` rerun 型は採らない。spec §3.5 が両候補を提示、軽量側を選択 → **U1**)。
- **Web Locks fallback**: `navigator.locks` 不在時は lock なしで直 `pullDelta` (review-flush の `resolveLocks`→undefined→直実行と同型)。多重は server 冪等 + cursor 冪等で吸収。
- **`ifAvailable:true` skip で UX 問題なし**: leader が IDB に書けば他タブは `useLiveQuery` のクロスタブ購読で追従 (step 3 で実証)。
- **`pullDelta` 本体は不変** (step 3 の失敗時不変性・1 tx・cursor 据え置きを壊さない)。`runGuardedPull` は wrapper。
- **観測性**: in-flight skip / lock-busy 時に `logger.info` (reason + lockName) を出す (stg smoke の多タブ観測 + 本番観測に使う)。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。読み込み側ガードで削除/決済/外部副作用 category 非該当 → 通常 review。step 1-3 運用に合わせ **review pass → `[no-review]` commit → UI stg smoke → `[reviewed]` amend**。
- test 実行: `pnpm test <path>`。

---

## File Structure

| 変更 file | 責務 |
|---|---|
| Modify `lib/sync/pull.ts` | `runGuardedPull` 追加 (in-flight boolean + Web Locks wrapper)。`PULL_LOCK_NAME` / 局所 `MinimalLockManager` / `resolveLocks` を**複製** (review-flush.ts を re-touch しない、過度な抽象化回避 → **U2**)。`pullDelta` は不変 |
| Modify `lib/sync/pull.test.ts` | `runGuardedPull` の unit (in-flight coalesce / lock granted / ifAvailable skip / fallback)。`review-flush.test.ts:73` の `fakeLocks(grant)` を手本に DI |
| Modify `app/(app)/app/_components/pull-trigger.tsx` | mount のみ → mount + visibilitychange(visible) + online。各 kick で `runGuardedPull` + `pullAllStudyDays`、unmount で listener 解除 |
| Modify `app/(app)/app/_components/pull-trigger.test.tsx` | visibility/online kick・unmount listener 解除を検証 (現 mount-only test を拡張) |

**型 (Task 1-2 で一貫)**: `PULL_LOCK_NAME = 'recallmint:pull'` / `type PullGuardOutcome = 'ran' | 'inflight-skip' | 'lock-busy'` / `runGuardedPull(deps?: { reason?: string; pull?: () => Promise<PullDeltaResult>; locks?: MinimalLockManager | undefined }): Promise<PullGuardOutcome>`。

---

## Task 1: `runGuardedPull` (in-flight guard + Web Locks)

**Files:** Modify `lib/sync/pull.ts` / Test `lib/sync/pull.test.ts`

**目的**: `pullDelta` を「1 タブ内 in-flight skip」+「多タブ Web Locks (ifAvailable skip)」で囲む。**制約**: `pullDelta` 不変、in-flight 最外、fallback 直実行、skip 時 logger.info。**完了条件**: 下記 test green + 既存 pull.test.ts(step 3) 不変通過 + review。

**実装の骨子** (実コードは TDD で生成):
- `import { logger } from '@/lib/logger'`。`export const PULL_LOCK_NAME = 'recallmint:pull'`。
- 局所複製: `type MinimalLockManager = { request: (name, options: {ifAvailable?: boolean}, cb: (lock: unknown) => Promise<PullGuardOutcome>) => Promise<PullGuardOutcome> }` + `function resolveLocks(deps): MinimalLockManager | undefined`（`'locks' in deps ? deps.locks : (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks as ... : undefined)`、review-flush.ts:78-87 と同形）。
- module-scope `let pullInFlight = false`。
- 構造:
  ```ts
  export async function runGuardedPull(deps: { reason?: string; pull?: () => Promise<PullDeltaResult>; locks?: MinimalLockManager | undefined } = {}): Promise<PullGuardOutcome> {
    if (pullInFlight) { logger.info({ event: 'pull.inflight_skip', reason: deps.reason }); return 'inflight-skip' }
    pullInFlight = true
    try {
      const pull = deps.pull ?? (() => pullDelta())
      const locks = resolveLocks(deps)
      if (!locks) { await pull(); return 'ran' }            // 非対応 fallback
      return await locks.request(PULL_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) { logger.info({ event: 'pull.lock_busy', lockName: PULL_LOCK_NAME, reason: deps.reason }); return 'lock-busy' }
        await pull(); return 'ran'
      })
    } finally { pullInFlight = false }
  }
  ```

- [ ] **Step 1: 失敗 test 群** (`review-flush.test.ts:73` の `fakeLocks(grant)` を手本に、`pull` も DI mock で注入):
  1. **lock granted → ran**: `fakeLocks(true)` + `pull` mock → outcome `'ran'`、`request` が `(PULL_LOCK_NAME, {ifAvailable:true}, cb)` で呼ばれ、pull mock 1 回。
  2. **ifAvailable skip (lock busy) → 'lock-busy' かつ pull 未実行**: `fakeLocks(false)` → outcome `'lock-busy'`、pull mock 0 回。
  3. **fallback (locks: undefined)** → lock なしで pull 実行、outcome `'ran'`、pull mock 1 回。
  4. **in-flight coalesce**: `pull` mock を手動 resolve できる deferred にし、`runGuardedPull` を await せず 2 連続呼出 → 1 本目 `'ran'`(pull 1 回)、2 本目 `'inflight-skip'`(pull 追加呼出なし)。1 本目 resolve 後は `pullInFlight=false` に戻り再度呼べる。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/sync/pull.test.ts -t "runGuardedPull"` → FAIL (未実装)。
- [ ] **Step 3: 実装** — 上記骨子を `pull.ts` に追加。
- [ ] **Step 4: green** — `pnpm test lib/sync/pull.test.ts` 全 PASS (step 3 の pullDelta test も維持)。`pnpm exec tsc --noEmit` エラーなし。
- [ ] **Step 5: commit** — `feat(sync): pull に in-flight guard + 多タブ Web Locks (runGuardedPull) を追加` + `[no-review]`。

---

## Task 2: pull-trigger のトリガー拡張 (mount + visibilitychange + online)

**Files:** Modify `app/(app)/app/_components/pull-trigger.tsx` / Test `app/(app)/app/_components/pull-trigger.test.tsx`

**目的**: focus 復帰 / 再接続でも mirror を更新。**制約**: 各トリガーで `runGuardedPull` (raw pullDelta でなく) + `pullAllStudyDays` を kick、unmount で listener 解除。失敗 silent 維持。study_days は同トリガーに相乗り (unguarded、idempotent full-replace、cursor race なし → **U3**)。**完了条件**: test green + review。

**実装の骨子**:
```ts
import { runGuardedPull } from '@/lib/sync/pull'
// ...
useEffect(() => {
  const kick = (reason: string) => {
    void runGuardedPull({ reason }).catch(() => {})
    void pullAllStudyDays().catch(() => {})
  }
  kick('mount')
  const onVis = () => { if (document.visibilityState === 'visible') kick('visibilitychange') }
  const onOnline = () => kick('online')
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('online', onOnline)
  }
}, [])
```
冒頭コメントを mount/visibility/online トリガー + guard 経由に更新。

- [ ] **Step 1: 失敗 test** — `pull-trigger.test.tsx` の mock を `@/lib/sync/pull` の `runGuardedPull` に変更 (pullDelta mock → runGuardedPull mock)。検証: (a) mount で `runGuardedPull` + `pullAllStudyDays` 各 1 回。(b) `visibilityState='visible'` で `document.dispatchEvent(new Event('visibilitychange'))` → 両者が追加 kick。(c) `window.dispatchEvent(new Event('online'))` → 両者 kick。(d) unmount (`cleanup()`) 後に両イベント発火 → **追加 kick されない** (listener 解除確認)。visibilityState は `Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true})` で制御。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/_components/pull-trigger.test.tsx"` → FAIL。
- [ ] **Step 3: 実装** — 上記骨子。
- [ ] **Step 4: green** — 同 test PASS。`pnpm exec tsc --noEmit` エラーなし。
- [ ] **Step 5: commit** — `feat(sync): pull-trigger を mount + visibilitychange + online トリガーに拡張` + `[no-review]`。

---

## この step 単体の stg smoke (UI 経由)

認証済 staging ブラウザ + DevTools (Network `/api/pull`・Console `pull.lock_busy`/`pull.inflight_skip` ログ・IDB sync_meta) で検証。

1. **多タブ Web Locks**: chrome-devtools MCP の `new_page` で staging を 2 タブ開き、ほぼ同時に両方 reload → 一方の `/api/pull` が走り、他方は Console に `pull.lock_busy` (ifAvailable skip)。両タブの IDB `sync_meta` cursor が一致 (cursor 破損なし)。leader の書込が他タブの `useLiveQuery` (dueCount 等) に追従。
2. **visibilitychange**: タブを別タブへ切替→戻す (または最小化→復帰) → 戻った瞬間 `/api/pull` 発火 (Network)。
3. **online**: DevTools で offline→online を切替 → online 復帰で `/api/pull` 発火。
4. **二重 mount coalesce**: 本番ビルドは StrictMode 二重 mount なし (= 主に unit 検証)。stg では「visibilitychange を高速連打」して `/api/pull` が重複連発せず in-flight skip で間引かれる (Console `pull.inflight_skip`) ことを観測。
5. **回帰**: 通常 reload で従来どおり pullDelta が 1 本走り mirror 更新 / study_days 並走 (step 3 挙動不変)。

全観点 PASS で 2 commit を `[reviewed]` へ amend (step 1-3 同手順 filter-branch)。FAIL は amend せず報告で停止。

---

## Self-Review (spec 整合)

- §3.5 (in-flight guard + Web Locks、push 側流用、pull lock 名、ifAvailable skip、非対応 fallback、in-flight↔lock 役割分担) → Task 1。§3.4 (mount + visibilitychange + online、review-flush-trigger 同型、unmount 解除) → Task 2。§8-2 (pull in-flight / 多タブ Web Locks / フォーカス・再接続トリガー) → Task 1+2。
- placeholder なし。型整合: `PULL_LOCK_NAME` / `PullGuardOutcome` / `runGuardedPull` を Task 1-2 で一貫使用。

---

## 実装前に確認・判断が要る点 (実コード再確認で判明)

- **U1 (in-flight pattern 選択・確定)**: spec §3.5 は「`running`+`rerunRequested` coalesce か `exam-status-live` 型 inFlight boolean のいずれか」を提示。**軽量な skip-if-running (rerun しない)** を採用。理由: pull は retry timer を持たず、並走 kick (二重 mount / 同時トリガー) は同データ取得なので捨てて 1 本に絞るのが正しい (push の rerun 型は retry timer 取りこぼし防止用で pull に不要)。spec 範囲内の選択で食い違いではない。
- **U2 (lock util 複製 vs 抽出・要 OT 認識)**: `MinimalLockManager`/`resolveLocks` は review-flush.ts に既存だが module-local (未 export)。pull へ供給する形は (a) **pull.ts に複製** (~15 行、review-flush.ts を re-touch せず step 4 を自己完結、過度な抽象化回避) / (b) 共通 util `lib/sync/web-locks.ts` 抽出 (review-flush.ts も改修 = reviewed file 再 touch + churn)。**本 plan は (a) 複製で記述** (3 つ目の consumer が出たら抽出)。OT が DRY 優先なら (b)。
- **U3 (study_days をトリガー拡張に含めるか・要 OT 判断)**: `pullAllStudyDays` を mount/visibility/online すべてに相乗りさせる (focus/再接続で streak/todayCount も鮮度更新、payload は最大 90 行と小)。study_days は full-replace 冪等で cursor race が無いため **Web Locks/in-flight guard の対象外** (unguarded のまま)。**本 plan は「相乗り (含める)」で記述**。focus 毎の fetch を減らしたいなら mount-only 据え置きも可 — OT 判断 (既定: 含める)。
- **U4 (観測ログ)**: in-flight skip / lock-busy で `logger.info` を出す (stg smoke の多タブ観測 + 本番観測)。pull 失敗自体は従来どおり silent。軽微。
- spec との食い違い: なし (U1 は spec 提示候補からの選択、U2 は実装手段の確定)。
