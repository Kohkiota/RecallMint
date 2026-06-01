// @vitest-environment jsdom
// exam-status-live.tsx の test。
// phase-2 (OCR 完了遷移) に加え、phase-1 (processing tick) pull、signal kick、
// grace 停止を検証する。fake timer で POLL_INTERVAL_MS (5000ms) を進めて
// polling を周回させる。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const { mockRunGuardedPull } = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

const { mockRouterRefresh } = vi.hoisted(() => ({
  mockRouterRefresh: vi.fn(),
}))

// 実 useRouter は安定参照を返す。mock も stable object を返さないと
// setStatuses 由来の再 render ごとに router identity が変わり effect が
// 再実行されてしまう (poll session が作り直される) ため、固定 object を返す。
const stableRouter = { refresh: mockRouterRefresh }
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
}))

import { ExamStatusProvider } from './exam-status-live'
import { requestOcrPoll } from '@/lib/exams/ocr-poll-signal'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// fetch を毎 tick の body 生成 callback で駆動する helper。
function mockFetchSequence(bodyFor: (call: number) => unknown) {
  let n = 0
  global.fetch = vi.fn().mockImplementation(() => {
    n++
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(bodyFor(n)),
    })
  })
}

describe('ExamStatusProvider OCR 完了遷移 (既存)', () => {
  it('processing → completed 遷移で runGuardedPull({reason:"ocr-complete"}) と router.refresh() が呼ばれる', async () => {
    mockFetchSequence((call) =>
      call === 1
        ? { statuses: { 'exam-x': 'processing' } }
        : { statuses: {} },
    )

    render(
      <ExamStatusProvider initialStatuses={{ 'exam-x': 'processing' }}>
        <div data-testid="child">ok</div>
      </ExamStatusProvider>,
    )

    expect(screen.getByTestId('child')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(mockRouterRefresh).toHaveBeenCalled()
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'ocr-complete' })
  }, 20000)

  it('processing なし (initialStatuses={}) かつ signal 無し → runGuardedPull は呼ばれない / polling 起動しない', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ statuses: {} }),
    })

    render(
      <ExamStatusProvider initialStatuses={{}}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })

    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockRouterRefresh).not.toHaveBeenCalled()
  })
})

describe('ExamStatusProvider signal kick + grace', () => {
  it('(a) kick で empty status が続くと polling 起動 → KICK_MAX_EMPTY_TICKS で停止 (無限 poll しない / pull 呼ばれない)', async () => {
    mockFetchSequence(() => ({ statuses: {} }))

    render(
      <ExamStatusProvider initialStatuses={{}}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    // 起動前: fetch 0
    expect(global.fetch).not.toHaveBeenCalled()

    // kick: 即時 tick が走るはず
    await act(async () => {
      requestOcrPoll()
      await vi.advanceTimersByTimeAsync(0)
    })
    const afterKick = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    expect(afterKick).toBeGreaterThanOrEqual(1)

    // KICK_MAX_EMPTY_TICKS = 6。即時 tick で 1 つ grace 消費、残りを interval で。
    // 十分な時間 (6 tick 超) 進めても、停止後は fetch が増えないことを確認する。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 8)
    })
    const afterStop = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length

    // さらに進めても fetch 数は変わらない (= 恒久停止)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 5)
    })
    const later = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length

    expect(later).toBe(afterStop)
    // processing を一度も見ていないので pull は呼ばれない
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  }, 20000)

  it('(b) kick → processing が見えた tick で runGuardedPull({reason:"ocr-pending"}) (phase 1)', async () => {
    // 1回目 empty、2回目 processing
    mockFetchSequence((call) =>
      call >= 2
        ? { statuses: { 'exam-x': 'processing' } }
        : { statuses: {} },
    )

    render(
      <ExamStatusProvider initialStatuses={{}}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    await act(async () => {
      requestOcrPoll()
      await vi.advanceTimersByTimeAsync(0) // 即時 tick (call1 empty) を flush
    })
    // 次 tick で processing
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'ocr-pending' })
  }, 20000)

  it('(c) kick → processing → completed で ocr-complete pull + router.refresh、その後停止', async () => {
    // 1: empty, 2: processing, 3: empty (completed)
    mockFetchSequence((call) => {
      if (call === 2) return { statuses: { 'exam-x': 'processing' } }
      return { statuses: {} }
    })

    render(
      <ExamStatusProvider initialStatuses={{}}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    await act(async () => {
      requestOcrPoll()
      await vi.advanceTimersByTimeAsync(0) // 即時 tick (call1 empty) を flush
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000) // tick2: processing
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000) // tick3: completed
    })

    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'ocr-pending' })
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'ocr-complete' })
    expect(mockRouterRefresh).toHaveBeenCalled()

    const afterComplete = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 4)
    })
    // sawProcessing=true で processing 0 到達 → 恒久停止
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterComplete)
  }, 20000)
})

describe('ExamStatusProvider repeated-kick regression', () => {
  it('(f) kick を複数回繰り返しても grace window はリセットされず、polling は有限回で停止する', async () => {
    // fetch は常に empty を返す (processing row が出現しない)
    mockFetchSequence(() => ({ statuses: {} }))

    render(
      <ExamStatusProvider initialStatuses={{}}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    // 1st kick
    await act(async () => {
      requestOcrPoll()
      await vi.advanceTimersByTimeAsync(0) // 即時 tick flush
    })

    // 2 tick 進めてから 2nd kick (grace window が残っている間に再 kick)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 2)
    })
    await act(async () => {
      requestOcrPoll()
      await vi.advanceTimersByTimeAsync(0)
    })

    // さらに 2 tick 進めてから 3rd kick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 2)
    })
    await act(async () => {
      requestOcrPoll()
      await vi.advanceTimersByTimeAsync(0)
    })

    // grace window (KICK_MAX_EMPTY_TICKS=6) を大幅超過する時間を進める
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 10)
    })
    const countAtStop = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length

    // さらに長く進めても fetch 数が増えない (= 恒久停止)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 20)
    })
    const countLater = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length

    expect(countLater).toBe(countAtStop)
    // processing を一度も観測していないので pull は呼ばれない
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  }, 30000)
})

describe('ExamStatusProvider seed paths', () => {
  it('(d) seed failed-only → 1 回だけ poll (reconcile)、継続 polling しない / grace しない', async () => {
    mockFetchSequence(() => ({ statuses: { 'exam-x': 'failed' } }))

    render(
      <ExamStatusProvider initialStatuses={{ 'exam-x': 'failed' }}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    // mount 時の one-shot tick を flush
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const afterMount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    expect(afterMount).toBe(1)

    // timer を進めても追加 poll しない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 10)
    })
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  }, 20000)

  it('(e) seed processing → 0 で恒久停止', async () => {
    mockFetchSequence((call) =>
      call === 1
        ? { statuses: { 'exam-x': 'processing' } }
        : { statuses: {} },
    )

    render(
      <ExamStatusProvider initialStatuses={{ 'exam-x': 'processing' }}>
        <div>ok</div>
      </ExamStatusProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000) // tick1 processing
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000) // tick2 empty → 停止
    })

    const afterStop = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 4)
    })
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterStop)
  }, 20000)
})
