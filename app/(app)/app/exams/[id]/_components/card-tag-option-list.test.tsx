// @vitest-environment jsdom
// CardTagOptionList: multi/single 切替 + 0 件 placeholder + onClose callback + kebab +
// combobox (filter / 新規作成行 / event 分離 / category 変化で reset / inline error) の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 2 にて新規追加された共通 sub-component のテスト。
// Tag-4c-2a Task 2 で combobox + filter + 新規作成行 / showTagManagerLink 撤去を追加。

import * as React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import type { ClientTagOption } from '@/lib/client-db'

import { CardTagOptionList } from './card-tag-option-list'

// SortableContext は useSortable に必須 (parent からの items / strategy が無いと
// no-op + warning)。 sortable 系 test 用の minimal wrapper。
// Tag-4c-2b T4 で追加 (T5 で popover に同等構造を載せる、 本 test は wrapper を
// 自前で持って row 単体の sortable 配線を検証する)。
function SortableWrapper({
  items,
  children,
}: {
  items: string[]
  children: React.ReactNode
}) {
  return (
    <DndContext>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const opt = (
  id: string,
  name: string,
  color?: string | null,
): ClientTagOption => ({
  id,
  user_id: 'user-1',
  category_id: 'cat-1',
  name,
  color: color ?? null,
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
})

const OPTIONS = [
  opt('o1', '循環器', 'red'),
  opt('o2', '腎臓', 'blue'),
  opt('o3', '神経', null),
]

// ---------------------------------------------------------------------------
// 1. 各 option のボタンを name で render する
// ---------------------------------------------------------------------------

describe('CardTagOptionList — option rendering', () => {
  it('各 option の name が aria-label を持つ menuitemcheckbox として表示される (multi)', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: '循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemcheckbox', { name: '腎臓' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitemcheckbox', { name: '神経' }),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 2. Check アイコンは selectedOptionIds に含まれる option のみ表示
// ---------------------------------------------------------------------------

describe('CardTagOptionList — selected state', () => {
  it('selectedOptionIds に含まれる option だけ Check icon (aria-label) を表示する', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    // o1 が選択済み → Check が存在する
    expect(screen.getByTestId('check-o1')).toBeInTheDocument()
    // o2, o3 は未選択 → Check なし
    expect(screen.queryByTestId('check-o2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('check-o3')).not.toBeInTheDocument()
  })

  it('未選択の option に Check が表示されない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    OPTIONS.forEach((o) => {
      expect(screen.queryByTestId(`check-${o.id}`)).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// 3. multi: toggle のみ、 onClose は呼ばれない
// ---------------------------------------------------------------------------

describe('CardTagOptionList — multi selectType', () => {
  it('option click で onToggle が正しい id で 1 回呼ばれる', () => {
    const onToggle = vi.fn()
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o2')
  })

  it('multi: option click では onClose は呼ばれない', () => {
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '循環器' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('multi option は role="menuitemcheckbox" を持つ', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-checked', 'true')
  })

  it('multi: 未選択 option の aria-checked は false', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(btn).toHaveAttribute('aria-checked', 'false')
  })
})

// ---------------------------------------------------------------------------
// 4. single: toggle + onClose 両方呼ばれる
// ---------------------------------------------------------------------------

describe('CardTagOptionList — single selectType', () => {
  it('option click で onToggle と onClose が 1 回ずつ呼ばれる', () => {
    const onToggle = vi.fn()
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={onToggle}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: '神経' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o3')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('single: onClose なし props でも onToggle は呼ばれ crash しない', () => {
    const onToggle = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: '循環器' }))
    expect(onToggle).toHaveBeenCalledWith('o1')
  })

  it('single option は role="menuitemradio" を持つ', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o2'])}
        selectType="single"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemradio', { name: '腎臓' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-checked', 'true')
  })

  it('single: 未選択 option の aria-checked は false', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="single"
        onToggle={vi.fn()}
      />,
    )
    const btn = screen.getByRole('menuitemradio', { name: '循環器' })
    expect(btn).toHaveAttribute('aria-checked', 'false')
  })
})

// ---------------------------------------------------------------------------
// 5. 0 件 placeholder + タグ管理 link 全削除 regression
// ---------------------------------------------------------------------------

describe('CardTagOptionList — 0 件 placeholder', () => {
  it('options が空のとき新 placeholder テキストを表示する', () => {
    render(
      <CardTagOptionList
        options={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.getByText('タグ名を入力し新規作成'),
    ).toBeInTheDocument()
  })

  it('options が空でも「タグ管理 →」 link は描画されない (B-2 regression)', () => {
    render(
      <CardTagOptionList
        options={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole('link', { name: 'タグ管理 →' }),
    ).not.toBeInTheDocument()
  })

  it('options が 1 件以上のとき placeholder を表示しない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.queryByText('タグ名を入力し新規作成'),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 6. onRowAction prop: kebab span の render
// ---------------------------------------------------------------------------

describe('CardTagOptionList — onRowAction kebab', () => {
  it('onRowAction が渡されると各 row に kebab button が表示される', () => {
    const onRowAction = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onRowAction={onRowAction}
      />,
    )
    // 各 option row に kebab (aria-label: 「option 操作: <name>」)
    expect(screen.getByRole('button', { name: 'option 操作: 循環器' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 腎臓' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'option 操作: 神経' })).toBeInTheDocument()
  })

  it('kebab click で onRowAction が optionId で呼ばれる', () => {
    const onRowAction = vi.fn()
    const onToggle = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onRowAction={onRowAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 腎臓' }))
    expect(onRowAction).toHaveBeenCalledWith('o2')
    // onToggle は呼ばれない (stopPropagation 動作確認)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('onRowAction なし (省略) のとき kebab は表示されない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /option 操作:/ })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 7. combobox input: filter / 新規作成行 / event 分離 / category 変化 reset / inline error
//    (Tag-4c-2a Task 2 で追加)
// ---------------------------------------------------------------------------

describe('CardTagOptionList — combobox input + filter', () => {
  it('上部に検索 input が常設される (aria-label「option を検索 / 新規作成」)', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    expect(input).toBeInTheDocument()
  })

  it('入力空 → 全 option 表示 + 新規作成行非表示', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '腎臓' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: '神経' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /新規作成:/ })).not.toBeInTheDocument()
  })

  it('"循" 入力 → 部分一致 ("循環器") のみ表示 + 新規作成行「新規作成: 循」 を表示', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '循' } })

    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: '腎臓' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: '神経' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新規作成: 循' })).toBeInTheDocument()
  })

  it('case-insensitive: "CIRCULATION" 入力 + options=["circulation_test"] → ヒット表示', () => {
    const options = [opt('o1', 'circulation_test', null)]
    render(
      <CardTagOptionList
        options={options}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: 'CIRCULATION' } })

    expect(
      screen.getByRole('menuitemcheckbox', { name: 'circulation_test' }),
    ).toBeInTheDocument()
    // 完全一致ではないので新規作成行は出る
    expect(
      screen.getByRole('button', { name: '新規作成: CIRCULATION' }),
    ).toBeInTheDocument()
  })

  it('完全一致 (case/whitespace 無視) → ヒット表示 + 新規作成行は非表示', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '循環器' } })

    expect(screen.getByRole('menuitemcheckbox', { name: '循環器' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /新規作成:/ })).not.toBeInTheDocument()
  })

  it('入力あり + filter ヒット 0 件 + 完全一致なし → 新規作成行のみ (placeholder は出さない)', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: 'ZZZ' } })

    // 既存 option は filter で全部消える
    expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument()
    // 新規作成行は出る
    expect(screen.getByRole('button', { name: '新規作成: ZZZ' })).toBeInTheDocument()
    // placeholder は出ない
    expect(
      screen.queryByText('タグ名を入力し新規作成'),
    ).not.toBeInTheDocument()
  })
})

