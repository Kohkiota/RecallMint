// review-flush: Web Locks 排他 + 指数 backoff retry controller の test。
// flushAll / locks / timer / rng を全て injection して決定論的に検証する
// (module-scope state 汚染を避けるため controller は factory)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// runGuardedAnswerEventFlush の配線 (userId 転送 + lock 経由) だけを見たいので
// flush 本体は mock する (Dexie 実体は review-events.test.ts 側で検証済)。
const { mockFlushPendingAnswerEvents } = vi.hoisted(() => ({
  mockFlushPendingAnswerEvents: vi.fn(),
}))
vi.mock('./review-events', () => ({
  flushPendingAnswerEvents: mockFlushPendingAnswerEvents,
}))

import {
  classifyFlushResults,
  runGuardedFlush,
  runGuardedAnswerEventFlush,
  createReviewFlushController,
  FLUSH_LOCK_NAME,
  type FlushOutcome,
} from './review-flush'
import type { FlushResult } from './review-events'

function fr(partial: Partial<FlushResult>): FlushResult {
  return {
    attempted: 0,
    syncedEventIds: [],
    failedEventIds: [],
    sessionSynced: false,
    reachable: true,
    httpStatus: 200,
    ...partial,
  }
}

describe('classifyFlushResults', () => {
  it('空配列 (pending なし) → no-pending', () => {
    expect(classifyFlushResults([])).toBe('no-pending')
  })

  it('全件 synced (failed なし) → ok', () => {
    expect(
      classifyFlushResults([fr({ attempted: 2, syncedEventIds: ['a', 'b'] })]),
    ).toBe('ok')
  })

  it('5xx 失敗 → transient', () => {
    expect(
      classifyFlushResults([fr({ failedEventIds: ['a'], httpStatus: 503, reachable: true })]),
    ).toBe('transient')
  })

  it('network 断 (httpStatus=0 + failed) → transient', () => {
    expect(
      classifyFlushResults([fr({ failedEventIds: ['a'], httpStatus: 0, reachable: false })]),
    ).toBe('transient')
  })

  it('429 失敗 → rate-limited', () => {
    expect(
      classifyFlushResults([fr({ failedEventIds: ['a'], httpStatus: 429, reachable: true })]),
    ).toBe('rate-limited')
  })

  it('429 と 503 が混在 → rate-limited が優先 (429 即停止)', () => {
    expect(
      classifyFlushResults([
        fr({ failedEventIds: ['a'], httpStatus: 503 }),
        fr({ failedEventIds: ['b'], httpStatus: 429 }),
      ]),
    ).toBe('rate-limited')
  })

  it('通常 4xx (400) 失敗 → permanent (自動 retry しない)', () => {
    expect(
      classifyFlushResults([fr({ failedEventIds: ['a'], httpStatus: 400, reachable: true })]),
    ).toBe('permanent')
  })

  it('skip (attempted:0, syncedEventIds 空, failedEventIds 空) → no-pending (pull-back 対象外)', () => {
    // in-flight 空振りは sync していないので 'ok' ではなく 'no-pending' に畳む (回帰核心)。
    expect(classifyFlushResults([fr({ attempted: 0 })])).toBe('no-pending')
  })

  it('複数 result の一部でも syncedEventIds 非空なら → ok', () => {
    // 1 件でも実 sync があれば pull-back 対象とする。
    expect(
      classifyFlushResults([fr({ syncedEventIds: ['a'] }), fr({ attempted: 0 })]),
    ).toBe('ok')
  })
})

