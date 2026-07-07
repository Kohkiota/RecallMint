// @vitest-environment jsdom
// TagCell unit test (Grid-1 T6) — 7 case + 1 integration smoke。
//
// mock 方針:
//   - CardTagAddPopover: vi.mock で軽量 stub。 props (initialStage / initialCategoryId /
//     trigger / onToggle) を data-attribute + children で expose し assert 可能にする。
//   - CardTagBadge: 実実装のまま動かす (visual only、 mock 不要)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { TagCell } from './exam-card-table-tag-cell'
import type { TagCellTag } from './exam-card-table-tag-cell'
import type { TagEditCallbacks } from './card-tags-section'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// P3 Task0 ②: TagCell が構築する cardId-bound createOptionAndAssign が、 実際に
// handleCreateOptionAndAssign を THIS row の cardId で呼ぶことを pin するため、
// underlying handler を spy 化する (他 export は実装のまま維持)。
const { mockHandleCreateOptionAndAssign } = vi.hoisted(() => ({
  mockHandleCreateOptionAndAssign: vi.fn(
    async (..._args: unknown[]): Promise<void> => undefined,
  ),
}))
vi.mock('./card-tags-section', async (importActual) => {
  const actual = await importActual<typeof import('./card-tags-section')>()
  return { ...actual, handleCreateOptionAndAssign: mockHandleCreateOptionAndAssign }
})

