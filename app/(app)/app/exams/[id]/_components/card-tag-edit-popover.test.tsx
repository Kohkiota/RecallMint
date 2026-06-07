// @vitest-environment jsdom
// CardTagEditPopover: バッジ click で開く単 stage 編集 popover の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 3 にて新規追加された編集 popover component のテスト。
// Tag-4c-1 Task 4 にて editOption stage + kebab + Esc 階層のシナリオを追加。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

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

const mockTagEditCallbacks = {
  renameCategory: vi.fn(async () => undefined),
  setCategoryColor: vi.fn(async () => undefined),
  deleteCategory: vi.fn(async () => undefined),
  renameOption: vi.fn(async () => undefined),
  setOptionColor: vi.fn(async () => undefined),
  deleteOption: vi.fn(async () => undefined),
  countCategoryImpact: vi.fn(async () => ({ optionCount: 0, cardCount: 0 })),
  countOptionImpact: vi.fn(async () => ({ cardCount: 0 })),
}

function makeTrigger(category: ClientTagCategory, option: ClientTagOption) {
  return (
    <CardTagBadge
      category={category}
      option={option}
      onRemove={vi.fn<() => void>()}
      onOpenEdit={vi.fn<() => void>()}
    />
  )
}

function renderPopover(
  overrides: {
    category?: ClientTagCategory
    categoryOptions?: ClientTagOption[]
    selectedOptionIds?: Set<string>
    onToggle?: (optionId: string) => void
  } = {},
) {
  const category = overrides.category ?? makeCategory()
  const categoryOptions = overrides.categoryOptions ?? CATEGORY_OPTIONS
  const selectedOptionIds = overrides.selectedOptionIds ?? new Set<string>()
  const onToggle = overrides.onToggle ?? vi.fn<(optionId: string) => void>()
  const option = makeOption('o1', '循環器')

  render(
    <CardTagEditPopover
      category={category}
      categoryOptions={categoryOptions}
      selectedOptionIds={selectedOptionIds}
      onToggle={onToggle}
      tagEditCallbacks={mockTagEditCallbacks}
    >
      {makeTrigger(category, option)}
    </CardTagEditPopover>,
  )

  return { category, categoryOptions, selectedOptionIds, onToggle }
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: /タグ: 分野: 循環器/ }))
}

