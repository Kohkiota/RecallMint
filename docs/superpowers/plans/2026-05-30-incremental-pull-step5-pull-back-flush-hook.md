# 増分 pull Step 5「pull-back 配線 (flush 成功フック)」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 復習 push (review-events flush) が成功した直後に pull-back (cards/exams/tombstone 増分 pull + study_days full-window 再取得) を kick し、サーバーで FSRS 再計算された値 (due/stability/last_review/updated_at) を mirror に戻す (§8-2 ⑤ の解決)。

**Architecture:** flush 成功確定点に pull-back を相乗りさせる。push レスポンスは `{ok, failed}` のみで値を返さないため、push 完了 → pull-back の順で mirror を更新する。pull-back は step 4 の `runGuardedPull` (in-flight guard + 多タブ Web Locks) + `pullAllStudyDays` をそのまま再利用し、新規 `pull-back.ts` helper に束ねる。フックは **2 箇所**: (A) `createReviewFlushController` の `outcome === 'ok'` (背景回復 flush 用) と (B) `session-runner.tsx` の session 完了 flush (通常復習フロー用) ── 後者が必要な理由は下記 **§実コード食い違い**。

**Tech Stack:** React (`useEffect`), Dexie, Web Locks (step 4 `runGuardedPull` 経由), Vitest + jsdom + fake-indexeddb + DI mock。

**位置づけ (spec 整合):** 確定 spec `docs/superpowers/specs/2026-05-29-incremental-pull-design.md` §3.3 (pull-back 配線) / §6 step 5。§8-2 ⑤「FSRS 再計算値が mirror に戻らない」を埋め、step 1-4 と合わせ §8-2 読込側 7 項目を充足する。**ガードの効果は「無駄な二重 pull の抑制」**であり、正しさ (再 pull の冪等性) は step 2-3 で担保済。

---

## ⚠ 実コードと spec 前提の食い違い (実装前に確認、要 OT 認識)

spec §3.3 / §5 は pull-back hook を **`createReviewFlushController` の `outcome === 'ok'` のみ**に置くと記述。しかし実コードの flush 経路は **2 系統**:

| 経路 | 呼出点 | controller 経由か |
|---|---|---|
| 背景回復 flush | `review-flush-trigger.tsx` → `controller.kick(mount/visibility/online)` | **Yes** (onFlushed が効く) |
| session 内 flush | `session-runner.tsx:286` `flushPendingEvents` (5件閾値) / `:307` `flushAllPendingEvents` (session 完了) | **No** (直叩き) |

**問題**: 通常の復習完了では session-runner (`:307`) が **先に queue を drain** するため、後続の controller.kick は `no-pending` を返し `onFlushed` が発火しない。= **controller hook だけでは通常フローで FSRS 値が戻らない** (controller hook は「session を中断して離脱 → 後で背景回復 flush が拾う」safety-net 経路でのみ発火)。

**本 plan の解決**: hook を **2 箇所**に置く ── (A) controller `onFlushed` (safety-net / 中断セッション回復)、(B) session 完了 flush `:307` の成功点 (通常フロー)。両者とも `runGuardedPull` の in-flight guard で coalesce され二重 `/api/pull` にならない。**5件閾値 flush (`:286`) は hook しない** (理由: §Task 4)。

→ **U5 (要 OT 判断)**: 本 plan は「(A)+(B) 両 hook」で記述。spec §3.3 の文言を超える追加 (B) を含むが、§3.3 の意図「flush 成功確定点に pull-back を相乗り」と goal「即反映」を満たすために必須。OT が controller-only (spec 文言厳守) を選ぶ場合は Task 4 を drop (ただし通常フローで pull-back が走らない旨を許容することになる)。

---

## 全体制約 (各タスク共通、冒頭一度のみ)