// CardTagAddPopover: stub として render し、 props を data-attribute で expose する。
// trigger を children として render することで trigger DOM が出る。
vi.mock('./card-tag-add-popover', () => ({
  CardTagAddPopover: ({
    initialStage,
    initialCategoryId,
    onToggle,
    tagEditCallbacks,
    trigger,
  }: {
    initialStage?: string
    initialCategoryId?: string | null
    onToggle: (categoryId: string, optionId: string) => void
    // P3 Task0 ②: cardId-bound override を検証するため tagEditCallbacks も expose する。
    tagEditCallbacks?: TagEditCallbacks
    trigger?: React.ReactNode
  }) => (
    <div
      data-testid="popover-stub"
      data-initial-stage={initialStage ?? ''}
      data-initial-category={initialCategoryId ?? ''}
      data-has-toggle={typeof onToggle === 'function' ? 'true' : 'false'}
      ref={(el) => {
        if (el) {
          ;(el as HTMLElement & { __onToggle?: typeof onToggle }).__onToggle = onToggle
          ;(
            el as HTMLElement & { __tagEditCallbacks?: TagEditCallbacks }
          ).__tagEditCallbacks = tagEditCallbacks
        }
      }}
    >
      {trigger}
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function makeCategory(
  id: string,
  name: string,
  sortKey: string | null = null,
): ClientTagCategory {
  return {
    id,
    user_id: 'u1',
    name,
    select_type: 'single',
    color: null,
    sort_key: sortKey,
    created_at: `2024-01-01T00:00:0${id.at(-1) ?? '0'}Z`,
    updated_at: `2024-01-01T00:00:0${id.at(-1) ?? '0'}Z`,
  }
}

function makeOption(
  id: string,
  categoryId: string,
  name: string,
  sortKey: string | null = null,
): ClientTagOption {
  return {
    id,
    user_id: 'u1',
    category_id: categoryId,
    name,
    color: null,
    sort_key: sortKey,
    created_at: `2024-01-01T00:00:0${id.at(-1) ?? '0'}Z`,
    updated_at: `2024-01-01T00:00:0${id.at(-1) ?? '0'}Z`,
  }
}

function makeTag(catId: string, optId: string): TagCellTag {
  return {
    category: makeCategory(catId, `Cat ${catId}`),
    option: makeOption(optId, catId, `Opt ${optId}`),
  }
}

const CARD_ID = 'card-test-1'
const MOCK_TOGGLE = vi.fn().mockResolvedValue(undefined)
const MOCK_TAG_EDIT_CALLBACKS = {
  renameCategory: vi.fn(),
  setCategoryColor: vi.fn(),
  deleteCategory: vi.fn(),
  renameOption: vi.fn(),
  setOptionColor: vi.fn(),
  deleteOption: vi.fn(),
  countCategoryImpact: vi.fn(),
  countOptionImpact: vi.fn(),
  createCategory: vi.fn(),
  createOptionAndAssign: vi.fn(),
}

function renderTagCell(tags: TagCellTag[]) {
  const allCategories = tags.map((t) => t.category)
  const allOptions = tags.map((t) => t.option)
  return render(
    <TagCell
      cardId={CARD_ID}
      userId="test-user-1"
      tags={tags}
      categories={allCategories}
      options={allOptions}
      toggle={MOCK_TOGGLE}
      tagEditCallbacks={MOCK_TAG_EDIT_CALLBACKS}
    />,
  )
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// case 1: タグ 0 件
// ===========================================================================

describe('TagCell case 1: タグ 0 件', () => {
  it('tags=[] で render → data-tag-count="0" + placeholder + button が 1 つ render される', () => {
    renderTagCell([])

    const cell = screen.getByTestId(`tag-cell-${CARD_ID}`)
    expect(cell).toHaveAttribute('data-tag-count', '0')

    // placeholder「+」button が 1 つ render される
    const addBtn = screen.getByRole('button', { name: 'タグを追加' })
    expect(addBtn).toBeInTheDocument()

    // popover stub が 1 つ、 initialStage 未指定 (empty)
    const stubs = screen.getAllByTestId('popover-stub')
    expect(stubs).toHaveLength(1)
    expect(stubs[0]).toHaveAttribute('data-initial-stage', '')

    // +N button は出ない
    expect(screen.queryByRole('button', { name: /他 .* タグ/ })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// case 2: タグ K-1 件 (= 4 件)
// ===========================================================================

describe('TagCell case 2: タグ 4 件 (K-1)', () => {
  it('tags=[4 件] → data-tag-count="4" + 4 個バッジ popover + +N なし', () => {
    const tags = [
      makeTag('c1', 'o1'),
      makeTag('c2', 'o2'),
      makeTag('c3', 'o3'),
      makeTag('c4', 'o4'),
    ]
    renderTagCell(tags)

    const cell = screen.getByTestId(`tag-cell-${CARD_ID}`)
    expect(cell).toHaveAttribute('data-tag-count', '4')

    // 4 popover stub (各バッジ分)
    const stubs = screen.getAllByTestId('popover-stub')
    expect(stubs).toHaveLength(4)

    // +N button は出ない
    expect(screen.queryByRole('button', { name: /他 .* タグ/ })).not.toBeInTheDocument()

    // placeholder も出ない
    expect(screen.queryByRole('button', { name: 'タグを追加' })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// case 3: タグ K+3 件 (= 8 件)
// ===========================================================================

describe('TagCell case 3: タグ 8 件 (K+3)', () => {
  it('tags=[8 件] → data-tag-count="8" + 先頭 5 個バッジ + +3 button', () => {
    const tags = Array.from({ length: 8 }, (_, i) =>
      makeTag(`c${i + 1}`, `o${i + 1}`),
    )
    renderTagCell(tags)

    const cell = screen.getByTestId(`tag-cell-${CARD_ID}`)
    expect(cell).toHaveAttribute('data-tag-count', '8')

    // popover stub は 5 (badge) + 1 (+N) = 6
    const stubs = screen.getAllByTestId('popover-stub')
    expect(stubs).toHaveLength(6)

    // +3 button が render される
    const plusNBtn = screen.getByRole('button', { name: '他 3 タグ' })
    expect(plusNBtn).toBeInTheDocument()

    // placeholder は出ない
    expect(screen.queryByRole('button', { name: 'タグを追加' })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// case 4: 既存バッジ click → popover が initialStage='option' + initialCategoryId で開く
// ===========================================================================

describe('TagCell case 4: 既存バッジ click', () => {
  it('バッジ button click → popover stub の data-initial-stage="option" + data-initial-category={category.id}', async () => {
    const cat = makeCategory('cat-a', 'Category A', '0')
    const opt = makeOption('opt-a', 'cat-a', 'Option A', '0')
    const tags: TagCellTag[] = [{ category: cat, option: opt }]

    renderTagCell(tags)

    // popover stub が render されており、 initialStage='option' + initialCategoryId='cat-a'
    const stub = screen.getByTestId('popover-stub')
    expect(stub).toHaveAttribute('data-initial-stage', 'option')
    expect(stub).toHaveAttribute('data-initial-category', 'cat-a')

    // stub 内の badge button を click (CardTagBadge の button — aria-label="タグ: ...")
    const badgeBtn = screen.getByRole('button', { name: /^タグ:/ })
    fireEvent.click(badgeBtn)

    // popover stub は既に render されており、 initialStage 属性が correct
    await waitFor(() => {
      expect(screen.getByTestId('popover-stub')).toHaveAttribute('data-initial-stage', 'option')
    })
  })
})

// ===========================================================================
// case 5: +N click → popover が initialStage 未指定 (= 'category') で開く
// ===========================================================================

describe('TagCell case 5: +N click', () => {
  it('+N button click → popover stub の data-initial-stage="" (未指定)', async () => {
    const tags = Array.from({ length: 8 }, (_, i) =>
      makeTag(`c${i + 1}`, `o${i + 1}`),
    )
    renderTagCell(tags)

    // +N の popover stub を特定: data-initial-stage="" かつ data-initial-category="" のもの (最後の stub)
    const stubs = screen.getAllByTestId('popover-stub')
    const plusNStub = stubs[stubs.length - 1]
    expect(plusNStub).toHaveAttribute('data-initial-stage', '')
    expect(plusNStub).toHaveAttribute('data-initial-category', '')

    // +N button を click
    const plusNBtn = screen.getByRole('button', { name: '他 3 タグ' })
    fireEvent.click(plusNBtn)

    // popover stub の属性は変わらない (stub は常時 mount)
    await waitFor(() => {
      expect(plusNStub).toHaveAttribute('data-initial-stage', '')
    })
  })
})

// ===========================================================================
// case 6: 空セル placeholder click → popover が initialStage 未指定で開く
// ===========================================================================

describe('TagCell case 6: 空セル placeholder click', () => {
  it('placeholder 「+」 button click → popover stub の data-initial-stage="" (未指定)', async () => {
    renderTagCell([])

    const stub = screen.getByTestId('popover-stub')
    expect(stub).toHaveAttribute('data-initial-stage', '')
    expect(stub).toHaveAttribute('data-initial-category', '')

    const addBtn = screen.getByRole('button', { name: 'タグを追加' })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(screen.getByTestId('popover-stub')).toHaveAttribute('data-initial-stage', '')
    })
  })
})

// ===========================================================================
// case 7: popover の onToggle callback → toggle(cardId, categoryId, optionId) が呼ばれる
// ===========================================================================

describe('TagCell case 7: popover onToggle → toggle spy', () => {
  it('popover stub の onToggle callback を呼ぶと MOCK_TOGGLE が (cardId, categoryId, optionId) で呼ばれる', async () => {
    const cat = makeCategory('cat-z', 'Category Z')
    const opt = makeOption('opt-z', 'cat-z', 'Option Z')
    const tags: TagCellTag[] = [{ category: cat, option: opt }]

    renderTagCell(tags)

    // popover stub から onToggle を取得し手動呼出
    const stub = screen.getByTestId('popover-stub')
    const onToggle = (stub as HTMLElement & { __onToggle?: (catId: string, optId: string) => void }).__onToggle
    expect(onToggle).toBeDefined()

    // onToggle を手動で呼ぶ (popover が実際に呼び出す経路をシミュレート)
    onToggle!('cat-z', 'opt-z')

    // toggle(cardId, categoryId, optionId) が呼ばれることを確認
    await waitFor(() => {
      expect(MOCK_TOGGLE).toHaveBeenCalledWith(CARD_ID, 'cat-z', 'opt-z')
    })
  })
})

// ===========================================================================
// integration smoke: TagCell + 実 useCardTagToggle + 実 Dexie → card_tags に row が追加される
// ===========================================================================

describe('TagCell integration smoke: toggle → Dexie card_tags 反映', () => {
  it('toggle() 呼出後 fake-indexeddb の card_tags に row が存在する', async () => {
    // fake-indexeddb は vitest.setup.ts で global セットアップ済
    const { getClientDb } = await import('@/lib/client-db')
    const { useCardTagToggle } = await import('../_hooks/use-card-tag-toggle')
    const { renderHook } = await import('@testing-library/react')

    const db = getClientDb()
    await db.cards.clear()
    await db.tag_categories.clear()
    await db.tag_options.clear()
    await db.card_tags.clear()

    const USER_ID = 'int-user-1'
    const CARD_ID_INT = 'int-card-1'

    const cat = makeCategory('int-cat-1', 'Int Category')
    const opt = makeOption('int-opt-1', 'int-cat-1', 'Int Option')

    // seed
    await db.tag_categories.put({ ...cat, user_id: USER_ID })
    await db.tag_options.put({ ...opt, user_id: USER_ID })

    // instantiate the real hook
    const { result } = renderHook(() =>
      useCardTagToggle({
        userId: USER_ID,
        getCardContext: (_cardId) => ({
          categories: [cat],
          options: [opt],
          allAssignedOptionIds: [],
        }),
      }),
    )

    // call toggle
    await result.current(CARD_ID_INT, 'int-cat-1', 'int-opt-1')

    // verify card_tags has the row
    const rows = await db.card_tags.where('card_id').equals(CARD_ID_INT).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].option_id).toBe('int-opt-1')

    // cleanup
    await db.cards.clear()
    await db.tag_categories.clear()
    await db.tag_options.clear()
    await db.card_tags.clear()
  })
})

// ===========================================================================
// P3 Task0 ②: TagCell cardId-bound createOptionAndAssign override
//
// impl: exam-card-table-tag-cell.tsx:111-126 の cardIdBoundCallbacks が
//   tagEditCallbacks.createOptionAndAssign を「THIS row の cardId を bind した closure」で
//   上書きする。 ExamCardTable レベルの createOptionAndAssignPlaceholder (no-op) が popover に
//   漏れないことを pin する。 override が消えると popover は placeholder no-op を受け取り
//   handleCreateOptionAndAssign が呼ばれない → 本 test の toHaveBeenCalled が FAIL する。
// ===========================================================================

describe('P3 Task0 ②: TagCell cardId-bound createOptionAndAssign override', () => {
  it('popover へ渡る createOptionAndAssign は THIS row の cardId で handleCreateOptionAndAssign を呼ぶ (placeholder no-op ではない)', async () => {
    mockHandleCreateOptionAndAssign.mockClear()

    const cat = makeCategory('cat-x', 'Category X')
    const opt = makeOption('opt-x', 'cat-x', 'Option X')
    renderTagCell([{ category: cat, option: opt }])

    // popover stub に降りた cardId-bound tagEditCallbacks を取り出す。
    const stub = screen.getByTestId('popover-stub')
    const callbacks = (
      stub as HTMLElement & { __tagEditCallbacks?: typeof MOCK_TAG_EDIT_CALLBACKS }
    ).__tagEditCallbacks
    expect(callbacks).toBeDefined()

    // popover が option 新規作成時に呼ぶ経路をシミュレート。
    await callbacks!.createOptionAndAssign('cat-x', 'NewOpt')

    // placeholder no-op ではなく、 THIS row の cardId を bind した handler が呼ばれる。
    // signature: handleCreateOptionAndAssign(userId, cardId, categories, options, cardTags, categoryId, name)
    expect(mockHandleCreateOptionAndAssign).toHaveBeenCalledTimes(1)
    const args = mockHandleCreateOptionAndAssign.mock.calls[0]
    expect(args[0]).toBe('test-user-1') // userId (renderTagCell の固定値)
    expect(args[1]).toBe(CARD_ID) // ← THIS row の cardId (placeholder は '' を使う)
    expect(args[5]).toBe('cat-x') // categoryId
    expect(args[6]).toBe('NewOpt') // name
    // cardId context: cardTags は THIS card の割当のみ (cardId が正しく閉じ込められている証拠)
    const cardTags = args[4] as Array<{ card_id: string; option_id: string }>
    expect(cardTags).toEqual([
      expect.objectContaining({ card_id: CARD_ID, option_id: 'opt-x' }),
    ])
  })
})
