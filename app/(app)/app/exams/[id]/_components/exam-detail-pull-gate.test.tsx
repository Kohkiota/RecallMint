// @vitest-environment jsdom
// ExamDetailPullGate client component test。
// mount で ① runGuardedPull({reason:'exam-detail-mount'}) 発火 → ② suppressAmbientPull 呼出
// (kick → suppress の順序保証)、 unmount で resumeAmbientPull、 examId 変化で
// cleanup(resume) → 再 effect(kick + suppress)、 StrictMode 二重 mount の冪等性を verify。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, cleanup } from '@testing-library/react'

const {
  mockRunGuardedPull,
  mockSuppressAmbientPull,
  mockResumeAmbientPull,
} = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn(),
  mockSuppressAmbientPull: vi.fn(),
  mockResumeAmbientPull: vi.fn(),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))
vi.mock('@/lib/sync/ambient-pull-suppress', () => ({
  suppressAmbientPull: mockSuppressAmbientPull,
  resumeAmbientPull: mockResumeAmbientPull,
}))

import { ExamDetailPullGate } from './exam-detail-pull-gate'

beforeEach(() => {
  vi.clearAllMocks()
  mockRunGuardedPull.mockResolvedValue('ran')
})

afterEach(() => {
  cleanup()
})

describe('ExamDetailPullGate', () => {
  it('(a) mount で runGuardedPull({reason:"exam-detail-mount"}) が 1 回呼ばれる', async () => {
    render(<ExamDetailPullGate examId="exam-1" />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'exam-detail-mount' })
  })

  it('(b) mount で suppressAmbientPull が 1 回呼ばれる', async () => {
    render(<ExamDetailPullGate examId="exam-1" />)
    await Promise.resolve()
    expect(mockSuppressAmbientPull).toHaveBeenCalledTimes(1)
  })

  it('(c) kick → suppress の順序: runGuardedPull が suppressAmbientPull より先に呼ばれる', async () => {
    render(<ExamDetailPullGate examId="exam-1" />)
    await Promise.resolve()
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockSuppressAmbientPull).toHaveBeenCalledTimes(1)
    // invocationCallOrder で順序を assert
    const kickOrder = mockRunGuardedPull.mock.invocationCallOrder[0]!
    const suppressOrder = mockSuppressAmbientPull.mock.invocationCallOrder[0]!
    expect(kickOrder).toBeLessThan(suppressOrder)
  })

  it('(d) unmount で resumeAmbientPull が呼ばれる', async () => {
    const { unmount } = render(<ExamDetailPullGate examId="exam-1" />)
    await Promise.resolve()
    expect(mockResumeAmbientPull).not.toHaveBeenCalled()
    unmount()
    expect(mockResumeAmbientPull).toHaveBeenCalledTimes(1)
  })

  it('(e) examId 変化で cleanup(resume) → 再 effect(kick + suppress) が走る', async () => {
    const { rerender } = render(<ExamDetailPullGate examId="exam-1" />)
    await Promise.resolve()

    // exam-1 mount 後の状態
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockSuppressAmbientPull).toHaveBeenCalledTimes(1)
    expect(mockResumeAmbientPull).not.toHaveBeenCalled()

    // examId を exam-2 に変更 → cleanup(resume) + 再 effect(kick + suppress)
    rerender(<ExamDetailPullGate examId="exam-2" />)
    await Promise.resolve()

    // cleanup で resume が 1 回走った
    expect(mockResumeAmbientPull).toHaveBeenCalledTimes(1)
    // 再 effect で kick + suppress が追加で走った
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(2)
    expect(mockRunGuardedPull).toHaveBeenLastCalledWith({ reason: 'exam-detail-mount' })
    expect(mockSuppressAmbientPull).toHaveBeenCalledTimes(2)

    // examId 変化後も kick → suppress 順序が保たれる
    const kickOrder2 = mockRunGuardedPull.mock.invocationCallOrder[1]!
    const suppressOrder2 = mockSuppressAmbientPull.mock.invocationCallOrder[1]!
    expect(kickOrder2).toBeLessThan(suppressOrder2)
  })

  it('(f) UI は何も render しない (return null)', () => {
    const { container } = render(<ExamDetailPullGate examId="exam-1" />)
    expect(container.firstChild).toBeNull()
  })

  it('(g) runGuardedPull が reject しても throw / UI 影響なし (fire-and-forget silent)', async () => {
    mockRunGuardedPull.mockRejectedValueOnce(new Error('network error'))
    const { container } = render(<ExamDetailPullGate examId="exam-1" />)
    await Promise.resolve()
    // suppress は依然として呼ばれ、エラーは伝播しない
    expect(mockSuppressAmbientPull).toHaveBeenCalledTimes(1)
    expect(container.firstChild).toBeNull()
  })

  it('(h) StrictMode ラッパでマウント後に suppress が on で終わる (kick/suppress/resume は冪等)', async () => {
    // React StrictMode は dev build で effect を 2 度実行する
    // (setup → cleanup → setup の二重 invoke)。
    // suppress / resume / runGuardedPull が冪等に振る舞い、
    // 最終的に suppress が on (resume より suppress の呼出回数が多い) で終わることを確認。
    render(
      <StrictMode>
        <ExamDetailPullGate examId="exam-1" />
      </StrictMode>,
    )
    // microtask + StrictMode の同期 cleanup/re-run が落ち着くまで flush
    await Promise.resolve()
    await Promise.resolve()

    // StrictMode dev double-invoke: suppress >= 1, resume >= 0。
    // 最終的に suppress が on: suppress 呼出 > resume 呼出。
    const suppressCount = mockSuppressAmbientPull.mock.calls.length
    const resumeCount = mockResumeAmbientPull.mock.calls.length
    expect(suppressCount).toBeGreaterThanOrEqual(1)
    // suppress と resume の差し引きで suppress が勝っている (on 状態)
    expect(suppressCount).toBeGreaterThan(resumeCount)
    // kick は suppress の on/off に関わらず in-flight guard で吸収可能
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'exam-detail-mount' })
  })
})