- **TDD**: 失敗 test 先行 → fail 確認 → 最小実装 → green → review → commit。test 実行 `pnpm test <path>`、型は `pnpm exec tsc --noEmit`。
- **失敗時は pull-back しない**: flush が `'ok'` (= 全件 synced) のときのみ pull-back。`'no-pending'`/`'transient'`/`'rate-limited'`/`'permanent'`/`'lock-busy'` では kick しない (サーバー未更新 or 未確定のため)。成功判定は既存 `classifyFlushResults` (`review-flush.ts:52`) を流用。
- **二重 pull 防止は step 4 の in-flight guard に委ねる**: 複数 hook が近接発火しても `runGuardedPull` の module-scope `pullInFlight` が `/api/pull` を 1 本に絞る (`pull.inflight_skip`)。study_days (`pullAllStudyDays`) は unguarded だが idempotent full-replace・payload 小 (step 4 U3 と同方針) のため複数発火許容。
- **pull-back は fire-and-forget**: `void ...catch(()=>{})`。flush ループ / session UI を block しない。pull-back 失敗は silent (次トリガで回復)。
- **step 4 資産の再利用**: `runGuardedPull({reason})` (`lib/sync/pull.ts`) / `pullAllStudyDays()` (`lib/sync/study-days.ts`) はそのまま。改修しない。
- **review/commit 規律**: feat は `superpowers:requesting-code-review` 必須経路。pull-back は外部副作用 (再 pull = GET、副作用なし) だが、復習 push 経路への配線のため **CLAUDE.md「重要 Fix の裏取り」= 外部副作用に該当しうる**。step 1-4 運用に合わせ **review pass → `[no-review]` commit → UI stg smoke → `[reviewed]` amend**。

---

## File Structure

| 変更 file | 責務 |
|---|---|
| Create `lib/sync/pull-back.ts` | `pullBack(reason)` = `runGuardedPull({reason})` + `pullAllStudyDays()` を fire-and-forget で並走 kick する単一 helper (Task 2)。複数 hook 点から再利用 |
| Create `lib/sync/pull-back.test.ts` | `pullBack` の unit (両 helper を呼ぶ / reason 伝播 / reject 握り潰し) |
| Modify `lib/sync/review-flush.ts` | `ControllerDeps` に `onFlushed?: () => void` 追加、kick ループの `outcome === 'ok'` で発火 (Task 1)。`pullDelta`/`runGuardedFlush` 不変 |
| Modify `lib/sync/review-flush.test.ts` | `onFlushed` の unit (ok で発火 / 非 ok で不発 / transient→ok retry で発火) |
| Modify `app/(app)/app/_components/review-flush-trigger.tsx` | `createReviewFlushController({ onFlushed: () => pullBack('flush') })` 配線 (Task 3) |
| Modify `app/(app)/app/_components/review-flush-trigger.test.tsx` | onFlushed 経由で `pullBack` が呼ばれることを verify |
| Modify `app/(app)/app/study/smart/_components/session-runner.tsx` | session 完了 flush (`:307`) 成功時に `pullBack('session-complete')` (Task 4) |
| Modify `app/(app)/app/study/smart/_components/session-runner.test.tsx` | 完了 flush ok → pull-back / flush 失敗 → pull-back なし |

**型・シグネチャ (Task 1-4 で一貫)**:
- `ControllerDeps` に追加: `onFlushed?: () => void` (既定 no-op)。
- `export function pullBack(reason: string): void` (`lib/sync/pull-back.ts`)。
- 再利用 (不変): `runGuardedPull(deps?: { reason?: string; ... }): Promise<PullGuardOutcome>` / `pullAllStudyDays(client?): Promise<PullResult>` / `classifyFlushResults(results: FlushResult[]): FlushOutcome`。
- reason 文字列: `'flush'` (controller onFlushed) / `'session-complete'` (session 完了)。観測性のため区別。

---

## Task 1: controller `onFlushed` フック (`outcome === 'ok'`)

**Files:** Modify `lib/sync/review-flush.ts` / Test `lib/sync/review-flush.test.ts`

**目的**: flush controller の成功確定点に副作用フックを 1 つ足し、背景回復 flush 成功時に pull-back を起動できるようにする。**制約**: `outcome === 'ok'` のみ発火 (他 outcome は不発)。`runGuardedFlush`/retry/coalesce ロジックは不変。`onFlushed` は同期 fire-and-forget で flush ループを block しない。**完了条件**: 下記 test green + 既存 controller test 不変通過 + tsc。

