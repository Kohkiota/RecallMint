// @vitest-environment jsdom
// CardTagEditPopover: バッジ click で開く単 stage 編集 popover の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 3 にて新規追加された編集 popover component のテスト。
// Tag-4c-1 Task 4 にて editOption stage + kebab + Esc 階層のシナリオを追加。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'

// Tag-4c-2c hotfix H5: PopoverContent に渡された props を直接 assert したい
// (collisionPadding / sideOffset / avoidCollisions は Radix 内部 positioning に消費され
// DOM 属性化されないため)。 vi.hoisted で spy 受け皿を確保し、 vi.mock では
// importActual で実 Popover module を取り寄せ PopoverContent のみ wrap する。
// wrap は props を spy へ流した後、 そのまま実 PopoverContent を render するので
// 既存 popover test (data-slot 検索 / role 系) は影響を受けない。
const { popoverContentPropsSpy } = vi.hoisted(() => {
  return { popoverContentPropsSpy: vi.fn() }
})

vi.mock('@/components/ui/popover', async (importActual) => {
  const actual =
    await importActual<typeof import('@/components/ui/popover')>()
  const RealPopoverContent = actual.PopoverContent
  function PopoverContentSpy(
    props: React.ComponentProps<typeof RealPopoverContent>,
  ) {
    popoverContentPropsSpy(props)
    return <RealPopoverContent {...props} />
  }
  return { ...actual, PopoverContent: PopoverContentSpy }
})

