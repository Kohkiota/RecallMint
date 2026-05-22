// @vitest-environment jsdom
// DeleteCardButton の test。 2 段 confirm UI と、 削除成功時の exam 詳細遷移 /
// 失敗時の error 表示を検証する。 server action と router は mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('../_actions/delete-card', () => ({
  deleteCard: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import { DeleteCardButton } from './delete-card-button'
import { deleteCard } from '../_actions/delete-card'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('DeleteCardButton', () => {
  it('初期は「削除」ボタンのみ', () => {
    render(<DeleteCardButton cardId="card-1" examId="exam-1" />)
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '削除する' }),
    ).not.toBeInTheDocument()
  })

  it('削除 → confirm 表示 → キャンセルで idle に戻る', () => {
    render(<DeleteCardButton cardId="card-1" examId="exam-1" />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(screen.getByText('このカードを削除しますか?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()
  })

  it('削除する → deleteCard 成功で exam 詳細へ遷移', async () => {
    vi.mocked(deleteCard).mockResolvedValue({
      ok: true,
      data: { examId: 'exam-9' },
    })
    render(<DeleteCardButton cardId="card-1" examId="exam-1" />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    await vi.waitFor(() => {
      expect(deleteCard).toHaveBeenCalledWith('card-1')
      expect(mockPush).toHaveBeenCalledWith('/app/exams/exam-9')
    })
  })

  it('削除する → deleteCard 失敗で error メッセージを表示', async () => {
    vi.mocked(deleteCard).mockResolvedValue({
      ok: false,
      error: 'カードが見つかりません',
    })
    render(<DeleteCardButton cardId="card-1" examId="exam-1" />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(
      await screen.findByText('カードが見つかりません'),
    ).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    // error phase から再試行できる
    expect(screen.getByRole('button', { name: '再試行' })).toBeInTheDocument()
  })
})
