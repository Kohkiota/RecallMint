// pull-back helper のユニットテスト。
// pullBack() が runGuardedPull / pullAllStudyDays の両方を呼び、
// いずれかの reject を握り潰して throw しないことを verify する。
// jsdom 不要 (純ロジック)。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted でモック関数を先に生成し、 vi.mock ファクトリに渡す
// (参照タイミング問題を回避するための手順: pull-trigger.test.tsx と同パターン)。
const { mockRunGuardedPull, mockPullAllStudyDays } = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn(),
  mockPullAllStudyDays: vi.fn(),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))
vi.mock('@/lib/sync/study-days', () => ({
  pullAllStudyDays: mockPullAllStudyDays,
}))

import { pullBack } from './pull-back'

beforeEach(() => {
  vi.clearAllMocks()
  // 既定値: 正常 resolve
  mockRunGuardedPull.mockResolvedValue('ran')
  mockPullAllStudyDays.mockResolvedValue({ ok: true, count: 0 })
})

describe('pullBack', () => {
  it('(1) 両 helper を呼ぶ + userId / reason を runGuardedPull に伝播、 userId を pullAllStudyDays にも伝播', async () => {
    pullBack('user-a', 'flush')
    // fire-and-forget のため microtask を 1 tick 進める
    await Promise.resolve()

    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: 'user-a', reason: 'flush' })
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledWith('user-a')
  })

  it('(2) 両 helper が reject しても pullBack は同期 throw せず、 両者を独立に呼ぶ', async () => {
    // reject 抑制 (各 .catch) はコード側のコメントで担保。 unhandledRejection の発火タイミングは
    // ランナー環境依存で test 窓内に確定しないため、 ここでは framework レベルの検証はせず
    // 「同期 throw しない」「reject しても両 helper が独立に呼ばれる (一方の失敗で他方を止めない)」を assert。
    mockRunGuardedPull.mockRejectedValue(new Error('pull error'))
    mockPullAllStudyDays.mockRejectedValue(new Error('study-days error'))

    // void 戻り値の同期関数なので throw しない
    expect(() => pullBack('user-a', 'x')).not.toThrow()

    // microtask/macrotask を進めて両 reject を処理させる (test が落ちないこと自体が catch の傍証)
    await new Promise((r) => setTimeout(r, 0))

    // 一方が reject しても両 helper が呼ばれる (独立 fire-and-forget)
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })
})
