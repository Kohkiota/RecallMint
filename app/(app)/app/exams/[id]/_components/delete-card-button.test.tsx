// @vitest-environment jsdom
// delete-card-button.tsx の test。 card 削除成功時に runGuardedPull が呼ばれ、
// 失敗時は呼ばれないことを検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const { mockRunGuardedPull } = vi.hoisted(() => ({
  mockRunGuardedPull: vi.fn().mockResolvedValue('ran'),
}))

vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))

const { mockDeleteCard, mockRouterRefresh } = vi.hoisted(() => ({
  mockDeleteCard: vi.fn(),
  mockRouterRefresh: vi.fn(),
}))

vi.mock('../_actions/delete-card', () => ({
  deleteCard: mockDeleteCard,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}))

import { DeleteCardButton } from './delete-card-button'

beforeEach(() => {
  vi.clearAllMocks()
  mockDeleteCard.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('DeleteCardButton', () => {
  it('削除成功 → router.refresh() と runGuardedPull({reason:"card-delete"}) が呼ばれる', async () => {
    render(<DeleteCardButton cardId="card-x" />)

    // idle → confirm フェーズ
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    // confirm フェーズ → 削除実行
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(mockDeleteCard).toHaveBeenCalledWith('card-x')
    })
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(mockRunGuardedPull).toHaveBeenCalledWith({ reason: 'card-delete' })
    })
  })

  it('削除失敗 → runGuardedPull は呼ばれない', async () => {
    mockDeleteCard.mockResolvedValueOnce({ ok: false, error: 'カードの削除に失敗しました。' })
    render(<DeleteCardButton cardId="card-x" />)

    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(screen.getByText('カードの削除に失敗しました。')).toBeInTheDocument()
    })
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
  })
})