**実装の骨子**:
- `ControllerDeps` (`review-flush.ts:127`) に `onFlushed?: () => void` を追加。
- controller 生成時に `const onFlushed = deps.onFlushed ?? (() => {})` を他 deps と同形で解決。
- kick ループ (`review-flush.ts:204` 付近) の `const outcome = await runGuarded()` + `log(...)` の直後に `if (outcome === 'ok') onFlushed()` を挿入 (transient/その他分岐より前、ok 確定点)。なぜ ok のみか 1 行コメント。

- [ ] **Step 1: 失敗 test 群** (`createReviewFlushController` test、`runGuarded` mock で outcome 制御、`onFlushed: vi.fn()` を inject):
  1. **ok → onFlushed 1 回**: `runGuarded` が `'ok'` → `onFlushed` 1 回。
  2. **no-pending → 不発**: `'no-pending'` → `onFlushed` 0 回。
  3. **transient → ok の retry で発火**: outcomes `['transient','ok']` + fake timer → backoff 後の 2 回目 ok で `onFlushed` 1 回 (1 回目 transient では 0 回)。
  4. **lock-busy / rate-limited / permanent → 不発**: 各々 `onFlushed` 0 回。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/sync/review-flush.test.ts -t "onFlushed"` → FAIL。
- [ ] **Step 3: 実装** — 骨子を適用。
- [ ] **Step 4: green** — `pnpm test lib/sync/review-flush.test.ts` 全 PASS (既存 controller/backoff/coalesce test 維持) + `pnpm exec tsc --noEmit`。
- [ ] **Step 5: commit** — `feat(sync): review-flush controller に flush 成功フック onFlushed を追加` + `[no-review]`。

---

## Task 2: `pullBack` helper

**Files:** Create `lib/sync/pull-back.ts` / Test `lib/sync/pull-back.test.ts`

**目的**: pull-back の中身 (cards 増分 pull + study_days full-window) を 1 関数に束ね、複数 hook 点から再利用する。**制約**: step 4 の `runGuardedPull`/`pullAllStudyDays` をそのまま使う。fire-and-forget・各々独立 catch (一方の失敗が他方を止めない)。新規ライブラリ導入なし。**完了条件**: 下記 test green + tsc。

**実装の骨子**:
```ts
import { runGuardedPull } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'

// flush 成功直後に呼ぶ pull-back。 cards/exams/tombstone は runGuardedPull の増分 pull で
// FSRS 後の値を引き戻し、 study_days は full-window 再取得を相乗り (step 4 U3 と同方針)。
// in-flight guard / Web Locks は runGuardedPull 側が担うため二重 pull にならない。
export function pullBack(reason: string): void {
  void runGuardedPull({ reason }).catch(() => {})
  void pullAllStudyDays().catch(() => {})
}
```

- [ ] **Step 1: 失敗 test** (`@/lib/sync/pull` の `runGuardedPull` と `@/lib/sync/study-days` の `pullAllStudyDays` を vi.mock):
  1. **両 helper を呼ぶ**: `pullBack('x')` → `runGuardedPull` が `{reason:'x'}` で 1 回、`pullAllStudyDays` が 1 回。
  2. **reject 握り潰し**: 両 mock を reject させても `pullBack` は throw しない (microtask 経過後も例外なし)。
- [ ] **Step 2: red** — `pnpm exec vitest run lib/sync/pull-back.test.ts` → FAIL (未実装)。
- [ ] **Step 3: 実装** — 上記骨子で `pull-back.ts` 作成。
- [ ] **Step 4: green** — 同 test PASS + tsc。
- [ ] **Step 5: commit** — `feat(sync): pull-back helper (runGuardedPull + study_days 相乗り) を追加` + `[no-review]`。

---

## Task 3: review-flush-trigger で onFlushed → pull-back を配線

**Files:** Modify `review-flush-trigger.tsx` / Test `review-flush-trigger.test.tsx`

**目的**: 背景回復 flush (mount/visibility/online → controller) の成功時に pull-back を走らせる (中断セッションの safety-net)。**制約**: `createReviewFlushController` への deps 追加のみ。既存の mount/visibility/online/stop 配線は不変。**完了条件**: 下記 test green + tsc。

**実装の骨子**: `createReviewFlushController()` → `createReviewFlushController({ onFlushed: () => pullBack('flush') })`。`import { pullBack } from '@/lib/sync/pull-back'`。冒頭コメントに「flush 成功時 pull-back 相乗り」を追記。

- [ ] **Step 1: 失敗 test** — 既存 `review-flush-trigger.test.tsx` は `createReviewFlushController` を mock 済 (`mockCreateController`)。`@/lib/sync/pull-back` の `pullBack` も vi.mock。検証: render 後 `mockCreateController` が **`onFlushed` を含む deps** で呼ばれ、その `onFlushed()` を実行すると `pullBack('flush')` が呼ばれる (`mockCreateController.mock.calls[0][0].onFlushed()` を test 内で起動して assert)。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/_components/review-flush-trigger.test.tsx"` → FAIL。
- [ ] **Step 3: 実装** — 骨子を適用。
- [ ] **Step 4: green** — 同 test PASS (既存 mount/visibility/online/unmount test 維持) + tsc。
- [ ] **Step 5: commit** — `feat(sync): review-flush-trigger で flush 成功時に pull-back を配線` + `[no-review]`。