import * as React from 'react'
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
  // Tag-4c-2a: 既存 edit popover の挙動には未関与 (Task 3/4 で配線)。 型整合のため stub。
  createCategory: vi.fn(async () => ({ id: 'stub' })),
  createOptionAndAssign: vi.fn(async () => undefined),
  // Tag-4c-2b T7 M-C: reorder callback は TagEditCallbacks 型から drop され、 add
  // popover の standalone props 1 経路に集約された (edit popover には D&D 経路なし)。
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

  it('Tag-4c-2a-fix-4 Fix-1: PopoverContent に `min-w-56` floor が含まれ `w-auto` は不在', () => {
    // stage 遷移時の幅収縮を防ぐため、 PopoverContent に min-w-56 (224px) を追加。
    // w-auto は削除、 max-w-sm + p-0 は維持。
    renderPopover()
    openPopover()
    const content = document.querySelector('[data-slot="popover-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toContain('min-w-56')
    expect(content?.className).toContain('max-w-sm')
    expect(content?.className).toContain('p-0')
    expect(content?.className).not.toContain('w-auto')
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
// 7. 「タグ管理 →」 link 全削除 regression (Tag-4c-2a Task 4 / spec B-2)
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — タグ管理 link 全削除', () => {
  it('option stage で「タグ管理 →」 link は描画されない', () => {
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
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('タグ管理')).not.toBeInTheDocument()
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
// 15. editOption stage でも「タグ管理 →」 link は描画されない (Tag-4c-2a Task 4 / B-2)
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — editOption stage でも タグ管理 link なし', () => {
  it('editOption stage で「タグ管理 →」 link は描画されない', () => {
    renderPopover()
    openPopover()
    clickKebab('腎臓')
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 16. Tag-4c-2a Task 4: option 新規作成 + 即時付与 (createOptionAndAssign) 配線
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — option 新規作成 (createOptionAndAssign)', () => {
  it('combobox 入力欄が popover open で表示される', () => {
    renderPopover()
    openPopover()
    expect(
      screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }),
    ).toBeInTheDocument()
  })

  it('入力して「新規作成: ...」 row click で createOptionAndAssign(category.id, name) が呼ばれる', async () => {
    mockTagEditCallbacks.createOptionAndAssign.mockResolvedValueOnce(undefined)
    renderPopover()
    openPopover()
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '消化器' } })
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 消化器' }))
    await waitFor(() => {
      expect(mockTagEditCallbacks.createOptionAndAssign).toHaveBeenCalledWith(
        'cat-1',
        '消化器',
      )
    })
  })

  it('createOptionAndAssign throw → inline error 表示 (alert role)', async () => {
    mockTagEditCallbacks.createOptionAndAssign.mockRejectedValueOnce(
      new Error('fail'),
    )
    renderPopover()
    openPopover()
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '泌尿器' } })
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 泌尿器' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('作成に失敗しました')
    })
  })

  it('二重発火ガード: 連続 click でも createOptionAndAssign は 1 回だけ呼ばれる', async () => {
    // pending promise を返して await 解決前に 2 回目 click を発火する
    let resolve!: () => void
    const pending = new Promise<undefined>((r) => {
      resolve = () => r(undefined)
    })
    mockTagEditCallbacks.createOptionAndAssign.mockReturnValueOnce(pending)

    renderPopover()
    openPopover()
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '内分泌' } })

    const createBtn = screen.getByRole('button', { name: '新規作成: 内分泌' })
    fireEvent.click(createBtn)
    // CardTagOptionList は click 後すぐ filterText を '' に戻すため、 同じ button は
    // 再 mount されない可能性がある。 ガード検証は handler 入口の isSubmittingCreate で
    // 行われるため、 同一 button の再 click を即座に発火させる。
    fireEvent.click(createBtn)

    resolve()
    await waitFor(() => {
      expect(mockTagEditCallbacks.createOptionAndAssign).toHaveBeenCalledTimes(1)
    })
  })

  it('popover close で createError が reset される (再 open で error 表示なし)', async () => {
    mockTagEditCallbacks.createOptionAndAssign.mockRejectedValueOnce(
      new Error('fail'),
    )
    renderPopover()
    openPopover()
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '皮膚' } })
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 皮膚' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    // popover close (trigger 再 click で toggle close)
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    // 再 open
    fireEvent.click(screen.getByRole('button', { name: 'タグ: 分野: 循環器' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 17. Tag-4c-2a Task 4: category 作成 UI が乗っていない (scope check)
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — category 作成 UI なし (scope)', () => {
  it('「+ カテゴリを追加」 row は表示されない', () => {
    renderPopover()
    openPopover()
    expect(
      screen.queryByRole('button', { name: '+ カテゴリを追加' }),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2a-fix-2 Fix-3: バッジ click → editOption stage rename input 全選択 focus
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — Fix-3: kebab → editOption stage rename input 全選択 focus', () => {
  it('option kebab click で editOption stage 入った瞬間 rename input が focus + 全選択', async () => {
    renderPopover()
    openPopover()
    clickKebab('循環器')
    const input = screen.getByRole('textbox', { name: 'option名 編集' }) as HTMLInputElement
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })
    expect(input.value).toBe('循環器')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('editOption stage 中に別 option の kebab → editTargetId 変化 → 再 mount → 全選択 focus 再発火', async () => {
    renderPopover()
    openPopover()
    // 第 1 kebab: 循環器
    clickKebab('循環器')
    const firstInput = screen.getByRole('textbox', { name: 'option名 編集' }) as HTMLInputElement
    await waitFor(() => {
      expect(document.activeElement).toBe(firstInput)
    })
    expect(firstInput.value).toBe('循環器')
    expect(firstInput.selectionStart).toBe(0)
    expect(firstInput.selectionEnd).toBe(firstInput.value.length)

    // option stage に戻ってから別 option (腎臓) の kebab を click
    fireEvent.click(screen.getByRole('button', { name: 'タグ一覧へ戻る' }))
    clickKebab('腎臓')
    const secondInput = screen.getByRole('textbox', { name: 'option名 編集' }) as HTMLInputElement
    await waitFor(() => {
      expect(document.activeElement).toBe(secondInput)
    })
    expect(secondInput.value).toBe('腎臓')
    expect(secondInput.selectionStart).toBe(0)
    expect(secondInput.selectionEnd).toBe(secondInput.value.length)
  })
})

// ---------------------------------------------------------------------------
// 18. Tag-4c-2a-fix Task 4: kind="option" 明示渡しで suppressCreateOnExactMatch
//     default (true) が維持されること = 完全一致時に新規作成 row が出ない
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — kind="option" 明示渡し (suppress on exact match)', () => {
  it('既存 option 名と完全一致する文字列を入力しても「新規作成: ...」 row は表示されない', () => {
    renderPopover()
    openPopover()
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    // 既存 option '循環器' と完全一致
    fireEvent.change(input, { target: { value: '循環器' } })
    expect(
      screen.queryByRole('button', { name: '新規作成: 循環器' }),
    ).not.toBeInTheDocument()
    // 既存 option はフィルタを通って表示される
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2c hotfix H5: PopoverContent に collisionPadding / sideOffset /
//   avoidCollisions が渡されている
// ---------------------------------------------------------------------------
// 端起動時の余白確保 (handle 24px / kebab 28px の操作 affordance 確保) のため、
// Radix Popover の positioning props を 3 件追加。 これらは DOM 属性化されない
// (floating-ui middleware に内部消費) ため、 `vi.mock` で PopoverContent を spy
// wrap し props を直接 assert する。
// ---------------------------------------------------------------------------

describe('CardTagEditPopover — Tag-4c-2c hotfix H5: PopoverContent 余白 props', () => {
  it('popover open 時に collisionPadding=8 / sideOffset=4 / avoidCollisions=true が渡される', () => {
    popoverContentPropsSpy.mockClear()
    renderPopover()
    openPopover()
    // open 後 spy は最低 1 回呼ばれている (Radix mount + 任意 re-render)
    expect(popoverContentPropsSpy).toHaveBeenCalled()
    // 最後の call の props で本 hotfix の 3 件を assert (中間 render でも同値を期待)
    const lastCall = popoverContentPropsSpy.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const props = lastCall![0] as Record<string, unknown>
    expect(props.collisionPadding).toBe(8)
    expect(props.sideOffset).toBe(4)
    expect(props.avoidCollisions).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tag-4c-2c hotfix H6: drag 中 Esc (defaultPrevented=true) で popover を閉じない
// ---------------------------------------------------------------------------
// dnd-kit KeyboardSensor の cancel 経路 (node_modules/@dnd-kit/core/dist/
// core.esm.js:1332 `handleCancel`) は `event.preventDefault()` を呼ぶ。
// PopoverContent の `onEscapeKeyDown` 先頭で `e.defaultPrevented` 早期 return
// することで「drag 中 Esc → drag cancel のみ / popover stage 維持 / close 起動
// しない」 を構造的に実現する。 通常 Esc (preventDefault されていない) は既存
// editOption 階層挙動を維持。
// ---------------------------------------------------------------------------

/**
 * Tag-4c-2c hotfix H6: spy は `@/components/ui/popover` の PopoverContent
 * 全 mount を捕捉するため、 editOption stage で render される
 * `ColorPalettePopover` 内部の PopoverContent (`onEscapeKeyDown` を持たない)
 * とも衝突する。 ここでは「本 edit popover の PopoverContent」 を
 * `collisionPadding=8` (H5 で設定された当該 popover 固有 props) で識別する。
 */
function findEditPopoverProps(): {
  onEscapeKeyDown?: (event: KeyboardEvent) => void
} {
  for (let i = popoverContentPropsSpy.mock.calls.length - 1; i >= 0; i--) {
    const call = popoverContentPropsSpy.mock.calls[i]
    const p = call?.[0] as Record<string, unknown> | undefined
    if (p && p.collisionPadding === 8) {
      return p as { onEscapeKeyDown?: (event: KeyboardEvent) => void }
    }
  }
  throw new Error(
    'CardTagEditPopover の PopoverContent props を spy から特定できませんでした',
  )
}

describe('CardTagEditPopover — Tag-4c-2c hotfix H6: drag cancel Esc gate', () => {
  it('defaultPrevented=true の Esc は editOption stage 維持 / preventDefault 追加呼出なし', () => {
    popoverContentPropsSpy.mockClear()
    renderPopover()
    openPopover()
    clickKebab('循環器')
    // editOption stage を確認
    expect(
      screen.getByRole('button', { name: 'タグ一覧へ戻る' }),
    ).toBeInTheDocument()

    const props = findEditPopoverProps()
    expect(typeof props.onEscapeKeyDown).toBe('function')

    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    ev.preventDefault()
    expect(ev.defaultPrevented).toBe(true)
    const pdSpy = vi.spyOn(ev, 'preventDefault')
    props.onEscapeKeyDown!(ev)
    // editOption stage 維持 → 「タグ一覧へ戻る」 button が見えたまま
    expect(pdSpy).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'タグ一覧へ戻る' }),
    ).toBeInTheDocument()
  })

  it('defaultPrevented=false の Esc は既存挙動 (editOption → option) を維持', () => {
    popoverContentPropsSpy.mockClear()
    renderPopover()
    openPopover()
    clickKebab('循環器')
    expect(
      screen.getByRole('button', { name: 'タグ一覧へ戻る' }),
    ).toBeInTheDocument()

    const props = findEditPopoverProps()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    expect(ev.defaultPrevented).toBe(false)
    const pdSpy = vi.spyOn(ev, 'preventDefault')
    act(() => {
      props.onEscapeKeyDown!(ev)
    })
    // editOption → option stage に戻る (header「分野 を編集」 が再表示)
    expect(pdSpy).toHaveBeenCalled()
    expect(screen.getByText('分野 を編集')).toBeInTheDocument()
  })
})