describe('CardTagOptionList — 新規作成行 click', () => {
  it('新規作成行 click で onCreateNew が trim 後文字列で 1 回呼ばれる', async () => {
    const onCreateNew = vi.fn().mockResolvedValue(undefined)
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={onCreateNew}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '  新カテゴリ  ' } })

    const createRow = screen.getByRole('button', { name: '新規作成: 新カテゴリ' })
    fireEvent.click(createRow)

    await waitFor(() => {
      expect(onCreateNew).toHaveBeenCalledTimes(1)
    })
    expect(onCreateNew).toHaveBeenCalledWith('新カテゴリ')
  })

  it('新規作成行 click 成功時 filterText が "" に reset される', async () => {
    const onCreateNew = vi.fn().mockResolvedValue(undefined)
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={onCreateNew}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ABC' } })
    expect(input.value).toBe('ABC')

    fireEvent.click(screen.getByRole('button', { name: '新規作成: ABC' }))

    await waitFor(() => {
      expect(input.value).toBe('')
    })
  })

  it('新規作成行 click 失敗時も filterText は "" に reset される', async () => {
    const onCreateNew = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={onCreateNew}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'XYZ' } })

    fireEvent.click(screen.getByRole('button', { name: '新規作成: XYZ' }))

    await waitFor(() => {
      expect(input.value).toBe('')
    })
  })

  it('onCreateNew undefined のときは新規作成行 click が no-op (crash しない)', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: 'ABC' } })

    // 新規作成行は出る (onCreateNew の有無は表示条件に関係しない)
    const createRow = screen.getByRole('button', { name: '新規作成: ABC' })
    // crash しない
    expect(() => fireEvent.click(createRow)).not.toThrow()
  })
})

