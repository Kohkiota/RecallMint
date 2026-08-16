// @vitest-environment jsdom
// EntityMutationFlushTrigger client component の test。
// mount で 30d drop → flush kick、 visibilitychange(visible) / online で再 kick、
// pagehide で runGuardedEntityMutationFlush の best-effort 呼出、
// unmount で controller.stop + listener 解除。
// controller / dropStale / runGuardedEntityMutationFlush は injection mock で差し替え、
// wiring のみ verify する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const {
  mockKick,
  mockStop,
  mockCreateController,
  mockDropStale,
  mockPullBack,
  mockRunGuarded,
  mockLoggerInfo,
} = vi.hoisted(() => {
  const mockKick = vi.fn(async () => {})
  const mockStop = vi.fn()
  return {
    mockKick,
    mockStop,
    mockCreateController: vi.fn(() => ({ kick: mockKick, stop: mockStop })),
    mockDropStale: vi.fn(
      async (_userId: string, _now: number, _maxAgeMs: number) => [] as string[],
    ),
    mockPullBack: vi.fn(),
    mockRunGuarded: vi.fn(async () => 'no-pending' as const),
    mockLoggerInfo: vi.fn(),
  }
})

vi.mock('@/lib/sync/review-flush', () => ({
  createReviewFlushController: mockCreateController,
}))
vi.mock('@/lib/sync/entity-mutations', () => ({
  dropStalePendingEntityMutations: mockDropStale,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockRunGuarded,
}))
vi.mock('@/lib/sync/pull-back', () => ({
  pullBack: mockPullBack,
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}))

import { EntityMutationFlushTrigger } from './entity-mutation-flush-trigger'

// (app) layout が渡す認証済み userId 相当。
const USER_ID = 'user-a'

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
})

describe('EntityMutationFlushTrigger', () => {
  it('mount で 30d drop を走らせてから flush を kick("mount") する', async () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    expect(mockDropStale).toHaveBeenCalledTimes(1)
    // drop の maxAge は 30d (ms) — T-C1: 24h → 30d 延長 (隔離機構維持、
    // 30d 超は将来 ops 通知の打鍵点として温存)
    expect(mockDropStale.mock.calls[0][2]).toBe(30 * 24 * 60 * 60 * 1000)
    // owner-scope: drop 対象は props の userId に限定される (別 user の pending を隔離しない)。
    expect(mockDropStale.mock.calls[0][0]).toBe(USER_ID)
  })

  it('UI は何も描画しない (null)', () => {
    const { container } = render(<EntityMutationFlushTrigger userId={USER_ID} />)
    expect(container.firstChild).toBeNull()
  })

  it('visibilitychange(visible) で kick("visibilitychange")', async () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() =>
      expect(mockKick).toHaveBeenCalledWith('visibilitychange'),
    )
  })

  it('online イベントで kick("online")', async () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('online'))
  })

  it('pagehide で runGuardedEntityMutationFlush を best-effort 呼出する', async () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    window.dispatchEvent(new Event('pagehide'))
    // fire-and-forget のため微小な非同期待機で十分
    await new Promise((r) => setTimeout(r, 0))
    expect(mockRunGuarded).toHaveBeenCalledTimes(1)
    // owner-scope: pagehide の best-effort flush も props の userId で走る。
    expect(mockRunGuarded).toHaveBeenCalledWith(USER_ID)
  })

  it('unmount で controller.stop() を呼び、 以降の online で kick しない', async () => {
    const { unmount } = render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    unmount()
    expect(mockStop).toHaveBeenCalledTimes(1)
    mockKick.mockClear()
    window.dispatchEvent(new Event('online'))
    // listener 解除済 → kick されない
    await new Promise((r) => setTimeout(r, 0))
    expect(mockKick).not.toHaveBeenCalled()
  })

  it('unmount 後の pagehide で runGuardedEntityMutationFlush が呼ばれない', async () => {
    const { unmount } = render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    unmount()
    mockRunGuarded.mockClear()
    window.dispatchEvent(new Event('pagehide'))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockRunGuarded).not.toHaveBeenCalled()
  })

  it('visibilitychange(hidden) で kick されない', async () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    await waitFor(() => expect(mockKick).toHaveBeenCalledWith('mount'))
    mockKick.mockClear()
    // jsdom の visibilityState は 'visible' がデフォルトのため hidden に mock
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockKick).not.toHaveBeenCalled()
    // 後続 test に影響しないよう visible に戻す
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('onFlushed が pull-back("entity-mutation-flush") を配線している', () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    // createReviewFlushController は onFlushed を含む deps オブジェクトで呼ばれる
    expect(mockCreateController).toHaveBeenCalledWith(
      expect.objectContaining({ onFlushed: expect.any(Function) }),
    )
    // onFlushed を起動すると pullBack('entity-mutation-flush') が 1 回呼ばれる
    const deps = (mockCreateController.mock.calls[0] as unknown[])[0] as {
      onFlushed: () => void
    }
    deps.onFlushed()
    expect(mockPullBack).toHaveBeenCalledWith(USER_ID, 'entity-mutation-flush')
    expect(mockPullBack).toHaveBeenCalledTimes(1)
  })

  it('runGuarded deps が props の userId 付きで runGuardedEntityMutationFlush を呼ぶ', () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    expect(mockCreateController).toHaveBeenCalledWith(
      expect.objectContaining({ runGuarded: expect.any(Function) }),
    )
    // controller に渡した closure を直接叩き、 owner-scope 引数の配線を確認する。
    const deps = (mockCreateController.mock.calls[0] as unknown[])[0] as {
      runGuarded: () => unknown
    }
    void deps.runGuarded()
    expect(mockRunGuarded).toHaveBeenCalledWith(USER_ID)
  })

  it('log deps が渡されている (event 文字列の振替に使う)', () => {
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    expect(mockCreateController).toHaveBeenCalledWith(
      expect.objectContaining({ log: expect.any(Function) }),
    )
  })

  it('log override の event 振替 (review_events→entity_mutations) を pin する — review-flush の prefix 変更時の regression tripwire', () => {
    // createReviewFlushController に渡される log deps を取り出し、
    // 'review_events.flush.kick' を渡したとき logger.info が
    // event: 'entity_mutations.flush.kick' に振り替えて呼ばれることを assert する。
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    const deps = (mockCreateController.mock.calls[0] as unknown[])[0] as {
      log: (event: string, extra?: Record<string, unknown>) => void
    }
    mockLoggerInfo.mockClear()
    deps.log('review_events.flush.kick', { foo: 1 })
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1)
    expect(mockLoggerInfo).toHaveBeenCalledWith({
      foo: 1,
      event: 'entity_mutations.flush.kick',
    })
  })

  it('interval polling が無い (setInterval を呼ばない)', () => {
    const spyInterval = vi.spyOn(window, 'setInterval')
    render(<EntityMutationFlushTrigger userId={USER_ID} />)
    expect(spyInterval).not.toHaveBeenCalled()
    spyInterval.mockRestore()
  })
})
