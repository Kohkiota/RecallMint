// @vitest-environment jsdom
// create-exam-form.tsx の test。 exam 作成成功時に runGuardedPull が呼ばれ、
// 失敗時は呼ばれないことを検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const { mockRunGuardedPull } = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

const { mockCreateExam, mockRouterPush } = vi.hoisted(() => ({
  mockCreateExam: vi.fn(),
  mockRouterPush: vi.fn(),
}))

vi.mock('@/app/(app)/app/exams/_actions/create-exam', () => ({
  createExam: mockCreateExam,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

import { CreateExamForm } from './create-exam-form'

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateExam.mockResolvedValue({ ok: true, data: { examId: 'exam-new' } })
})

afterEach(() => {
  cleanup()
})

describe('CreateExamForm', () => {
  it('作成成功 → router.push() と runGuardedPull({reason:"exam-create"}) が呼ばれる', async () => {
    render(<CreateExamForm />)

    // 「＋ 手動で試験を作成」をクリックしてフォームを展開
    fireEvent.click(screen.getByRole('button', { name: /手動で試験を作成/ }))

    // 試験名を入力
    const input = await screen.findByRole('textbox', { name: '試験名' })
    fireEvent.change(input, { target: { value: 'テスト試験' } })

    // 「作成」ボタンを submit
    fireEvent.click(screen.getByRole('button', { name: '作成' }))

    await waitFor(() => {
      expect(mockCreateExam).toHaveBeenCalledWith('テスト試験')
    })
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/app/exams/exam-new')
    })
    await waitFor(() => {
      expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'exam-create' })
    })
  })

  it('作成失敗 → runGuardedPull は呼ばれない', async () => {
    mockCreateExam.mockResolvedValueOnce({ ok: false, error: '作成に失敗しました' })
    render(<CreateExamForm />)

    fireEvent.click(screen.getByRole('button', { name: /手動で試験を作成/ }))
    const input = await screen.findByRole('textbox', { name: '試験名' })
    fireEvent.change(input, { target: { value: 'テスト試験' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))

    await waitFor(() => {
      expect(screen.getByText('作成に失敗しました')).toBeInTheDocument()
    })
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  })
})
