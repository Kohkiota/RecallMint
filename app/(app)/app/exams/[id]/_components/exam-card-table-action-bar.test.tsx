// @vitest-environment jsdom
// ExamCardTableActionBar unit test (Grid-2 T6)。
// action bar 単体を render し、 件数表示 / 削除 modal 経路 / 失敗 UI を検証する。
// popover adapter / selection 統合の経路は ExamCardTable 統合 test (exam-card-table.test.tsx) で担保。
// Fix-1 T2 追記: 付与 popover 新規作成導線 / 除去 popover selectOnly の検証。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ClientTagCategory } from '@/lib/client-db'

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

// ===========================================================================
// Fix-1 T2: 付与 popover 新規作成導線 / 除去 popover selectOnly 検証
// ===========================================================================

const CATEGORY: ClientTagCategory = {
  id: 'cat-fix1',
  user_id: 'user-1',
  name: 'Difficulty',
  select_type: 'multi',
  color: null,
  sort_key: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

describe('Fix-1 T2: 付与 popover 新規作成導線 (selectOnly=false)', () => {
  it('「タグ付与」popover はカテゴリ stage で文字入力すると「新規作成」行が出る', async () => {
    renderBar({ categories: [CATEGORY] })

    // 「タグ付与」button をクリックして popover を開く
    fireEvent.click(screen.getByRole('button', { name: 'タグ付与' }))

    // stage1 combobox が表示されるのを待つ
    const input = await screen.findByLabelText('category を検索 / 新規作成')

    // 入力で新規作成行を出す
    fireEvent.change(input, { target: { value: 'NewTag' } })

    // 「新規作成: NewTag」ボタンが存在する (selectOnly=false → onCreateNew が有効)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新規作成: NewTag' })).toBeInTheDocument()
    })
  })

  it('付与 popover の createCategory が tagEditCallbacks.createCategory を呼ぶ (callbacks 配線確認)', async () => {
    // カテゴリ新規作成 → createCategoryType stage でマルチセレクト確定 → createCategory が呼ばれる。
    // これにより tagEditCallbacks が付与 popover に正しく配線されていることを確認する。
    // Note: createOptionAndAssign の integration 検証は exam-card-table.test.tsx (統合 test) で担保。
    const createCategory = vi.fn(async () => ({ id: 'new-cat' }))

    renderBar({ categories: [], tagEditCallbacks: { ...tagEditCallbacks, createCategory } })

    // 「タグ付与」button で popover を開く
    fireEvent.click(screen.getByRole('button', { name: 'タグ付与' }))
    const input = await screen.findByLabelText('category を検索 / 新規作成')

    // カテゴリ新規作成 → type 確定 → option stage へ
    fireEvent.change(input, { target: { value: 'Cat1' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '新規作成: Cat1' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: Cat1' }))

    // createCategoryType stage: 「マルチセレクト」で確定
    const multiBtn = await screen.findByRole('button', { name: 'マルチセレクト' })
    fireEvent.click(multiBtn)

    await waitFor(() => expect(createCategory).toHaveBeenCalledWith('Cat1', 'multi'))
  })

  it('カテゴリ作成導線 (stage1 新規作成行) が付与側に健在 (regression)', async () => {
    // categories が空でも stage1 で文字入力すると「新規作成: {name}」が出る = selectOnly=false
    renderBar({ categories: [] })
    fireEvent.click(screen.getByRole('button', { name: 'タグ付与' }))
    const input = await screen.findByLabelText('category を検索 / 新規作成')
    fireEvent.change(input, { target: { value: 'Any' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新規作成: Any' })).toBeInTheDocument()
    })
  })
})

describe('Fix-1 T2: 除去 popover selectOnly で新規作成導線なし', () => {
  it('「タグ除去」popover はカテゴリ stage で文字入力しても「新規作成」行が出ない (selectOnly=true)', async () => {
    renderBar({ categories: [CATEGORY] })

    // 「タグ除去」button をクリック
    fireEvent.click(screen.getByRole('button', { name: 'タグ除去' }))

    // stage1 combobox が表示されるのを待つ (selectOnly = 検索専用文言)
    const input = await screen.findByLabelText('カテゴリを検索')

    // 入力しても新規作成行は出ない (selectOnly=true → onCreateNew undefined)
    fireEvent.change(input, { target: { value: 'NewTag' } })

    // 少し待っても新規作成行が存在しないことを確認
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '新規作成: NewTag' })).not.toBeInTheDocument()
    })
  })

  it('selectOnly でも stage2 (option stage) に到達でき、新規作成導線は出ない', async () => {
    // options=[] のため option は表示されず toggle click は行えない。
    // 本テストは「カテゴリを選択すると stage2 に遷移できる」= 除去 popover の stage 遷移が健全であることを確認する。
    const onBulkTag = vi.fn(async () => {})
    renderBar({ categories: [CATEGORY], options: [], onBulkTag })

    // 「タグ除去」button で popover を開く
    fireEvent.click(screen.getByRole('button', { name: 'タグ除去' }))
    const input = await screen.findByLabelText('カテゴリを検索')

    // カテゴリを選択すると stage2 (option stage) に遷移する
    // Difficulty が categories にある → click で option stage へ
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))

    // option stage が表示される (stage2 到達を確認)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'カテゴリ選択へ戻る' })).toBeInTheDocument()
    })

    // options=[] なので option は表示されず onBulkTag (remove toggle) は呼ばれない。
    // stage2 到達 = 除去 popover の stage 遷移が selectOnly でも健全であることを証明。
    expect(onBulkTag).not.toHaveBeenCalled()
  })
})