---

## Task 4: session-runner の session 完了 flush で pull-back を配線

**Files:** Modify `session-runner.tsx` / Test `session-runner.test.tsx`

**目的**: 通常の復習完了フロー (session 完了 → `flushAllPendingEvents`) の成功時に pull-back を走らせ、dashboard に戻った瞬間 FSRS 後の値が反映されるようにする (**§食い違いの主解決**)。**制約**: `:307` の完了 flush 成功時のみ pull-back。flush 失敗時は不発。`completeStudySession` → flush の順序・fire-and-forget・silent 失敗は不変。**5件閾値 flush (`:286`) は hook しない** (理由: 復習中の中間 flush で pull-back すると mid-session 網羅 pull が増えるが、当該 session 表示は `get-dexie-session-cards` の mount-once snapshot で mid-session 反映不要。dashboard 即反映は session 完了で足り、study_days の無駄打ちを避ける)。**完了条件**: 下記 test green + 既存 session-runner test 不変通過 + tsc。

**実装の骨子** (`:300-309` の finished useEffect):
```ts
try {
  const results = await flushAllPendingEvents()
  if (classifyFlushResults(results) === 'ok') pullBack('session-complete')
} catch {}
```
`import { classifyFlushResults } from '@/lib/sync/review-flush'` / `import { pullBack } from '@/lib/sync/pull-back'`。`completeStudySession` の try/catch は据え置き、flush の try 内に classify+pull-back を追加。

- [ ] **Step 1: 失敗 test** — 既存 `session-runner.test.tsx` は `flushAllPendingEvents` を mock 済 (`mockFlushAllPendingEvents`)。`@/lib/sync/pull-back` の `pullBack` と `@/lib/sync/review-flush` の `classifyFlushResults` を vi.mock。検証:
  1. **完了 flush ok → pull-back**: `phase='finished'` 到達 + `flushAllPendingEvents` が synced 結果 + `classifyFlushResults`→`'ok'` mock → `pullBack` が `'session-complete'` で 1 回。
  2. **完了 flush 非 ok → pull-back なし**: `classifyFlushResults`→`'transient'` (or 失敗結果) → `pullBack` 0 回。
  3. **flush throw → pull-back なし** (catch 内で握り潰され pull-back 未到達)。
- [ ] **Step 2: red** — `pnpm exec vitest run "app/(app)/app/study/smart/_components/session-runner.test.tsx" -t "pull-back"` → FAIL。
- [ ] **Step 3: 実装** — 骨子を適用。
- [ ] **Step 4: green** — 同 test 全 PASS (既存の session/flush/rating test 維持) + tsc。
- [ ] **Step 5: commit** — `feat(sync): session-runner で復習完了 flush 成功時に pull-back を配線` + `[no-review]`。