describe('runGuardedFlush — Web Locks 排他', () => {
  function fakeLocks(grant: boolean) {
    const calls: { name: string; ifAvailable: boolean | undefined }[] = []
    return {
      calls,
      request: (
        name: string,
        options: { ifAvailable?: boolean },
        cb: (lock: unknown) => Promise<FlushOutcome>,
      ): Promise<FlushOutcome> => {
        calls.push({ name, ifAvailable: options.ifAvailable })
        // grant=true: lock オブジェクトを渡す / grant=false: null (他タブ保持中)
        return Promise.resolve(grant ? cb({ name }) : cb(null))
      },
    }
  }

  it('lock 取得成功 → lock 内で flushAll を実行し結果を classify', async () => {
    const flushAll = vi.fn(async () => [fr({ attempted: 1, syncedEventIds: ['a'] })])
    const locks = fakeLocks(true)
    const outcome = await runGuardedFlush({ flushAll, locks })
    expect(outcome).toBe('ok')
    expect(flushAll).toHaveBeenCalledTimes(1)
    // 固定 lock 名 + ifAvailable:true (queue で待たない)
    expect(locks.calls[0].name).toBe(FLUSH_LOCK_NAME)
    expect(locks.calls[0].ifAvailable).toBe(true)
  })

  it('lock 取得失敗 (他タブ保持) → flush せず即 lock-busy', async () => {
    const flushAll = vi.fn(async () => [fr({})])
    const locks = fakeLocks(false)
    const outcome = await runGuardedFlush({ flushAll, locks })
    expect(outcome).toBe('lock-busy')
    expect(flushAll).not.toHaveBeenCalled()
  })

  it('navigator.locks 非対応 (locks=undefined) → defensive に lock なしで flush', async () => {
    const flushAll = vi.fn(async () => [fr({ attempted: 1, syncedEventIds: ['a'] })])
    const outcome = await runGuardedFlush({ flushAll, locks: undefined })
    expect(outcome).toBe('ok')
    expect(flushAll).toHaveBeenCalledTimes(1)
  })
})

describe('runGuardedAnswerEventFlush — 演習 flush の唯一の経路', () => {
  beforeEach(() => {
    mockFlushPendingAnswerEvents.mockReset()
  })

  it('owner-scope の userId を flush 本体に渡し、結果を classify して返す', async () => {
    mockFlushPendingAnswerEvents.mockResolvedValue(
      fr({ attempted: 1, syncedEventIds: ['e1'] }),
    )
    const outcome = await runGuardedAnswerEventFlush('user-1')
    expect(outcome).toBe('ok')
    expect(mockFlushPendingAnswerEvents).toHaveBeenCalledTimes(1)
    expect(mockFlushPendingAnswerEvents).toHaveBeenCalledWith('user-1')
  })

  it('flush 失敗 (503) は transient に分類される', async () => {
    mockFlushPendingAnswerEvents.mockResolvedValue(
      fr({ attempted: 1, failedEventIds: ['e1'], httpStatus: 503 }),
    )
    expect(await runGuardedAnswerEventFlush('user-1')).toBe('transient')
  })
})

