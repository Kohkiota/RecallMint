// review-events flush の orchestrator: Web Locks による多タブ排他 + transient 失敗時の
// 指数 backoff retry (アプリ起動中のみ動く module-scope timer)。
//
// 設計 (事前調査 docs/superpowers/sessions/2026-05-29-review-events-retry-weblocks-inventory.md):
// - flush の最外を Web Locks で囲む。 lock 名は演習 flush 用の単一固定キー。
//   入れ子順 = lock 取得 → (flushPendingEvents 内の) in-flight guard 追加 → bulk POST →
//   in-flight 解放 → lock 解放 (後入れ先出し)。 in-flight guard は flushPendingEvents が
//   既に持つため、 ここでは lock を最外に被せるだけ。
// - lock 取得失敗 (他タブ保持中) は flush せず即 return (queue で待たない)。 server 側
//   event_id UNIQUE + ON CONFLICT 冪等性により、 待たず諦めても二重適用にならない。
// - retry timer は controller の closure scope に持つ (React state ではないので
//   再 render で消えない)。 controller は (app) layout に mount される
//   ReviewFlushTrigger が保持し、 layout は内部 navigation では unmount しない
//   (PullTrigger と同じ持続性) ため、 タブを開いている間 (= /app/* に居る間) 生存する。
//   /app/* を離れる / タブを閉じると unmount → stop() で timer 解除、 pending は Dexie に
//   残置され次回 (app) mount の trigger で回復される (component-scope の useState timer
//   だと再 render でも消えてしまうのを避けるのが closure 採用の理由)。
// - 429 は即停止 (CLAUDE.md ルール 5)。 transient (5xx / network) のみ有限 backoff retry。
//   分類は lib/retry/transient-error の共有 util を HTTP status に適用して行う。
//
// 全て event_id UNIQUE + ON CONFLICT の既存冪等性の上に乗る加算的変更で、 問題 2/3 の
// pattern (in-flight guard / bulk SQL / serializeDbError / RETURNING 照合) を壊さない。

import { flushAllPendingEvents, type FlushResult } from './review-events'
import {
  isRateLimitError,
  isTransientError,
  computeBackoffMs,
} from '@/lib/retry/transient-error'
import { logger } from '@/lib/logger'

// 演習 flush 用の単一固定 lock 名 (origin 内全タブ共有)。
export const FLUSH_LOCK_NAME = 'recallmint:review-events:flush'

export type FlushOutcome =
  | 'ok' // 全件 synced
  | 'no-pending' // 送るものなし
  | 'transient' // 5xx / network → backoff retry 対象
  | 'rate-limited' // 429 → 即停止
  | 'permanent' // 通常 4xx → 自動 retry しない
  | 'lock-busy' // 他タブが flush 中 → skip

// HTTP status を共有 classifier (message string match) に渡すための signal 文字列。
// status=0 は network 断 (fetch throw) を意味するため "fetch failed" に正規化して
// isTransientError にマッチさせる。
function statusToSignal(status: number): string {
  return status === 0 ? 'fetch failed' : String(status)
}

// flushAllPendingEvents の結果配列を 1 つの outcome に畳む。
// 失敗が 1 つでも 429 を含めば rate-limited を優先 (即停止、 ルール 5)。
export function classifyFlushResults(results: FlushResult[]): FlushOutcome {
  if (results.length === 0) return 'no-pending'
  const failures = results.filter((r) => r.failedEventIds.length > 0)
  if (failures.length === 0) return 'ok'

  const signals = failures.map((r) => statusToSignal(r.httpStatus))
  if (signals.some(isRateLimitError)) return 'rate-limited'
  if (signals.some(isTransientError)) return 'transient'
  return 'permanent'
}

// Web Locks の最小型 (lib.dom の LockManager から本 module が使う部分のみ)。
type MinimalLockManager = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<FlushOutcome>,
  ) => Promise<FlushOutcome>
}

export type GuardedFlushDeps = {
  flushAll?: () => Promise<FlushResult[]>
  // 'locks' を明示指定すると navigator を見ない (undefined 指定で非対応 path を test 可能)。
  locks?: MinimalLockManager | undefined
}

function resolveLocks(
  deps: GuardedFlushDeps,
): MinimalLockManager | undefined {
  if ('locks' in deps) return deps.locks
  // defensive: navigator.locks の存在チェックのみ (対象環境 iOS 16.4+ は全対応)。
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks as unknown as MinimalLockManager
  }
  return undefined
}

// flush の最外を Web Locks で囲んで実行する。 lock 取得失敗時は flush せず lock-busy。
export async function runGuardedFlush(
  deps: GuardedFlushDeps = {},
): Promise<FlushOutcome> {
  const flushAll = deps.flushAll ?? (() => flushAllPendingEvents())
  const locks = resolveLocks(deps)

  if (!locks) {
    // Web Locks 非対応 (defensive): lock なしで直接 flush。 多重は server UNIQUE で吸収。
    const results = await flushAll()
    return classifyFlushResults(results)
  }

  return locks.request(FLUSH_LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      // 他タブが保持中 → flush せず即 return (queue で待たない)。
      logger.info({ event: 'review_events.flush.lock_busy', lockName: FLUSH_LOCK_NAME })
      return 'lock-busy'
    }
    const results = await flushAll()
    return classifyFlushResults(results)
  })
}

