// @vitest-environment jsdom
// PullTrigger client component test。 mount / visibilitychange / online トリガーで
// runGuardedPull / pullAllStudyDays が呼ばれ、 UI は表示されず、 失敗時にも
// throw / UI 影響なし、 unmount 後は listener が解除されていることを verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// flush 注記: kick() は runGuardedPull / pullAllStudyDays を同期的に呼んでから
// void で promise を捨てるため、 mock 呼出はイベント dispatch と同 tick で確定する。
// よって waitFor は不要で、 microtask 1 回 (await Promise.resolve()) で十分。
// (kick が将来 async 化したらこの前提は崩れるので waitFor へ切替が必要)

const { mockRunGuardedPull, mockPullAllStudyDays } = vi.hoisted(
  () => ({
    mockRunGuardedPull: vi.fn(),
    mockPullAllStudyDays: vi.fn(),
  }),
)

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))
vi.mock('@/lib/sync/study-days', () => ({
  pullAllStudyDays: mockPullAllStudyDays,
}))

import { PullTrigger } from './pull-trigger'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunGuardedPull.mockResolvedValue('ran')
  mockPullAllStudyDays.mockResolvedValue({ ok: true, count: 0 })
  // jsdom default: visibilityState is 'visible'
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  // restore visibilityState to 'visible' for isolation
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  })
})

describe('PullTrigger', () => {
  it('(a) mount で runGuardedPull({ reason: "mount" }) / pullAllStudyDays が各 1 回呼ばれる', async () => {
    render(<PullTrigger />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('(b) visibilitychange (visible) で runGuardedPull + pullAllStudyDays が追加 kick される', async () => {
    render(<PullTrigger />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    // visibilityState は既に 'visible' (beforeEach で設定済み)
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ reason: 'visibilitychange' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
  })

  it('(c) visibilitychange (hidden) では追加 kick されない', async () => {
    render(<PullTrigger />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)

    // hidden に変更して dispatch
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    // 追加 kick されない (mount 分のまま)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('(d) online イベントで runGuardedPull + pullAllStudyDays が追加 kick される', async () => {
    render(<PullTrigger />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ reason: 'online' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
  })

  it('(e) unmount 後は visibilitychange / online で追加 kick されない', async () => {
    const { unmount } = render(<PullTrigger />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    unmount()

    // 前提: visibilityState は 'visible' (beforeEach)。 これがないと「hidden だから
    // kick されない」 で test が誤って pass しうるため明示確認 (listener 解除が真因)。
    expect(document.visibilityState).toBe('visible')

    // unmount 後にイベント発火
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    // listener が解除されているので追加 kick なし
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('(f-1) UI は何も render しない (return null)', () => {
    const { container } = render(<PullTrigger />)
    expect(container.firstChild).toBeNull()
  })

  it('(f-2) 2 helper のいずれかが reject しても throw / UI 影響なし、 他は独立に呼ばれる', async () => {
    mockRunGuardedPull.mockRejectedValueOnce(new Error('boom'))
    mockPullAllStudyDays.mockRejectedValueOnce(new Error('boom2'))
    const { container } = render(<PullTrigger />)
    // microtask 経過させて handler 内 promise を resolve させる
    await new Promise((r) => setTimeout(r, 0))
    expect(container.firstChild).toBeNull()
    // 2 helper すべて呼ばれた (= silent retry の前提: 各 helper が独立に呼ばれる)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })
})