describe('CardTagOptionList — event 分離', () => {
  it('既存 row click は onToggle のみ呼び、 onCreateNew / onRowAction は呼ばれない', () => {
    const onToggle = vi.fn()
    const onCreateNew = vi.fn().mockResolvedValue(undefined)
    const onRowAction = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onCreateNew={onCreateNew}
        onRowAction={onRowAction}
      />,
    )
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onCreateNew).not.toHaveBeenCalled()
    expect(onRowAction).not.toHaveBeenCalled()
  })

  it('kebab click は onRowAction のみ呼び、 onToggle / onCreateNew は呼ばれない', () => {
    const onToggle = vi.fn()
    const onCreateNew = vi.fn().mockResolvedValue(undefined)
    const onRowAction = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onCreateNew={onCreateNew}
        onRowAction={onRowAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'option 操作: 腎臓' }))
    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
    expect(onCreateNew).not.toHaveBeenCalled()
  })

  it('新規作成行 click は onCreateNew のみ呼び、 onToggle / onRowAction は呼ばれない', async () => {
    const onToggle = vi.fn()
    const onCreateNew = vi.fn().mockResolvedValue(undefined)
    const onRowAction = vi.fn()
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={onToggle}
        onCreateNew={onCreateNew}
        onRowAction={onRowAction}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '新規' } })
    fireEvent.click(screen.getByRole('button', { name: '新規作成: 新規' }))

    await waitFor(() => {
      expect(onCreateNew).toHaveBeenCalledTimes(1)
    })
    expect(onToggle).not.toHaveBeenCalled()
    expect(onRowAction).not.toHaveBeenCalled()
  })
})

describe('CardTagOptionList — selectedCategoryId 変化で filter reset', () => {
  it('selectedCategoryId 変化で filterText が "" に reset される', () => {
    const { rerender } = render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        selectedCategoryId="cat-1"
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '循' } })
    expect(input.value).toBe('循')

    // category 切替
    rerender(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        selectedCategoryId="cat-2"
      />,
    )

    const inputAfter = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' }) as HTMLInputElement
    expect(inputAfter.value).toBe('')
  })
})

