// @vitest-environment jsdom
// ReviewFlushTrigger client component の test。 mount で flush kick、
// visibilitychange(visible) / online で再 kick、 unmount で controller.stop + listener 解除。
// controller / flush は injection mock で差し替え、 wiring のみ verify する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const { mockKick, mockStop, mockCreateController, mockRunGuardedFlush, mockPullBack } =
  vi.hoisted(() => {
    const mockKick = vi.fn(async () => {})
    const mockStop = vi.fn()
    return {
      mockKick,
      mockStop,
      mockCreateController: vi.fn(() => ({ kick: mockKick, stop: mockStop })),
      mockRunGuardedFlush: vi.fn(async () => 'ok'),
      mockPullBack: vi.fn(),
    }
  })

vi.mock('@/lib/sync/review-flush', () => ({
  createReviewFlushController: mockCreateController,
  runGuardedAnswerEventFlush: mockRunGuardedFlush,
}))
vi.mock('@/lib/sync/pull-back', () => ({
  pullBack: mockPullBack,
}))

import { ReviewFlushTrigger } from './review-flush-trigger'

const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
})

describe('ReviewFlushTrigger', () => {
  it('mount で flush を kick("mount") する', async () => {
    render(<ReviewFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
  })

  it('UI は何も描画しない (null)', () => {
    const { container } = render(<ReviewFlushTrigger userId={USER_ID} />)
    expect(container.firstChild).toBeNull()
  })

  it('visibilitychange(visible) で kick("visibilitychange")', async () => {
    render(<ReviewFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() =>
      expect(mockKick).toHaveBeenCalledWith('visibilitychange'),
    )
  })

  it('online イベントで kick("online")', async () => {
    render(<ReviewFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('online'))
  })

  it('unmount で controller.stop() を呼び、 以降の online で kick しない', async () => {
    const { unmount } = render(<ReviewFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    unmount()
    expect(mockStop).toHaveBeenCalledTimes(1)
    mockKick.mockClear()
    window.dispatchEvent(new Event('online'))
    // listener 解除済 → kick されない
    await new Promise((r) => setTimeout(r, 0))
    expect(mockKick).not.toHaveBeenCalled()
  })

  it('runGuarded は owner-scope の userId で runGuardedAnswerEventFlush を呼ぶ (Web Locks 経由)', async () => {
    render(<ReviewFlushTrigger userId={USER_ID} />)
    const deps = (mockCreateController.mock.calls[0] as unknown[])[0] as {
      runGuarded: () => Promise<unknown>
    }
    await deps.runGuarded()
    expect(mockRunGuardedFlush).toHaveBeenCalledWith(USER_ID)
  })

  it('onFlushed が pull-back("flush") を配線している', () => {
    render(<ReviewFlushTrigger userId={USER_ID} />)
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
