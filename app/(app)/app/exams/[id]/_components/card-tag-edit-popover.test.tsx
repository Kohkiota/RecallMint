// @vitest-environment jsdom
// CardTagEditPopover: バッジ click で開く単 stage 編集 popover の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 3 にて新規追加された編集 popover component のテスト。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'

import { CardTagBadge } from './card-tag-badge'
import { CardTagEditPopover } from './card-tag-edit-popover'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const makeCategory = (
  overrides?: Partial<ClientTagCategory>,
): ClientTagCategory => ({
  id: 'cat-1',
  user_id: 'user-1',
  name: '分野',
  select_type: 'multi',
  color: null,
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
  ...overrides,
})

const makeOption = (
  id: string,
  name: string,
  overrides?: Partial<ClientTagOption>,
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: 'cat-1',
  name,
  color: null,
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
  ...overrides,
})

const CATEGORY_OPTIONS = [
  makeOption('o1', '循環器'),
  makeOption('o2', '腎臓'),
  makeOption('o3', '神経'),
]

function makeTrigger(category: ClientTagCategory, option: ClientTagOption) {
  return (
    <CardTagBadge
      category={category}
      option={option}
      onRemove={vi.fn()}
      onOpenEdit={vi.fn()}
    />
  )
}

// ---------------------------------------------------------------------------
// 1. 初期状態: popover 閉じている → options は表示されない
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — 初期状態', () => {
  it('初期状態で popover が閉じており、 option リストは表示されない', () => {
    const category = makeCategory()
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    // header は popover 内のみに存在するため、 閉じているうちは表示されない
    expect(
      screen.queryByText('分野 を編集'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: '腎臓' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 2. trigger click → popover が開いて options が表示される
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — trigger click で open', () => {
  it('バッジ (trigger) を click すると popover が開く', () => {
    const category = makeCategory()
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    // badge trigger を click
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    // popover content が現れる
    expect(screen.getByText('分野 を編集')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 3. popover open 後に categoryOptions がすべて表示される
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — options 表示', () => {
  it('categoryOptions の全 option が表示される', () => {
    const category = makeCategory()
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set()}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '腎臓' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '神経' })).toBeInTheDocument()
  })

  it('selectedOptionIds に含まれる option は Check アイコンが表示される', () => {
    const category = makeCategory()
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set(['o2'])}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    expect(screen.getByTestId('check-o2')).toBeInTheDocument()
    expect(screen.queryByTestId('check-o1')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 4. multi: option click で onToggle が呼ばれ、 popover は閉じない
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — multi 動作', () => {
  it('multi: option click で onToggle が optionId で呼ばれる', () => {
    const onToggle = vi.fn()
    const category = makeCategory({ select_type: 'multi' })
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set()}
        onToggle={onToggle}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o2')
  })

  it('multi: option click 後も popover は開いたまま (header が見える)', () => {
    const category = makeCategory({ select_type: 'multi' })
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set()}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    // header がまだ表示されていれば popover は開いている
    expect(screen.getByText('分野 を編集')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 5. single: option click で onToggle が呼ばれ、 popover が閉じる
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — single 動作', () => {
  it('single: option click で onToggle が呼ばれ、 popover が閉じる', () => {
    const onToggle = vi.fn()
    const category = makeCategory({ select_type: 'single' })
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        onToggle={onToggle}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    // option を click → single なので onClose() が呼ばれて popover が閉じる
    fireEvent.click(screen.getByRole('menuitemradio', { name: '神経' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o3')
    // popover header が消えていれば閉じている
    expect(screen.queryByText('分野 を編集')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 6. header テキスト「{カテゴリ名} を編集」
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — header テキスト', () => {
  it('popover header に「{カテゴリ名} を編集」 が表示される', () => {
    const category = makeCategory({ name: 'レベル' })
    const option = makeOption('o1', '初級')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={[option]}
        selectedOptionIds={new Set()}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: レベル: 初級' }))
    expect(screen.getByText('レベル を編集')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 7. footer link「タグ管理 →」が /app/tags に向く
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — footer link', () => {
  it('popover footer に「タグ管理 →」 link が /app/tags に向いて表示される', () => {
    const category = makeCategory()
    const option = makeOption('o1', '循環器')
    render(
      <CardTagEditPopover
        category={category}
        categoryOptions={CATEGORY_OPTIONS}
        selectedOptionIds={new Set()}
        onToggle={vi.fn()}
      >
        {makeTrigger(category, option)}
      </CardTagEditPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    const link = screen.getByRole('link', { name: 'タグ管理 →' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/app/tags')
  })
})
