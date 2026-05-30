// @vitest-environment jsdom
// PullTrigger client component test。 mount 時に
// pullDelta / pullAllStudyDays が並列で呼ばれ、 UI は表示されず、 失敗時にも
// throw / UI 影響なしを verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

const { mockPullDelta, mockPullAllStudyDays } = vi.hoisted(
  () => ({
    mockPullDelta: vi.fn(),
    mockPullAllStudyDays: vi.fn(),
  }),
)

vi.mock('@/lib/sync/pull', () => ({
  pullDelta: mockPullDelta,
}))
vi.mock('@/lib/sync/study-days', () => ({
  pullAllStudyDays: mockPullAllStudyDays,
}))

import { PullTrigger } from './pull-trigger'

beforeEach(() => {
  vi.clearAllMocks()
  mockPullDelta.mockResolvedValue({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0 })
  mockPullAllStudyDays.mockResolvedValue({ ok: true, count: 0 })
})

afterEach(() => {
  cleanup()
})

describe('PullTrigger', () => {
  it('mount で pullDelta / pullAllStudyDays が各 1 回呼ばれる', async () => {
    render(<PullTrigger />)
    // useEffect は同期 microtask で発火
    await Promise.resolve()
    expect(mockPullDelta).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('UI は何も render しない (return null)', () => {
    const { container } = render(<PullTrigger />)
    expect(container.firstChild).toBeNull()
  })

  it('2 helper のいずれかが reject しても throw / UI 影響なし、 他は独立に呼ばれる', async () => {
    mockPullDelta.mockRejectedValueOnce(new Error('boom'))
    mockPullAllStudyDays.mockRejectedValueOnce(new Error('boom2'))
    const { container } = render(<PullTrigger />)
    // microtask 経過させて handler 内 promise を resolve させる
    await new Promise((r) => setTimeout(r, 0))
    expect(container.firstChild).toBeNull()
    // 2 helper すべて呼ばれた (= silent retry の前提: 各 helper が独立に呼ばれる)
    expect(mockPullDelta).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })
})
