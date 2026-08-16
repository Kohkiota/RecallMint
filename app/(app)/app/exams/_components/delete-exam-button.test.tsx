// @vitest-environment jsdom
// delete-exam-button.tsx の test。 exam 削除成功時に runGuardedPull が呼ばれ、
// 失敗時は呼ばれないことを検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const { mockRunGuardedPull } = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

const { mockDeleteExam, mockRouterRefresh } = vi.hoisted(() => ({
  mockDeleteExam: vi.fn(),
  mockRouterRefresh: vi.fn(),
}))

vi.mock('@/app/(app)/app/exams/_actions/delete-exam', () => ({
  deleteExam: mockDeleteExam,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}))

import { DeleteExamButton } from './delete-exam-button'

const USER_A = 'user-a'

beforeEach(() => {
  vi.clearAllMocks()
  mockDeleteExam.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('DeleteExamButton', () => {
  it('削除成功 → router.refresh() と runGuardedPull({reason:"exam-delete"}) が呼ばれる', async () => {
    render(<DeleteExamButton examId="exam-x" userId={USER_A} />)

    // idle → confirm フェーズ
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    // confirm フェーズ → 削除実行
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(mockDeleteExam).toHaveBeenCalledWith('exam-x')
    })
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: USER_A, reason: 'exam-delete' })
    })
  })

  it('削除失敗 → runGuardedPull は呼ばれない', async () => {
    mockDeleteExam.mockResolvedValueOnce({ ok: false, error: '削除に失敗しました' })
    render(<DeleteExamButton examId="exam-x" userId={USER_A} />)

    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(screen.getByText('削除に失敗しました')).toBeInTheDocument()
    })
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  })
})