---

## この step 単体の stg smoke (UI 経由)

認証済 staging + DevTools (Network reqid 順序・Console `pull.*`・IDB `cards`/`sync_meta`)。**課金 API 非依存** (FSRS 再計算は bulk push、Gemini 不使用) のため Claude Code が DevTools MCP で実行可。

1. **通常フロー pull-back (主観点)**: スマート復習で数問回答 → セッション完了。Network で **bulk POST (`/api/review-events/bulk`) → 自動 `/api/pull?since_cards=..` (pull-back) → `/api/study-days/pull`** の順を確認。IDB `cards` で回答した card の `due`/`stability`/`last_review`/`updated_at` が FSRS 後値に更新、`sync_meta.cards_cursor` が前進。dashboard に戻ると `dueCount` / 今日の復習数 / streak が **再 mount せず** live 更新 (`useLiveQuery`)。
2. **二重 pull 防止**: pull-back と他トリガー (mount/visibility) が近接した場合、Console に `pull.inflight_skip` が出て `/api/pull` は 1 本に絞られる。study_days は複数可 (unguarded)。
3. **失敗時不発**: offline 状態でセッション完了 → bulk flush 失敗 → pull-back が走らない (Network に pull-back `/api/pull` が出ない)。online 復帰の背景回復 flush 成功時に pull-back が走る (controller hook 経路)。
4. **回帰**: step 4 の mount/visibility/online トリガー・in-flight skip が不変。

全観点 PASS で 4 commit を `[reviewed]` へ amend (step 1-4 同手順 filter-branch)。FAIL は amend せず報告で停止。

---

## Self-Review (spec 整合)

- §3.3 (flush 成功確定点フック / cards+study_days 両 pull-back / push レスポンス改修なし / in-flight+Web Locks 経由 / useLiveQuery live 反映) → Task 1-4。`ControllerDeps` への `onFlushed` 追加・`outcome==='ok'` 発火・`review-flush-trigger` 配線は §3.3 / §5 接続点表 (`review-flush.ts:213`/`:127`/`review-flush-trigger.tsx:25`) と一致。
- §8-2 ⑤ (FSRS 再計算値が mirror に戻らない) → 本 step で充足。step 1-4 と合わせ §8-2 読込側 7 項目 (フォーカス/再接続・push 後 pull-back・cursor・増分 pull・tombstone・in-flight・多タブ排他) 完了。残 step 6 (exams Dexie UI) / 7 (旧 endpoint 掃除) は本 sync 完了基準外。
- placeholder なし。型整合: `onFlushed` / `pullBack(reason)` / `classifyFlushResults` / `runGuardedPull` / `pullAllStudyDays` を Task 1-4 で一貫使用。
- **食い違い対応**: spec が controller-only と読める点を session-runner hook (Task 4) で補完 (§⚠ 参照、U5)。

---

## 実装前に確認・判断が要る点

- **U5 (hook 範囲・要 OT 判断)**: §⚠ の通り、controller-only (spec 文言) では通常復習フローで pull-back が発火しない (session-runner が queue を先に drain)。**本 plan は (A) controller onFlushed + (B) session 完了 flush の 2 hook**で記述。OT が spec 文言厳守なら Task 4 を drop (通常フロー未充足を許容)。既定: 両 hook 採用。
- **U6 (5件閾値 flush hook、軽微)**: `:286` は hook しない (Task 4 理由参照)。長セッションでの mid-session study_days 無駄打ち回避。OT が「全 flush 成功で pull-back」を望むなら追加可。
- **U7 (pull-trigger 重複、軽微)**: `pull-trigger.tsx` は step 4 で `runGuardedPull`+`pullAllStudyDays` を inline 済。`pullBack` helper に統一すると DRY だが step-4 reviewed file の再 touch + 再 review が必要なため**本 plan では統一しない** (2 行の重複許容、将来掃除)。OT が統一を望めば別 task 化。
- spec との食い違い: U5 のみ (controller-only 前提 vs 実 2 経路)。他は spec 範囲内。
