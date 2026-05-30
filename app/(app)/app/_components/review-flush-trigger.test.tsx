// @vitest-environment jsdom
// ReviewFlushTrigger client component の test。 mount で 24h drop → flush kick、
// visibilitychange(visible) / online で再 kick、 unmount で controller.stop + listener 解除。
// controller / dropStale は injection mock で差し替え、 wiring のみ verify する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const { mockKick, mockStop, mockCreateController, mockDropStale, mockPullBack } =
  vi.hoisted(() => {
    const mockKick = vi.fn(async () => {})
    const mockStop = vi.fn()
    return {
      mockKick,
      mockStop,
      mockCreateController: vi.fn(() => ({ kick: mockKick, stop: mockStop })),
      mockDropStale: vi.fn(async (_now: number, _maxAgeMs: number) => [] as string[]),
      mockPullBack: vi.fn(),
    }
  })

vi.mock('@/lib/sync/review-flush', () => ({
  createReviewFlushController: mockCreateController,
}))
vi.mock('@/lib/sync/review-events', () => ({
  dropStalePendingAnswerEvents: mockDropStale,
}))
vi.mock('@/lib/sync/pull-back', () => ({
  pullBack: mockPullBack,
}))

import { ReviewFlushTrigger } from './review-flush-trigger'

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
})

describe('ReviewFlushTrigger', () => {
  it('mount で 24h drop を走らせてから flush を kick("mount") する', async () => {
    render(<ReviewFlushTrigger />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    expect(mockDropStale).toHaveBeenCalledTimes(1)
    // drop の maxAge は 24h (ms)
    expect(mockDropStale.mock.calls[0][1]).toBe(24 * 60 * 60 * 1000)
  })

  it('UI は何も描画しない (null)', () => {
    const { container } = render(<ReviewFlushTrigger />)
    expect(container.firstChild).toBeNull()
  })

  it('visibilitychange(visible) で kick("visibilitychange")', async () => {
    render(<ReviewFlushTrigger />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() =>
      expect(mockKick).toHaveBeenCalledWith('visibilitychange'),
    )
  })

  it('online イベントで kick("online")', async () => {
    render(<ReviewFlushTrigger />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('online'))
  })

  it('unmount で controller.stop() を呼び、 以降の online で kick しない', async () => {
    const { unmount } = render(<ReviewFlushTrigger />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    unmount()
    expect(mockStop).toHaveBeenCalledTimes(1)
    mockKick.mockClear()
    window.dispatchEvent(new Event('online'))
    // listener 解除済 → kick されない
    await new Promise((r) => setTimeout(r, 0))
    expect(mockKick).not.toHaveBeenCalled()
  })

  it('onFlushed が pull-back("flush") を配線している', () => {
    render(<ReviewFlushTrigger />)
    // createReviewFlushController は onFlushed を含む deps オブジェクトで呼ばれる
    expect(mockCreateController).toHaveBeenCalledWith(
      expect.objectContaining({ onFlushed: expect.any(Function) }),
    )
    // onFlushed を起動すると pullBack('flush') が 1 回呼ばれる
    const deps = (mockCreateController.mock.calls[0] as unknown[])[0] as {
      onFlushed: () => void
    }
    deps.onFlushed()
    expect(mockPullBack).toHaveBeenCalledWith('flush')
    expect(mockPullBack).toHaveBeenCalledTimes(1)
  })
})
