// @vitest-environment jsdom
// ExamCardTableActionBar unit test (Grid-2 T6)。
// action bar 単体を render し、 件数表示 / 削除 modal 経路 / 失敗 UI を検証する。
// popover adapter / selection 統合の経路は ExamCardTable 統合 test (exam-card-table.test.tsx) で担保。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { TagEditCallbacks } from './card-tags-section'
import type { BulkResult } from '../_hooks/use-bulk-card-tags'
import { ExamCardTableActionBar } from './exam-card-table-action-bar'

const noop = () => {}
const tagEditCallbacks = {
  renameCategory: noop,
  setCategoryColor: noop,
  deleteCategory: noop,
  renameOption: noop,
  setOptionColor: noop,
  deleteOption: noop,
  countCategoryImpact: () => 0,
  countOptionImpact: () => 0,
  createCategory: async () => {},
  createOptionAndAssign: async () => {},
} as unknown as TagEditCallbacks

function renderBar(
  overrides: Partial<React.ComponentProps<typeof ExamCardTableActionBar>> = {},
) {
  const props: React.ComponentProps<typeof ExamCardTableActionBar> = {
    selectedIds: ['card-1', 'card-2'],
    categories: [],
    options: [],
    tagEditCallbacks,
    onBulkTag: vi.fn(async () => {}),
    onBulkDelete: vi.fn(async () => {}),
    lastResult: null,
    ...overrides,
  }
  render(<ExamCardTableActionBar {...props} />)
  return props
}

afterEach(() => cleanup())

describe('ExamCardTableActionBar', () => {
  it('選択件数を表示する', () => {
    renderBar({ selectedIds: ['a', 'b', 'c'] })
    expect(screen.getByTestId('action-bar-count')).toHaveTextContent('3件選択中')
  })

  it('削除ボタン → modal 確定で onBulkDelete を呼ぶ', async () => {
    const onBulkDelete = vi.fn(async () => {})
    renderBar({ onBulkDelete })

    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    // modal が開く
    const confirm = await screen.findByRole('button', { name: '削除する' })
    fireEvent.click(confirm)

    await waitFor(() => expect(onBulkDelete).toHaveBeenCalledTimes(1))
  })

  it('削除 modal キャンセルでは onBulkDelete を呼ばない', async () => {
    const onBulkDelete = vi.fn(async () => {})
    renderBar({ onBulkDelete })

    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    const cancel = await screen.findByRole('button', { name: 'キャンセル' })
    fireEvent.click(cancel)

    expect(onBulkDelete).not.toHaveBeenCalled()
  })

  it('lastResult.ok=false で失敗件数を inline 表示する', () => {
    const result: BulkResult = { ok: false, succeeded: [], failed: ['a', 'b'] }
    renderBar({ lastResult: { op: '付与', result } })

    const err = screen.getByTestId('action-bar-error')
    expect(err).toHaveTextContent('2件')
    expect(err).toHaveTextContent('付与')
    expect(err).toHaveTextContent('再試行されます')
  })

  it('lastResult.ok=true では失敗表示を出さない', () => {
    const result: BulkResult = { ok: true, succeeded: ['a', 'b'], failed: [] }
    renderBar({ lastResult: { op: '付与', result } })
    expect(screen.queryByTestId('action-bar-error')).not.toBeInTheDocument()
  })
})