function clickKebab(optionName: string) {
  fireEvent.click(screen.getByRole('button', { name: `option 操作: ${optionName}` }))
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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
        tagEditCallbacks={mockTagEditCallbacks}
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

// ---------------------------------------------------------------------------
// NEW: 8. stage='option' で各 option row に kebab 表示
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — kebab 表示 (option stage)', () => {
  it('option 一覧の各行に kebab ボタンが表示される', () => {
    renderPopover()
    openPopover()
    expect(screen.getByRole('button', { name: 'option 操作: 循環器' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 腎臓' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 神経' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 9. option kebab click → stage='editOption'
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — kebab click → editOption stage', () => {
  it('option kebab click で editOption stage に遷移し、 header「タグ一覧へ戻る」が表示される', () => {
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    expect(screen.getByRole('button', { name: 'タグ一覧へ戻る' })).toBeInTheDocument()
    // option list header は消える
    expect(screen.queryByText('分野 を編集')).not.toBeInTheDocument()
  })

  it('option kebab click で CardTagEditFields (option名 編集 input) が表示される', () => {
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    expect(screen.getByRole('textbox', { name: 'option名 編集' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 10.「タグ一覧へ戻る」 click → stage='option'
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — 戻るボタンで option stage に戻る', () => {
  it('「タグ一覧へ戻る」 click で option list が再表示される', () => {
    renderPopover()
    openPopover()
    clickKebab('循環器')
    fireEvent.click(screen.getByRole('button', { name: 'タグ一覧へ戻る' }))
    expect(screen.getByText('分野 を編集')).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 11. Esc (editOption) → stage='option'
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — Esc で editOption → option', () => {
  it('editOption stage で Esc を押すと option list stage に戻る', () => {
    renderPopover()
    openPopover()
    clickKebab('神経')
    // editOption stage を確認
    expect(screen.getByRole('button', { name: 'タグ一覧へ戻る' })).toBeInTheDocument()
    // PopoverContent に Esc キーを発行
    const content = screen.getByRole('textbox', { name: 'option名 編集' }).closest('[data-radix-popper-content-wrapper]')
      ?? document.querySelector('[role="dialog"]')
      ?? document.body
    fireEvent.keyDown(content, { key: 'Escape' })
    // option stage に戻る
    expect(screen.getByText('分野 を編集')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 12. editOption rename 成功 → callback 呼出 + stage 維持 + lastError null
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — editOption rename', () => {
  it('rename 成功: tagEditCallbacks.renameOption が呼ばれ stage は editOption のまま', async () => {
    mockTagEditCallbacks.renameOption.mockResolvedValueOnce(undefined)
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    const input = screen.getByRole('textbox', { name: 'option名 編集' })
    fireEvent.change(input, { target: { value: '泌尿器' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(mockTagEditCallbacks.renameOption).toHaveBeenCalledWith('o2', '泌尿器')
    })
    // editOption stage にとどまっている (back button がまだある)
    expect(screen.getByRole('button', { name: 'タグ一覧へ戻る' })).toBeInTheDocument()
    // error は出ていない
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('rename throw → lastError が inline 表示され stage 維持', async () => {
    mockTagEditCallbacks.renameOption.mockRejectedValueOnce(new Error('network error'))
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    const input = screen.getByRole('textbox', { name: 'option名 編集' })
    fireEvent.change(input, { target: { value: '泌尿器' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    // stage は editOption のまま
    expect(screen.getByRole('button', { name: 'タグ一覧へ戻る' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 13. editOption delete 成功 → deleteOption callback 呼出
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — editOption delete', () => {
  it('Fix A-3: delete 成功: 削除 button click で即 deleteOption が呼ばれる (dialog なし)', async () => {
    mockTagEditCallbacks.deleteOption.mockResolvedValueOnce(undefined)
    renderPopover()
    openPopover()
    clickKebab('循環器')
    // Fix A-3: option 削除は即削除 (dialog を経由しない)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    await waitFor(() => {
      expect(mockTagEditCallbacks.deleteOption).toHaveBeenCalledWith('o1')
    })
    // DeleteConfirmDialog (confirm-dialog-backdrop) は開かない。
    // (Radix Popover 自体は role="dialog" を持つが、 それは popover 本体のため除外)
    expect(screen.queryByTestId('confirm-dialog-backdrop')).not.toBeInTheDocument()
    // countOptionImpact は呼ばれない
    expect(mockTagEditCallbacks.countOptionImpact).not.toHaveBeenCalled()
  })

  it('Fix A-3: delete throw → lastError=「削除に失敗しました」+ stage 維持 (dialog なし)', async () => {
    mockTagEditCallbacks.deleteOption.mockRejectedValueOnce(new Error('fail'))
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    // Fix A-3: 即削除で throw → 親 popover の onDelete catch が setLastError する
    await waitFor(() => {
      expect(mockTagEditCallbacks.deleteOption).toHaveBeenCalled()
    })
    // DeleteConfirmDialog は開かない
    expect(screen.queryByTestId('confirm-dialog-backdrop')).not.toBeInTheDocument()
    // stage は editOption のまま
    expect(screen.getByRole('button', { name: 'タグ一覧へ戻る' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 14. popover close で全 state reset
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — popover close で state reset', () => {
  it('editOption stage で popover を閉じ (trigger 再 click)、 再 open すると option stage に戻る', () => {
    renderPopover()
    openPopover()
    clickKebab('神経')
    expect(screen.getByRole('button', { name: 'タグ一覧へ戻る' })).toBeInTheDocument()
    // trigger (badge button) を再 click → toggle close。 jsdom + Radix では
    // outside click が安定しないため、 toggle close (trigger の 2 回目 click) で代替。
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    // popover が閉じた: 「タグ一覧へ戻る」 も option list header も消える
    expect(screen.queryByRole('button', { name: 'タグ一覧へ戻る' })).not.toBeInTheDocument()
    expect(screen.queryByText('分野 を編集')).not.toBeInTheDocument()
    // 再 open
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    // option stage に戻っている
    expect(screen.getByText('分野 を編集')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'タグ一覧へ戻る' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// NEW: 15. footer link は editOption stage でも表示される
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — footer link は editOption stage でも表示', () => {
  it('editOption stage でも「タグ管理 →」 link が表示される', () => {
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    const link = screen.getByRole('link', { name: 'タグ管理 →' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/app/tags')
  })
})