describe('CardTagOptionList — createError inline display', () => {
  it('createError 非 null で role="alert" の error が表示される', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        createError="作成に失敗しました"
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('作成に失敗しました')
  })

  it('createError null で alert は描画されない', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        createError={null}
      />,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 8. kind='category' discriminator (Tag-4c-2a-fix Task 1)
//    - Check icon 非表示 / 同名許容 / placeholder + aria-label の上書き
// ---------------------------------------------------------------------------

// category 文脈の fixture helper (id / name / color のみ使う、 ClientTagCategory の
// 一部のみ充足する最小 item)。
const cat = (id: string, name: string, color?: string | null) => ({
  id,
  name,
  color: color ?? null,
})

const CATEGORIES = [
  cat('c1', '循環器', 'red'),
  cat('c2', '腎臓', 'blue'),
  cat('c3', '神経', null),
]

describe("CardTagOptionList — kind='category' (Check icon 抑制)", () => {
  it("kind='category' では selectedOptionIds に含まれていても Check icon が出ない", () => {
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        // 既存 set を渡しても Check icon は抑制される (defensive)
        selectedOptionIds={new Set(['c1'])}
        onToggle={vi.fn()}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    // どの row にも Check icon が出ない
    CATEGORIES.forEach((c) => {
      expect(screen.queryByTestId(`check-${c.id}`)).not.toBeInTheDocument()
    })
  })

  it("kind='category' で selectedOptionIds 未指定でも crash しない (defensive)", () => {
    expect(() =>
      render(
        <CardTagOptionList
          kind="category"
          options={CATEGORIES}
          onToggle={vi.fn()}
          searchAriaLabel="category を検索 / 新規作成"
        />,
      ),
    ).not.toThrow()
  })
})

describe("CardTagOptionList — kind='category' (suppressCreateOnExactMatch=false で同名許容)", () => {
  it("kind='category' + suppressCreateOnExactMatch=false で、 完全一致名入力時も新規作成行が出る", () => {
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
        suppressCreateOnExactMatch={false}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    const input = screen.getByRole('textbox', { name: 'category を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '循環器' } })

    // 既存 row もヒット表示 (Tag-4c-2a-fix Task 2: kind='category' は role='menuitem')
    expect(screen.getByRole('menuitem', { name: '循環器' })).toBeInTheDocument()
    // 完全一致でも新規作成行が出る (同名許容)
    expect(screen.getByRole('button', { name: '新規作成: 循環器' })).toBeInTheDocument()
  })

  it("kind='option' (default) + 完全一致 → 新規作成行が出ない (既存 regression 維持)", () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '循環器' } })
    expect(screen.queryByRole('button', { name: /新規作成:/ })).not.toBeInTheDocument()
  })
})