// retry 既定値 (roadmap §5.1): 5 回、 10s → 30s → 1min → 5min → 15min + jitter。
const DEFAULT_BACKOFF_BASE_MS = [10_000, 30_000, 60_000, 300_000, 900_000] as const
const DEFAULT_BACKOFF_JITTER_MAX_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const

export type ReviewFlushController = {
  // trigger (mount / visibilitychange / online / retry) から呼ぶ。 実行中は no-op。
  kick: (reason: string) => Promise<void>
  // 予約済 retry timer を解除し attempt を 0 に戻す (unmount / 明示停止用)。
  stop: () => void
}

// timer handle は node (Timeout) / browser (number) で型が異なるため alias で吸収。
type TimerHandle = ReturnType<typeof setTimeout>

export type ControllerDeps = {
  runGuarded?: () => Promise<FlushOutcome>
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle
  clearTimeoutFn?: (handle: TimerHandle) => void
  backoffBaseMs?: readonly number[]
  backoffJitterMaxMs?: readonly number[]
  maxRetries?: number
  rng?: () => number
  log?: (event: string, extra?: Record<string, unknown>) => void
  // flush 成功 (outcome==='ok') 時の副作用フック (pull-back 起動用)。
  // 同期 fire-and-forget で呼ぶ (中身は呼び元が非同期にする)。throw は kick 側で
  // 握り潰すため flush retry ループを壊さないが、呼び元も例外を漏らさない実装が望ましい。
  onFlushed?: () => void
}

export function createReviewFlushController(
  deps: ControllerDeps = {},
): ReviewFlushController {
  const runGuarded = deps.runGuarded ?? (() => runGuardedFlush())
  const setT =
    deps.setTimeoutFn ??
    ((cb: () => void, ms: number): TimerHandle => setTimeout(cb, ms))
  const clearT =
    deps.clearTimeoutFn ?? ((handle: TimerHandle): void => clearTimeout(handle))
  const base = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const jitter = deps.backoffJitterMaxMs ?? DEFAULT_BACKOFF_JITTER_MAX_MS
  const maxRetries = deps.maxRetries ?? DEFAULT_BACKOFF_BASE_MS.length
  const rng = deps.rng ?? Math.random
  const log =
    deps.log ??
    ((event: string, extra?: Record<string, unknown>) =>
      // extra を先に展開し event で必ず上書き (extra に event キーが来ても潰さない)。
      logger.info({ ...extra, event }))
  const onFlushed = deps.onFlushed ?? (() => {})

  let attempt = 0
  let timer: TimerHandle | null = null
  let running = false
  // 実行中に来た kick (外部 trigger / 発火した retry timer) を取りこぼさないための
  // coalesce flag。 並走はさせず (server / lock は冪等だが無駄打ちを避ける)、 現在の
  // flush 完了後に最大 1 回だけ rerun する。 これがないと「retry timer が別 kick の
  // 実行中に発火 → no-op で drop → backoff chain 断絶」 が起きうる (review fix)。
  let rerunRequested = false

  function clearTimer(): void {
    if (timer !== null) {
      clearT(timer)
      timer = null
    }
  }

  function scheduleRetry(): void {
    if (attempt >= maxRetries) {
      log('review_events.flush.retry_exhausted', { attempts: attempt })
      attempt = 0
      return
    }
    const delayMs = computeBackoffMs(attempt, base, jitter, rng)
    log('review_events.flush.retry_scheduled', {
      attempt,
      delayMs: Math.round(delayMs),
    })
    attempt += 1
    clearTimer()
    timer = setT(() => {
      timer = null
      void kick('retry')
    }, delayMs)
  }

  async function kick(reason: string): Promise<void> {
    // 1 タブ内の trigger 競合 (mount / online / 発火した retry timer の重なり) は並走
    // させず、 rerun を予約して現在の flush 完了後に 1 回だけ追走する (drop しない)。
    if (running) {
      rerunRequested = true
      return
    }
    running = true
    try {
      let currentReason = reason
      for (;;) {
        rerunRequested = false
        const outcome = await runGuarded()
        log('review_events.flush.kick', { reason: currentReason, outcome })
        // ok のみ発火: no-pending=サーバー未更新 / transient 等=未確定 のため pull-back 不要。
        // hook の throw が retry/coalesce ループ (下記) を中断しないよう握り潰す。
        if (outcome === 'ok') {
          try {
            onFlushed()
          } catch {
            // pull-back hook の失敗は flush 本体に波及させない (silent)。
          }
        }
        if (outcome === 'transient') {
          scheduleRetry()
        } else {
          if (outcome === 'rate-limited') {
            // 429: 即停止。 自動 retry はせず次の通常 trigger に委ねる (ルール 5)。
            log('review_events.flush.rate_limited_stop', { reason: currentReason })
          }
          // ok / no-pending / permanent / lock-busy / rate-limited → 自動 retry しない。
          clearTimer()
          attempt = 0
        }
        // flush 中に来た kick / retry を取りこぼさず 1 回追走 (coalesce)。
        if (!rerunRequested) break
        currentReason = 'coalesced'
      }
    } finally {
      running = false
    }
  }

  return {
    kick,
    stop: () => {
      clearTimer()
      attempt = 0
    },
  }
}