describe('createReviewFlushController — backoff retry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('transient → backoff 後に 1 回 retry、 成功したら停止', async () => {
    const outcomes: FlushOutcome[] = ['transient', 'ok']
    let i = 0
    const runGuarded = vi.fn(async () => outcomes[i++] ?? 'ok')
    const ctrl = createReviewFlushController({
      runGuarded,
      backoffBaseMs: [1_000, 2_000],
      backoffJitterMaxMs: [0, 0],
      maxRetries: 2,
      rng: () => 0,
    })
    await ctrl.kick('mount')
    expect(runGuarded).toHaveBeenCalledTimes(1)
    // base[0]=1000 未満では発火しない
    await vi.advanceTimersByTimeAsync(999)
    expect(runGuarded).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runGuarded).toHaveBeenCalledTimes(2)
    // 成功後はもう retry しない
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runGuarded).toHaveBeenCalledTimes(2)
  })

  it('429 (rate-limited) → 即停止、 retry をスケジュールしない', async () => {
    const runGuarded = vi.fn(async () => 'rate-limited' as FlushOutcome)
    const ctrl = createReviewFlushController({
      runGuarded,
      backoffBaseMs: [1_000],
      backoffJitterMaxMs: [0],
      maxRetries: 5,
      rng: () => 0,
    })
    await ctrl.kick('mount')
    expect(runGuarded).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runGuarded).toHaveBeenCalledTimes(1)
  })

  it('lock-busy → retry しない (他タブに委ねる)', async () => {
    const runGuarded = vi.fn(async () => 'lock-busy' as FlushOutcome)
    const ctrl = createReviewFlushController({
      runGuarded, backoffBaseMs: [1_000], backoffJitterMaxMs: [0], maxRetries: 5, rng: () => 0,
    })
    await ctrl.kick('mount')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runGuarded).toHaveBeenCalledTimes(1)
  })

  it('transient が続くと maxRetries 回で打ち止め (指数 backoff の間隔で発火)', async () => {
    const runGuarded = vi.fn(async () => 'transient' as FlushOutcome)
    const ctrl = createReviewFlushController({
      runGuarded,
      backoffBaseMs: [1_000, 2_000],
      backoffJitterMaxMs: [0, 0],
      maxRetries: 2,
      rng: () => 0,
    })
    await ctrl.kick('mount') // run1 → schedule @1000
    await vi.advanceTimersByTimeAsync(1_000) // run2 → schedule @2000
    await vi.advanceTimersByTimeAsync(2_000) // run3 → exhausted (no schedule)
    expect(runGuarded).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runGuarded).toHaveBeenCalledTimes(3)
  })

  it('実行中の重複 kick は直列化され、 取りこぼさず 1 回だけ coalesced rerun される', async () => {
    let resolveFirst!: (v: FlushOutcome) => void
    let calls = 0
    const runGuarded = vi.fn(() => {
      calls += 1
      if (calls === 1) return new Promise<FlushOutcome>((res) => { resolveFirst = res })
      return Promise.resolve('ok' as FlushOutcome)
    })
    const ctrl = createReviewFlushController({
      runGuarded, backoffBaseMs: [1_000], backoffJitterMaxMs: [0], maxRetries: 5, rng: () => 0,
    })
    const p1 = ctrl.kick('mount')   // run #1 開始 (hang)
    const p2 = ctrl.kick('online')  // 実行中 → rerun を予約 (drop しない)
    // 直列化: hang 中は 2 回目を並走させない
    expect(runGuarded).toHaveBeenCalledTimes(1)
    resolveFirst('ok')
    await Promise.all([p1, p2])
    // 予約された online は coalesced rerun として 1 回だけ実行される
    expect(runGuarded).toHaveBeenCalledTimes(2)
  })

  it('retry timer が他 kick の実行中に発火しても coalesce されて取りこぼされない', async () => {
    let resolveHang!: (v: FlushOutcome) => void
    let calls = 0
    const runGuarded = vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.resolve('transient' as FlushOutcome) // mount → retry 予約
      if (calls === 2) return new Promise<FlushOutcome>((res) => { resolveHang = res }) // online (hang)
      return Promise.resolve('ok' as FlushOutcome) // coalesced rerun
    })
    const ctrl = createReviewFlushController({
      runGuarded, backoffBaseMs: [1_000], backoffJitterMaxMs: [0], maxRetries: 5, rng: () => 0,
    })
    await ctrl.kick('mount') // run #1 transient → retry @1000 予約
    expect(calls).toBe(1)
    const pOnline = ctrl.kick('online') // run #2 (hang) → running=true
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000) // retry timer 発火 → 実行中 → rerun 予約 (drop しない)
    expect(calls).toBe(2)
    resolveHang('ok') // online 完了 → 予約された retry が coalesced rerun (#3) として実行
    await pOnline
    expect(calls).toBe(3)
  })

  it('stop() で予約済 retry timer を解除する', async () => {
    const runGuarded = vi.fn(async () => 'transient' as FlushOutcome)
    const ctrl = createReviewFlushController({
      runGuarded, backoffBaseMs: [1_000], backoffJitterMaxMs: [0], maxRetries: 5, rng: () => 0,
    })
    await ctrl.kick('mount') // schedule @1000
    ctrl.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runGuarded).toHaveBeenCalledTimes(1) // retry 発火せず
  })
})

