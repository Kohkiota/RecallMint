// @vitest-environment jsdom
// PullTrigger client component test (S-local-2 Task 6)。 mount 時に
// pullAllCards / pullAllExams が並列で呼ばれ、 UI は表示されず、 失敗時にも
// throw / UI 影響なしを verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

const { mockPullAllCards, mockPullAllExams, mockPullAllStudyDays } = vi.hoisted(
  () => ({
    mockPullAllCards: vi.fn(),
    mockPullAllExams: vi.fn(),
    mockPullAllStudyDays: vi.fn(),
  }),
)

vi.mock('@/lib/sync/cards', () => ({
  pullAllCards: mockPullAllCards,
}))
vi.mock('@/lib/sync/exams', () => ({
  pullAllExams: mockPullAllExams,
}))
vi.mock('@/lib/sync/study-days', () => ({
  pullAllStudyDays: mockPullAllStudyDays,
}))

import { PullTrigger } from './pull-trigger'

beforeEach(() => {
  vi.clearAllMocks()
  mockPullAllCards.mockResolvedValue({ ok: true, count: 0 })
  mockPullAllExams.mockResolvedValue({ ok: true, count: 0 })
  mockPullAllStudyDays.mockResolvedValue({ ok: true, count: 0 })
})

afterEach(() => {
  cleanup()
})

describe('PullTrigger', () => {
  it('mount で pullAllCards / pullAllExams / pullAllStudyDays が各 1 回呼ばれる', async () => {
    render(<PullTrigger />)
    // useEffect は同期 microtask で発火
    await Promise.resolve()
    expect(mockPullAllCards).toHaveBeenCalledTimes(1)
    expect(mockPullAllExams).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })

  it('UI は何も render しない (return null)', () => {
    const { container } = render(<PullTrigger />)
    expect(container.firstChild).toBeNull()
  })

  it('3 helper のいずれかが reject しても throw / UI 影響なし、 他は独立に呼ばれる', async () => {
    mockPullAllCards.mockRejectedValueOnce(new Error('boom'))
    mockPullAllExams.mockRejectedValueOnce(new Error('boom2'))
    mockPullAllStudyDays.mockRejectedValueOnce(new Error('boom3'))
    const { container } = render(<PullTrigger />)
    // microtask 経過させて handler 内 promise を resolve させる
    await new Promise((r) => setTimeout(r, 0))
    expect(container.firstChild).toBeNull()
    // 3 helper すべて呼ばれた (= silent retry の前提: 各 helper が独立に呼ばれる)
    expect(mockPullAllCards).toHaveBeenCalledTimes(1)
    expect(mockPullAllExams).toHaveBeenCalledTimes(1)
    expect(mockPullAllStudyDays).toHaveBeenCalledTimes(1)
  })
})
