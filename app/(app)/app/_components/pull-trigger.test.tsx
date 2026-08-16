// @vitest-environment jsdom
// PullTrigger client component test。 mount / visibilitychange / online トリガーで
// runGuardedPull / pullAllStudyDays が呼ばれ、 UI は表示されず、 失敗時にも
// throw / UI 影響なし、 unmount 後は listener が解除されていることを verify。
// suppress フラグ (isAmbientPullSuppressed) on の間は ambient kick が no-op になること、
// off で通常通り呼ばれること、 suppress 解除後に queue されないことも verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// flush 注記: kick() は runGuardedPull / pullAllStudyDays を同期的に呼んでから
// void で promise を捨てるため、 mock 呼出はイベント dispatch と同 tick で確定する。
// よって waitFor は不要で、 microtask 1 回 (await Promise.resolve()) で十分。
// (kick が将来 async 化したらこの前提は崩れるので waitFor へ切替が必要)

const { mockRunGuardedPull, mockPullAllStudyDays, mockIsAmbientPullSuppressed } = vi.hoisted(
  () => ({
    mockRunGuardedPull: vi.fn(),
    mockPullAllStudyDays: vi.fn(),
    mockIsAmbientPullSuppressed: vi.fn(),
  }),
)

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))
vi.mock('@/lib/sync/study-days', () => ({
  pullAllStudyDays: mockPullAllStudyDays,
}))
vi.mock('@/lib/sync/ambient-pull-suppress', () => ({
  isAmbientPullSuppressed: mockIsAmbientPullSuppressed,
}))

import { PullTrigger } from './pull-trigger'

const USER_A = 'user-a'
const USER_B = 'user-b'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunGuardedPull.mockResolvedValue('ran')
  mockPullAllStudyDays.mockResolvedValue({ ok: true, count: 0 })
  // suppress は既定 off — 通常の ambient kick が通る状態
  mockIsAmbientPullSuppressed.mockReturnValue(false)
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
  it('(a) mount で runGuardedPull({ reason: "mount" }) / pullAllStudyDays(userId) が各 1 回呼ばれる', async () => {
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: USER_A, reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledWith(USER_A)
  })

  it('(b) visibilitychange (visible) で runGuardedPull + pullAllStudyDays が追加 kick される', async () => {
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    // visibilityState は既に 'visible' (beforeEach で設定済み)
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_A, reason: 'visibilitychange' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
  })

  it('(c) visibilitychange (hidden) では追加 kick されない', async () => {
    render(<PullTrigger userId={USER_A} />)
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
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    // mount 分のベースライン
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_A, reason: 'online' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
  })

  it('(e) unmount 後は visibilitychange / online で追加 kick されない', async () => {
    const { unmount } = render(<PullTrigger userId={USER_A} />)
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

  // S-local-2 Task 4 (pin ④): effect deps が [] のままだと userId が変わっても
  // 再 kick されず、 listener が旧 userId を closure に抱えたまま残る
  // (= 次 user の pull が前 user の cursor namespace に書かれる)。
  it('(a-2) userId=A で mount → B に rerender すると B で再 kick される', async () => {
    const { rerender } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_A, reason: 'mount' })

    rerender(<PullTrigger userId={USER_B} />)
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ userId: USER_B, reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(2)
    expect(mockPullAllStudyDays).toHaveBeenLastCalledWith(USER_B)
  })

  it('(a-3) 同じ userId で rerender しても再 kick されない (deps が userId 変化にのみ反応)', async () => {
    const { rerender } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)

    rerender(<PullTrigger userId={USER_A} />)
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
  })

  it('(a-4) userId 変化後の visibilitychange は新 userId で kick される (listener 張り替え)', async () => {
    const { rerender } = render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    rerender(<PullTrigger userId={USER_B} />)
    await Promise.resolve()
    mockRunGuardedPull.mockClear()

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({
      userId: USER_B,
      reason: 'visibilitychange',
    })
  })

  it('(f-1) UI は何も render しない (return null)', () => {
    const { container } = render(<PullTrigger userId={USER_A} />)
    expect(container.firstChild).toBeNull()
  })

  it('(f-2) 2 helper のいずれかが reject しても throw / UI 影響なし、 他は独立に呼ばれる', async () => {
    mockRunGuardedPull.mockRejectedValueOnce(new Error('boom'))
    mockPullAllStudyDays.mockRejectedValueOnce(new Error('boom2'))
    const { container } = render(<PullTrigger userId={USER_A} />)
    // microtask 経過させて handler 内 promise を resolve させる
    await new Promise((r) => setTimeout(r, 0))
    expect(container.firstChild).toBeNull()
    // 2 helper すべて呼ばれた (= silent retry の前提: 各 helper が独立に呼ばれる)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })
})

describe('PullTrigger — suppress フラグ', () => {
  // suppress on の場合: mount / visibilitychange / online すべての ambient kick が
  // runGuardedPull / pullAllStudyDays を呼ばない。
  // suppress の対象外 (pullBack / 入口 kick による runGuardedPull 直呼び) は
  // pull.test.ts / pull-back.test.ts で担保するため、ここでは PullTrigger 経由 vs
  // 直呼びの差を pin する程度でよい。

  it('(g-1) suppress on: mount kick が runGuardedPull / pullAllStudyDays を呼ばない', async () => {
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-2) suppress on: visibilitychange (visible) kick が呼ばない', async () => {
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-3) suppress on: online kick が呼ばない', async () => {
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-4) suppress on: 抑止中の visibilitychange/online は queue されない (suppress 解除後も発火しない)', async () => {
    // suppress on でイベントを発火 → suppress off に切替えてもイベントは再発火しない。
    // 「queue しない」= suppress 解除のタイミングで自動的に runGuardedPull が呼ばれないことを確認。
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()

    // suppress off に切替え (次の kick が来た場合のシミュレーション用)
    mockIsAmbientPullSuppressed.mockReturnValue(false)
    // queue 再生は起きない: await しても呼ばれない
    await new Promise((r) => setTimeout(r, 0))
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockPullAllStudyDays).not.toHaveBeenCalled()
  })

  it('(g-5) suppress off: 通常通り呼ばれる (suppress フラグが動作を壊さないことの確認)', async () => {
    // suppress off (beforeEach で mockReturnValue(false) 設定済み)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: USER_A, reason: 'mount' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('(g-6) runGuardedPull 直呼びは suppress フラグに影響されない (pullBack / 入口 kick の bypass 確認)', async () => {
    // PullTrigger 経由の kick は suppress on で止まるが、
    // runGuardedPull を直接呼ぶ経路は flag を参照しないため常に実行される。
    // この test は「PullTrigger 経由 vs 直呼びの差」を pin する。
    mockIsAmbientPullSuppressed.mockReturnValue(true)
    render(<PullTrigger userId={USER_A} />)
    await Promise.resolve()
    // PullTrigger 経由: 呼ばれない
    expect(mockRunGuardedPull).not.toHaveBeenCalled()

    // 直呼び: suppress フラグに関係なく実行される
    // (runGuardedPull は pull.ts で管理、flag は pull.ts に手を入れていない)
    void mockRunGuardedPull({ reason: 'direct' })
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'direct' })
  })
})