describe("CardTagOptionList — kind='category' (click semantics は kind 非依存)", () => {
  it('既存 row click → onToggle が item id で呼ばれる (kind 非依存)', () => {
    const onToggle = vi.fn()
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        onToggle={onToggle}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    // Tag-4c-2a-fix Task 2 (review M-1): kind='category' は role="menuitem"
    fireEvent.click(screen.getByRole('menuitem', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('c2')
  })

  it('kebab click → onRowAction が item id で呼ばれる (kind 非依存)', () => {
    const onRowAction = vi.fn()
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        onToggle={vi.fn()}
        onRowAction={onRowAction}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    // Tag-4c-2a-fix Task 2: kebab aria-label は kind='category' で「カテゴリ操作」
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ操作: 神経' }))
    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('c3')
  })

  it("kind='category' + selectType='single' でも onClose は呼ばれない (single 自動 close は kind='option' のみ)", () => {
    const onClose = vi.fn()
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        selectType="single"
        onToggle={vi.fn()}
        onClose={onClose}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    // Tag-4c-2a-fix Task 2 (review M-1): kind='category' は role="menuitem"
    // (selectType='single' は kind='category' では無視される)
    fireEvent.click(screen.getByRole('menuitem', { name: '循環器' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("CardTagOptionList — kind='category' (filter は kind 非依存)", () => {
  it("kind='category' でも部分一致 + 大小無視で filter が動く", () => {
    const categories = [
      cat('c1', 'Cardio', 'red'),
      cat('c2', '腎臓', 'blue'),
    ]
    render(
      <CardTagOptionList
        kind="category"
        options={categories}
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
        suppressCreateOnExactMatch={false}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    const input = screen.getByRole('textbox', { name: 'category を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: 'CARD' } })
    // 部分一致 + case-insensitive (Tag-4c-2a-fix Task 2: role="menuitem")
    expect(screen.getByRole('menuitem', { name: 'Cardio' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '腎臓' })).not.toBeInTheDocument()
  })
})

describe('CardTagOptionList — searchPlaceholder / searchAriaLabel / emptyPlaceholderText 上書き', () => {
  it('searchPlaceholder が input の placeholder 属性に反映される', () => {
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        onToggle={vi.fn()}
        searchPlaceholder="カテゴリを検索 / 追加"
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    const input = screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }) as HTMLInputElement
    expect(input.placeholder).toBe('カテゴリを検索 / 追加')
  })

  it('searchAriaLabel が input の aria-label に反映される', () => {
    render(
      <CardTagOptionList
        kind="category"
        options={CATEGORIES}
        onToggle={vi.fn()}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    // default の「option を検索 / 新規作成」 では取れない
    expect(
      screen.queryByRole('textbox', { name: 'option を検索 / 新規作成' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'category を検索 / 新規作成' }),
    ).toBeInTheDocument()
  })

  it('emptyPlaceholderText が items 0 件 + 新規作成行非表示時に反映される', () => {
    render(
      <CardTagOptionList
        kind="category"
        options={[]}
        onToggle={vi.fn()}
        emptyPlaceholderText="カテゴリがありません。 下の入力欄で作成してください"
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    expect(
      screen.getByText('カテゴリがありません。 下の入力欄で作成してください'),
    ).toBeInTheDocument()
    // default 文言は出ない
    expect(
      screen.queryByText('タグ名を入力し新規作成'),
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 9. kind='category' + select_type icon (Tag-4c-2a-fix-3 Fix-4)
//    - single → CircleDot / multi → CheckSquare / undefined → icon 出ない
//    - kind='option' は select_type と無関係に icon を出さない (regression なし)
// ---------------------------------------------------------------------------

// select_type 付き category 用 fixture (TagComboboxItem を直接満たす形)
const catWithType = (
  id: string,
  name: string,
  select_type: 'single' | 'multi' | undefined,
  color?: string | null,
) => ({
  id,
  name,
  color: color ?? null,
  ...(select_type !== undefined ? { select_type } : {}),
})

describe("CardTagOptionList — kind='category' + select_type icon", () => {
  it("kind='category' + select_type='single' → 行頭に CircleDot icon が表示される", () => {
    const { container } = render(
      <CardTagOptionList
        kind="category"
        options={[catWithType('c1', '循環器', 'single', 'red')]}
        onToggle={vi.fn()}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    const circleDots = container.querySelectorAll('svg.lucide-circle-dot')
    expect(circleDots.length).toBeGreaterThanOrEqual(1)
    // multi icon は出ない
    expect(container.querySelectorAll('svg.lucide-square-check-big').length).toBe(0)
  })

  it("kind='category' + select_type='multi' → 行頭に CheckSquare icon が表示される", () => {
    const { container } = render(
      <CardTagOptionList
        kind="category"
        options={[catWithType('c1', '循環器', 'multi', 'red')]}
        onToggle={vi.fn()}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    const checkSquares = container.querySelectorAll('svg.lucide-square-check-big')
    expect(checkSquares.length).toBeGreaterThanOrEqual(1)
    // single icon は出ない
    expect(container.querySelectorAll('svg.lucide-circle-dot').length).toBe(0)
  })

  it("kind='category' + select_type=undefined → icon は出ない (defensive)", () => {
    const { container } = render(
      <CardTagOptionList
        kind="category"
        options={[catWithType('c1', '循環器', undefined, 'red')]}
        onToggle={vi.fn()}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    expect(container.querySelectorAll('svg.lucide-circle-dot').length).toBe(0)
    expect(container.querySelectorAll('svg.lucide-square-check-big').length).toBe(0)
  })

  it("kind='category' + 複数行 (single + multi 混在) → 各行に対応する icon が出る", () => {
    const { container } = render(
      <CardTagOptionList
        kind="category"
        options={[
          catWithType('c1', '循環器', 'single', 'red'),
          catWithType('c2', '腎臓', 'multi', 'blue'),
          catWithType('c3', '神経', 'single', null),
        ]}
        onToggle={vi.fn()}
        searchAriaLabel="category を検索 / 新規作成"
      />,
    )
    expect(container.querySelectorAll('svg.lucide-circle-dot').length).toBe(2)
    expect(container.querySelectorAll('svg.lucide-square-check-big').length).toBe(1)
  })

  it("kind='option' (default) + option 行は select_type icon を出さない (regression なし)", () => {
    const { container } = render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o1'])}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    // option 行には select_type icon が出ない
    expect(container.querySelectorAll('svg.lucide-circle-dot').length).toBe(0)
    expect(container.querySelectorAll('svg.lucide-square-check-big').length).toBe(0)
    // 既存 selected Check icon は引き続き表示される (regression 防止)
    expect(screen.getByTestId('check-o1')).toBeInTheDocument()
  })

  it("kind='option' + selected 状態 → Check icon は出るが select_type icon は出ない", () => {
    const { container } = render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set(['o2'])}
        selectType="single"
        onToggle={vi.fn()}
      />,
    )
    expect(screen.getByTestId('check-o2')).toBeInTheDocument()
    expect(container.querySelectorAll('svg.lucide-circle-dot').length).toBe(0)
    expect(container.querySelectorAll('svg.lucide-square-check-big').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. break-all (Tag-4c-2a-fix-4 Task 1 Fix-2)
//     - 長 Japanese option / category 名で popover 膨張を防ぐため、 color pill
//       と 新規作成行 span に break-all を付ける。
// ---------------------------------------------------------------------------

describe('CardTagOptionList — break-all (long name wrap)', () => {
  it('option 行 color pill span に break-all class が付く', () => {
    render(
      <CardTagOptionList
        options={[opt('o-long', '肺気腫合併心房細動', 'red')]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    // color pill span は aria-hidden で name を表示する <span>。
    // option 行内に 1 つ存在し、 className に break-all を含む。
    const button = screen.getByRole('menuitemcheckbox', { name: '肺気腫合併心房細動' })
    const pillSpan = button.querySelector('span[aria-hidden="true"]')
    expect(pillSpan).not.toBeNull()
    expect(pillSpan?.className).toContain('break-all')
  })

  it('新規作成行 span (新規作成: {trimmed}) に break-all class が付く', () => {
    render(
      <CardTagOptionList
        options={[]}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'option を検索 / 新規作成' })
    fireEvent.change(input, { target: { value: '肺気腫合併心房細動' } })
    const createButton = screen.getByRole('button', {
      name: '新規作成: 肺気腫合併心房細動',
    })
    // 新規作成行 button 内の <span>新規作成: {trimmed}</span> を取得
    const labelSpan = createButton.querySelector('span')
    expect(labelSpan).not.toBeNull()
    expect(labelSpan?.className).toContain('break-all')
  })
})

// ---------------------------------------------------------------------------
// 11. D&D handle + useSortable 配線 (Tag-4c-2b T4 + T5 fix I-2)
//     - sortable 有無で handle 切替 / items.length<2 で非表示 /
//       event 分離契約 (handle のみに listeners/attributes、 main/kebab に乗らない) /
//       drag と click の分離 (main onClick は通常 click で発火)
//     - T5 fix I-2 で `onReorder?: (orderedIds) => Promise<void>` から
//       `sortable?: boolean` に repurpose (実 dispatch は親 DndContext.onDragEnd
//       経路、 子は handle UI 表示 gate だけを判断)
// ---------------------------------------------------------------------------

describe('CardTagOptionList — D&D handle (Tag-4c-2b T4 + T5 fix I-2)', () => {
  it('sortable 未指定 (default false) → handle button 非表示 (既存挙動踏襲、 SortableWrapper 不要)', () => {
    render(
      <CardTagOptionList
        options={OPTIONS}
        selectedOptionIds={new Set()}
        selectType="multi"
        onToggle={vi.fn()}
      />,
    )
    // 「並べ替え:」 を含む aria-label の button が存在しない
    expect(
      screen.queryByRole('button', { name: /並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('sortable + items.length>=2 → 各 row に handle button (aria-label: optionを並べ替え: {name})', () => {
    render(
      <SortableWrapper items={OPTIONS.map((o) => o.id)}>
        <CardTagOptionList
          options={OPTIONS}
          selectedOptionIds={new Set()}
          selectType="multi"
          onToggle={vi.fn()}
          sortable
        />
      </SortableWrapper>,
    )
    // 各 option の handle button が存在
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 腎臓' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'optionを並べ替え: 神経' }),
    ).toBeInTheDocument()
  })

  it("kind='category' で sortable → handle aria-label が「カテゴリを並べ替え: {name}」", () => {
    render(
      <SortableWrapper items={CATEGORIES.map((c) => c.id)}>
        <CardTagOptionList
          kind="category"
          options={CATEGORIES}
          onToggle={vi.fn()}
          searchAriaLabel="category を検索 / 新規作成"
          sortable
        />
      </SortableWrapper>,
    )
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 循環器' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 腎臓' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'カテゴリを並べ替え: 神経' }),
    ).toBeInTheDocument()
  })

  it('sortable + items.length=1 → handle 非表示 (D-3 (a) ガード)', () => {
    render(
      <SortableWrapper items={[OPTIONS[0]!.id]}>
        <CardTagOptionList
          options={[OPTIONS[0]!]}
          selectedOptionIds={new Set()}
          selectType="multi"
          onToggle={vi.fn()}
          sortable
        />
      </SortableWrapper>,
    )
    expect(
      screen.queryByRole('button', { name: /並べ替え:/ }),
    ).not.toBeInTheDocument()
    // main button は引き続き表示される (regression なし)
    expect(
      screen.getByRole('menuitemcheckbox', { name: '循環器' }),
    ).toBeInTheDocument()
  })

  it('sortable + items.length=0 → handle 非表示 (D-3 (a) ガード)', () => {
    render(
      <SortableWrapper items={[]}>
        <CardTagOptionList
          options={[]}
          selectedOptionIds={new Set()}
          selectType="multi"
          onToggle={vi.fn()}
          sortable
        />
      </SortableWrapper>,
    )
    expect(
      screen.queryByRole('button', { name: /並べ替え:/ }),
    ).not.toBeInTheDocument()
  })

  it('event 分離契約: handle button に dnd-kit attributes (aria-roledescription) が乗り、 main / kebab には乗らない', () => {
    render(
      <SortableWrapper items={OPTIONS.map((o) => o.id)}>
        <CardTagOptionList
          options={OPTIONS}
          selectedOptionIds={new Set()}
          selectType="multi"
          onToggle={vi.fn()}
          sortable
          onRowAction={vi.fn()}
        />
      </SortableWrapper>,
    )
    const handle = screen.getByRole('button', { name: 'optionを並べ替え: 循環器' })
    // dnd-kit が draggable 要素に必ず付与する属性で pin (`DraggableAttributes`
    // interface: role / aria-roledescription / aria-disabled / aria-pressed /
    // tabIndex / aria-describedby)。 handle に乗る。
    expect(handle).toHaveAttribute('aria-roledescription')
    expect(handle).toHaveAttribute('aria-disabled')

    // 同行の main button (循環器) には乗らない
    const main = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(main).not.toHaveAttribute('aria-roledescription')

    // 同行の kebab button (option 操作: 循環器) にも乗らない
    const kebab = screen.getByRole('button', { name: 'option 操作: 循環器' })
    expect(kebab).not.toHaveAttribute('aria-roledescription')
  })

  it('event 分離契約: handle button のみが touch-none class を持ち、 main / kebab は持たない', () => {
    render(
      <SortableWrapper items={OPTIONS.map((o) => o.id)}>
        <CardTagOptionList
          options={OPTIONS}
          selectedOptionIds={new Set()}
          selectType="multi"
          onToggle={vi.fn()}
          sortable
          onRowAction={vi.fn()}
        />
      </SortableWrapper>,
    )
    const handle = screen.getByRole('button', { name: 'optionを並べ替え: 循環器' })
    expect(handle.className).toContain('touch-none')

    const main = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(main.className).not.toContain('touch-none')

    const kebab = screen.getByRole('button', { name: 'option 操作: 循環器' })
    expect(kebab.className).not.toContain('touch-none')
  })

  it('drag と click の分離: main button の onClick (toggle) が通常 click で発火する (drag 起動しない)', () => {
    const onToggle = vi.fn()
    render(
      <SortableWrapper items={OPTIONS.map((o) => o.id)}>
        <CardTagOptionList
          options={OPTIONS}
          selectedOptionIds={new Set()}
          selectType="multi"
          onToggle={onToggle}
          sortable
        />
      </SortableWrapper>,
    )
    // sortable wrapper 配下でも main button の click は従来通り発火する
    // (drag 未起動の通常 click は影響なし = listeners は handle のみだから)。
    // 実 reorder dispatch は親 DndContext.onDragEnd 経路ゆえ、 本 component の
    // props に reorder callback は無く、 click でも drag 経路は何も呼ばれない。
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '腎臓' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('o2')
  })

  it('sortable モードでも既存 role / aria-checked / Check icon / kebab が維持される', () => {
    render(
      <SortableWrapper items={OPTIONS.map((o) => o.id)}>
        <CardTagOptionList
          options={OPTIONS}
          selectedOptionIds={new Set(['o1'])}
          selectType="multi"
          onToggle={vi.fn()}
          sortable
          onRowAction={vi.fn()}
        />
      </SortableWrapper>,
    )
    // role / aria-checked
    const main = screen.getByRole('menuitemcheckbox', { name: '循環器' })
    expect(main).toHaveAttribute('aria-checked', 'true')
    // Check icon (selected)
    expect(screen.getByTestId('check-o1')).toBeInTheDocument()
    // kebab
    expect(
      screen.getByRole('button', { name: 'option 操作: 循環器' }),
    ).toBeInTheDocument()
  })
})
