// @vitest-environment jsdom
// ExamCardBulkDeleteDialog: Grid-2 T5 bulk 削除確認 modal の unit test。
// ConfirmDialog 流用 wrapper の文言反映 / confirm・cancel 配線 / open=false 非表示を検証。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import { ExamCardBulkDeleteDialog } from './exam-card-bulk-delete-dialog'

afterEach(() => {
  cleanup()
})

describe('ExamCardBulkDeleteDialog', () => {
  it('open=true で title と count 反映 description を表示する', () => {
    render(
      <ExamCardBulkDeleteDialog open count={3} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.getByText('カードを削除しますか?')).toBeInTheDocument()
    expect(
      screen.getByText('選択した 3 件のカードを削除します。元に戻せません。'),
    ).toBeInTheDocument()
  })

  it('「削除する」 click で onConfirm が呼ばれる', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ExamCardBulkDeleteDialog open count={2} onConfirm={onConfirm} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '削除する' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('「キャンセル」 click で onCancel が呼ばれ onConfirm は呼ばれない', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ExamCardBulkDeleteDialog open count={5} onConfirm={onConfirm} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('open=false では何も表示しない', () => {
    render(
      <ExamCardBulkDeleteDialog open={false} count={3} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.queryByText('カードを削除しますか?')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '削除する' })).not.toBeInTheDocument()
  })
})