describe('createReviewFlushController — onFlushed フック', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ok → onFlushed が 1 回呼ばれる', async () => {
    const runGuarded = vi.fn(async () => 'ok' as FlushOutcome)
    const onFlushed = vi.fn()
    const ctrl = createReviewFlushController({
      runGuarded,
      onFlushed,
      backoffBaseMs: [1_000],
      backoffJitterMaxMs: [0],
      maxRetries: 2,
      rng: () => 0,
    })
    await ctrl.kick('mount')
    expect(onFlushed).toHaveBeenCalledTimes(1)
  })

  it('no-pending → onFlushed は呼ばれない', async () => {
    const runGuarded = vi.fn(async () => 'no-pending' as FlushOutcome)
    const onFlushed = vi.fn()
    const ctrl = createReviewFlushController({
      runGuarded,
      onFlushed,
      backoffBaseMs: [1_000],
      backoffJitterMaxMs: [0],
      maxRetries: 2,
      rng: () => 0,
    })
    await ctrl.kick('mount')
    expect(onFlushed).not.toHaveBeenCalled()
  })

  it('transient → ok の retry で onFlushed が 1 回発火する (transient 時は不発)', async () => {
    const outcomes: FlushOutcome[] = ['transient', 'ok']
    let i = 0
    const runGuarded = vi.fn(async () => outcomes[i++] ?? 'ok')
    const onFlushed = vi.fn()
    const ctrl = createReviewFlushController({
      runGuarded,
      onFlushed,
      backoffBaseMs: [1_000],
      backoffJitterMaxMs: [0],
      maxRetries: 2,
      rng: () => 0,
    })
    await ctrl.kick('mount') // transient → retry 予約、onFlushed は不発
    expect(onFlushed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000) // retry 発火 → ok → onFlushed 発火
    expect(onFlushed).toHaveBeenCalledTimes(1)
  })

  it('lock-busy / rate-limited / permanent → onFlushed は呼ばれない', async () => {
    for (const outcome of ['lock-busy', 'rate-limited', 'permanent'] as FlushOutcome[]) {
      const runGuarded = vi.fn(async () => outcome)
      const onFlushed = vi.fn()
      const ctrl = createReviewFlushController({
        runGuarded,
        onFlushed,
        backoffBaseMs: [1_000],
        backoffJitterMaxMs: [0],
        maxRetries: 2,
        rng: () => 0,
      })
      await ctrl.kick('mount')
      expect(onFlushed).not.toHaveBeenCalled()
    }
  })

  it('onFlushed が throw しても kick は reject せず flush ループを壊さない', async () => {
    // ok → onFlushed が throw → 握り潰されて clearTimer/attempt reset まで到達、
    // coalesce 予約も drop されない (hook の失敗を flush 本体に波及させない)。
    const runGuarded = vi.fn(async () => 'ok' as FlushOutcome)
    const onFlushed = vi.fn(() => {
      throw new Error('pull-back boom')
    })
    const ctrl = createReviewFlushController({
      runGuarded,
      onFlushed,
      backoffBaseMs: [1_000],
      backoffJitterMaxMs: [0],
      maxRetries: 2,
      rng: () => 0,
    })
    await expect(ctrl.kick('mount')).resolves.toBeUndefined()
    expect(onFlushed).toHaveBeenCalledTimes(1)
    // ループ健全性: 直後の kick も通常通り走る
    await ctrl.kick('online')
    expect(runGuarded).toHaveBeenCalledTimes(2)
  })
})
