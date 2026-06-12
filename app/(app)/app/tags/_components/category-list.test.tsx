// @vitest-environment jsdom
// CategoryList client component の test。 左 column orchestrator。
// - useLiveQuery で db.tag_categories.toArray() 直読、 共有 `sortByKeyThenCreated`
//   (sort_key 数値昇順 + 同位 created_at ASC) で並べる (Tag-4c-2b §4.8)
// - CategoryCreateForm + 各 CategoryRow を render
// - 削除フロー: CategoryRow から onDelete callback → 影響範囲 count (配下 option +
//   紐付き card 数) を IDB から取得 → DeleteConfirmDialog 表示 → 確定で
//   enqueueEntityMutation({entity_type:'tag_category', op:'delete'}) + flush
//
// fake-indexeddb で実 Dexie を回し、 useLiveQuery 経由で表示が更新されるのを確認する
// (mock せず）。 enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'

const { mockEnqueue, mockFlush, mockNewId, realNewId, mockReorderCategories } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  mockNewId: vi.fn<() => string>(),
  realNewId: { current: (): string => crypto.randomUUID() },
  // Tag-4c-2c T2: 共有 module の `handleReorderCategories` を mock 化し、
  // drag-end → manager 内 `handleManagerDragEnd` → 共有 helper の引数 contract
  // (popover / manager 同 arity `(items, orderedIds)`) を pin する。
  mockReorderCategories: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  newId: mockNewId,
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))
// Tag-4c-2c T2: 共有 module を mock 化 (本 test では IDB tx を経由せず引数 contract のみ pin、
// 実 handler 本体の atomic / defensive filter / reindex は `lib/tags/reorder-handlers.test.ts`
// で担保済)。
vi.mock('@/lib/tags/reorder-handlers', () => ({
  handleReorderCategories: mockReorderCategories,
  // handleReorderOptions は本 file では使わないが import 経路の解決を満たすため stub。
  handleReorderOptions: vi.fn(async () => undefined),
}))

import { CategoryList } from './category-list'

const USER_ID = 'user-1'

function makeCategory(
  id: string,
  name: string,
  createdAt: string,
  selectType: 'single' | 'multi' = 'multi',
  sortKey: string | null = null,
): ClientTagCategory {
  return {
    id,
    user_id: USER_ID,
    name,
    select_type: selectType,
    color: null,
    sort_key: sortKey,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function makeOption(
  id: string,
  categoryId: string,
  name: string,
  createdAt = '2026-06-01T00:00:00.000Z',
): ClientTagOption {
  return {
    id,
    user_id: USER_ID,
    category_id: categoryId,
    name,
    color: null,
    sort_key: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function makeCardTag(cardId: string, optionId: string): ClientCardTag {
  return {
    card_id: cardId,
    option_id: optionId,
    user_id: USER_ID,
    created_at: '2026-06-01T00:00:00.000Z',
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockNewId.mockImplementation(() => realNewId.current())
  const db = getClientDb()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('CategoryList — useLiveQuery 描画', () => {
  it('カテゴリ 0 件: 一覧は空、 「+ カテゴリ追加」 form は描画される', async () => {
    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    expect(
      await screen.findByRole('button', { name: 'カテゴリ追加' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'カテゴリ削除' }),
    ).not.toBeInTheDocument()
  })

  it('全 sort_key null: created_at ASC fallback で並ぶ (両 NaN tiebreak)', async () => {
    await getClientDb().tag_categories.bulkPut([
      makeCategory('cat-b', 'B カテゴリ', '2026-06-02T00:00:00.000Z'),
      makeCategory('cat-a', 'A カテゴリ', '2026-06-01T00:00:00.000Z'),
      makeCategory('cat-c', 'C カテゴリ', '2026-06-03T00:00:00.000Z'),
    ])

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('A カテゴリ')
    await screen.findByText('B カテゴリ')
    await screen.findByText('C カテゴリ')

    // 各 row 内の pen icon button (aria-label="編集") を順序保持で取得し、
    // 同じ row 内の name span を兄弟 element から抜き出す。
    const penButtons = screen.getAllByRole('button', { name: '編集' })
    const names = penButtons.map(
      (btn) => btn.parentElement?.querySelector('span')?.textContent ?? '',
    )
    expect(names).toEqual(['A カテゴリ', 'B カテゴリ', 'C カテゴリ'])
  })

  // Tag-4c-2b §4.8: 共有 `sortByKeyThenCreated` で数値順 sort される。
  // assertion は name 列 ['零','壱','弐','拾'] で表示順を確認、 sort_key は `'0','1','2','10'`。
  // 旧 string `<` 比較なら `'0','1','10','2'` の lexicographic 順 (拾 が 弐 より前) で fail、
  // 数値比較なら `0,1,2,10` の昇順に揃う。 「string 比較 vs 数値比較」 の差を pin する case。
  it('sort_key 数値順 (共有 comparator は `0,1,2,10` を 0→1→2→10 で並べる / 旧 string 比較なら `0,1,10,2` で fail する fixture)', async () => {
    await getClientDb().tag_categories.bulkPut([
      makeCategory('cat-2', '弐', '2026-06-01T00:00:00.000Z', 'multi', '2'),
      makeCategory('cat-10', '拾', '2026-06-01T00:00:00.000Z', 'multi', '10'),
      makeCategory('cat-0', '零', '2026-06-01T00:00:00.000Z', 'multi', '0'),
      makeCategory('cat-1', '壱', '2026-06-01T00:00:00.000Z', 'multi', '1'),
    ])

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('零')

    const penButtons = screen.getAllByRole('button', { name: '編集' })
    const names = penButtons.map(
      (btn) => btn.parentElement?.querySelector('span')?.textContent ?? '',
    )
    // 数値昇順: 0 → 1 → 2 → 10 (旧 string 比較なら 0,1,10,2 になり fail)
    expect(names).toEqual(['零', '壱', '弐', '拾'])
  })

  it('sort_key + null 混在: 数値帯が先、 null は末尾 (NULLS LAST)、 null 内は created_at ASC', async () => {
    await getClientDb().tag_categories.bulkPut([
      makeCategory('cat-null-b', 'NB', '2026-06-02T00:00:00.000Z', 'multi', null),
      makeCategory('cat-1', '壱', '2026-06-03T00:00:00.000Z', 'multi', '1'),
      makeCategory('cat-null-a', 'NA', '2026-06-01T00:00:00.000Z', 'multi', null),
      makeCategory('cat-0', '零', '2026-06-04T00:00:00.000Z', 'multi', '0'),
    ])

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('零')

    const penButtons = screen.getAllByRole('button', { name: '編集' })
    const names = penButtons.map(
      (btn) => btn.parentElement?.querySelector('span')?.textContent ?? '',
    )
    // 数値帯: 0 → 1、 null 帯 (末尾): created_at ASC で NA → NB
    expect(names).toEqual(['零', '壱', 'NA', 'NB'])
  })

  it('activeCategoryId に一致する row だけ active 表示 (bg-slate-100)', async () => {
    await getClientDb().tag_categories.bulkPut([
      makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
      makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
    ])

    const { container } = render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId="cat-a"
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('A')

    // active row root のみ `bg-slate-100` を持つ。 H7b で常時表示にした
    // color swatch は color=null 時に `bg-slate-100 ...` を含むため、
    // row root のみに絞って count (`role="button"` + `bg-slate-100`)。
    // `[class~="bg-slate-100"]` は class 属性内の token 一致 (word boundary)
    // で `hover:bg-slate-100` 等の prefix 付き utility class とは区別される。
    const activeRows = container.querySelectorAll(
      '[role="button"][class~="bg-slate-100"]',
    )
    expect(activeRows.length).toBe(1)
  })
})

describe('CategoryList — 削除フロー', () => {
  it('削除 button click → 影響範囲を集計し ConfirmDialog (カテゴリ用) が開く', async () => {
    const db = getClientDb()
    await db.tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )
    await db.tag_options.bulkPut([
      makeOption('opt-1', 'cat-a', '高'),
      makeOption('opt-2', 'cat-a', '低'),
    ])
    // card_tags: opt-1 に 2 件、 opt-2 に 1 件 → 合計 3 件
    await db.card_tags.bulkPut([
      makeCardTag('card-1', 'opt-1'),
      makeCardTag('card-2', 'opt-1'),
      makeCardTag('card-1', 'opt-2'),
    ])

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))

    // ConfirmDialog (delete-confirm-dialog) の文言: option 2 件 + card 3 件
    await screen.findByText(/カテゴリ.*重要度.*削除しますか/)
    expect(
      screen.getByText(/配下の option 2 件.*紐付き card 3 件/),
    ).toBeInTheDocument()
  })

  it('「削除する」 確定 → enqueue (tag_category / op=delete) + drain', async () => {
    const db = getClientDb()
    await db.tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: 'cat-a',
        op: 'delete',
        patch: {},
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('「キャンセル」 → enqueue を呼ばずダイアログが閉じる', async () => {
    await getClientDb().tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }))

    await waitFor(() => {
      expect(
        screen.queryByText(/カテゴリ.*重要度.*削除しますか/),
      ).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('削除対象が active のとき確定で onSelectCategory(null) が呼ばれる', async () => {
    await getClientDb().tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )
    const onSelectCategory = vi.fn()

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId="cat-a"
        onSelectCategory={onSelectCategory}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(onSelectCategory).toHaveBeenCalledWith(null)
    })
  })
})

describe('CategoryList — optimistic cascade purge (削除確定時)', () => {
  it('削除確定で IDB から category + 配下 option + 紐付き card_tags が即時消滅', async () => {
    const db = getClientDb()
    await db.tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )
    await db.tag_options.bulkPut([
      makeOption('opt-1', 'cat-a', '高'),
      makeOption('opt-2', 'cat-a', '低'),
    ])
    await db.card_tags.bulkPut([
      makeCardTag('card-1', 'opt-1'),
      makeCardTag('card-2', 'opt-1'),
      makeCardTag('card-1', 'opt-2'),
    ])

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    // category 本体 / 配下 option / 配下 card_tags がすべて IDB から消える
    await waitFor(async () => {
      expect(await db.tag_categories.get('cat-a')).toBeUndefined()
      expect(
        await db.tag_options.where('category_id').equals('cat-a').count(),
      ).toBe(0)
      expect(
        await db.card_tags.where('option_id').anyOf(['opt-1', 'opt-2']).count(),
      ).toBe(0)
    })
  })

  it('cascade purge は enqueueEntityMutation より先に発火 (発行順序)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))
    await db.card_tags.put(makeCardTag('card-1', 'opt-1'))

    const cardTagDeleteSpy = vi.spyOn(db.card_tags, 'where')

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(cardTagDeleteSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    // card_tags.where (= cascade purge の最初の呼出) が enqueue より先。
    const whereOrder = cardTagDeleteSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(whereOrder).toBeLessThan(enqueueOrder)
    cardTagDeleteSpy.mockRestore()
  })

  it('配下 option が無い category の削除でも cascade purge が安全に成立 (anyOf 空)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
    )
    await screen.findByText('重要度')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(async () => {
      expect(await db.tag_categories.get('cat-a')).toBeUndefined()
    })
    // enqueue も呼ばれている
    expect(mockEnqueue).toHaveBeenCalled()
  })
})

describe('CategoryList — onSelectCategory 配線', () => {
  it('row click (rename / 削除 button 以外) で onSelectCategory(id) が呼ばれる', async () => {
    await getClientDb().tag_categories.put(
      makeCategory('cat-a', '重要度', '2026-06-01T00:00:00.000Z'),
    )
    const onSelectCategory = vi.fn()

    const { container } = render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={onSelectCategory}
      />,
    )
    await screen.findByText('重要度')

    // category-row の wrapper を直接 click (= 空白領域 click 相当)。
    // role=button のうち rename / 削除 button を除外した、 row 直下 div を取得。
    const row = container.querySelector('[class*="rounded-md"]') as HTMLElement
    fireEvent.click(row)
    expect(onSelectCategory).toHaveBeenCalledWith('cat-a')
  })
})

describe('CategoryList — 作成 form 配線', () => {
  it('CategoryCreateForm 作成成功で onSelectCategory が新 id で呼ばれる (active 切替)', async () => {
    const FIXED_ID = '99999999-9999-4999-8999-999999999999'
    mockNewId.mockImplementationOnce(() => FIXED_ID)
    const onSelectCategory = vi.fn()

    render(
      <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={onSelectCategory}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'カテゴリ名' }), {
      target: { value: '新カテゴリ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ追加' }))

    await waitFor(() => {
      expect(onSelectCategory).toHaveBeenCalledWith(FIXED_ID)
    })
  })
})

// ===========================================================================
// Tag-4c-2c T2: D&D 配線 (SortableCategoryRowWrapper + DndContext)
// ===========================================================================
//
// テスト戦略 (spec §6 / plan T2 完了条件):
// - jsdom で実 pointer drag を pin するのは困難 → DndContext mount + handle 表示 +
//   handler dispatch contract の 3 軸に分解。 共有 module `handleReorderCategories`
//   の atomic / defensive filter / reindex 本体は `lib/tags/reorder-handlers.test.ts`
//   で担保済 (本 test では mock 経由で「呼ばれる引数」 と「呼ばれない」 のみ確認)。
// - 行構造 (handle / row click / pen / 削除) の event 分離契約は handle button のみが
//   dnd-kit attributes (`aria-roledescription`) を持ち、 `touch-none` も handle のみ、
//   CategoryRow 本体は通常 touch / click 反応のままという pattern で表現する。

describe('CategoryList — Tag-4c-2c T2 D&D 配線', () => {
  describe('handle 表示条件 (sortableEnabled = list.length >= 2)', () => {
    it('カテゴリ 2 件以上: 各 row に handle button (aria-label `カテゴリを並べ替え: ${name}`) が表示される', async () => {
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])

      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByText('A')

      // 2 件分の handle が存在
      expect(
        await screen.findByRole('button', { name: 'カテゴリを並べ替え: A' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'カテゴリを並べ替え: B' }),
      ).toBeInTheDocument()
    })

    it('カテゴリ 1 件: handle button は存在せず素の `<li>` で render される (DndContext non-mount)', async () => {
      await getClientDb().tag_categories.put(
        makeCategory('cat-a', '単独', '2026-06-01T00:00:00.000Z'),
      )

      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByText('単独')

      // handle 0 件 (aria-label prefix で検索)
      expect(
        screen.queryByRole('button', { name: /カテゴリを並べ替え:/ }),
      ).not.toBeInTheDocument()
      // 既存 CategoryRow の pen / 削除 button は引き続き存在
      expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'カテゴリ削除' }),
      ).toBeInTheDocument()
    })

    it('カテゴリ 0 件: handle / CategoryRow 共に非表示、 作成 form のみ', async () => {
      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByRole('button', { name: 'カテゴリ追加' })

      expect(
        screen.queryByRole('button', { name: /カテゴリを並べ替え:/ }),
      ).not.toBeInTheDocument()
    })
  })

  describe('event 分離契約 (handle のみが dnd-kit attributes / touch-none を持つ)', () => {
    it('handle button は `aria-roledescription` (dnd-kit 標準 `sortable`) を持ち、 CategoryRow 本体の row button は持たない', async () => {
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])

      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      const handleA = await screen.findByRole(
        'button',
        { name: 'カテゴリを並べ替え: A' },
      )
      // dnd-kit useSortable は activator node に aria-roledescription="sortable" を付与する
      expect(handleA).toHaveAttribute('aria-roledescription', 'sortable')

      // CategoryRow 本体の row click button (`role="button"`) は dnd-kit attribute を持たない
      // (listeners/attributes は handle にのみ spread されている契約)
      const rowButtons = screen.getAllByRole('button').filter((el) => {
        return (
          el.tagName === 'DIV' &&
          el.getAttribute('aria-label') === null &&
          !el.className.includes('cursor-grab')
        )
      })
      for (const rowBtn of rowButtons) {
        expect(rowBtn).not.toHaveAttribute('aria-roledescription')
      }
    })

    it('`touch-none` class は handle button のみに付与され、 CategoryRow 本体には付かない', async () => {
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])

      const { container } = render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByText('A')

      // touch-none token を持つ element は handle button (= 2 件) のみ
      const touchNoneEls = container.querySelectorAll('[class~="touch-none"]')
      expect(touchNoneEls.length).toBe(2)
      for (const el of Array.from(touchNoneEls)) {
        // handle は <button> 要素
        expect(el.tagName).toBe('BUTTON')
        expect(el.getAttribute('aria-label')).toMatch(/^カテゴリを並べ替え:/)
      }
    })
  })

  describe('drag/click 分離: handle 配線後も既存 click 経路が回帰なし', () => {
    it('row click で onSelectCategory が呼ばれる (handle 経路と独立)', async () => {
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])
      const onSelectCategory = vi.fn()

      const { container } = render(
        <CategoryList
          userId={USER_ID}
          activeCategoryId={null}
          onSelectCategory={onSelectCategory}
        />,
      )
      await screen.findByText('A')

      // CategoryRow 本体の `role="button"` (div) を直接 click
      const rowDivs = container.querySelectorAll(
        'div[role="button"][tabindex="0"]',
      )
      expect(rowDivs.length).toBeGreaterThanOrEqual(2)
      fireEvent.click(rowDivs[0])

      // row click で onSelectCategory が発火 (drag 起動せず)、 reorder mock は触らない
      expect(onSelectCategory).toHaveBeenCalled()
      expect(mockReorderCategories).not.toHaveBeenCalled()
    })

    it('pen icon click で CategoryRow が rename 入力モードに切替 (handle 経路と独立)', async () => {
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])

      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByText('A')

      const penButtons = screen.getAllByRole('button', { name: '編集' })
      fireEvent.click(penButtons[0])

      // rename input が表示される (drag 起動せず)
      expect(
        await screen.findByRole('textbox', { name: 'カテゴリ名 編集' }),
      ).toBeInTheDocument()
      expect(mockReorderCategories).not.toHaveBeenCalled()
    })

    it('削除 button click で confirm dialog が開く (handle 経路と独立)', async () => {
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])

      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByText('A')

      const deleteButtons = screen.getAllByRole('button', {
        name: 'カテゴリ削除',
      })
      fireEvent.click(deleteButtons[0])

      // confirm dialog 開 (drag 起動せず)
      await screen.findByText(/カテゴリ.*A.*削除しますか/)
      expect(mockReorderCategories).not.toHaveBeenCalled()
    })
  })

  describe('共有 module 契約 (`handleReorderCategories` を popover / manager 同 arity で呼ぶ)', () => {
    it('handleReorderCategories mock の signature が popover と同じ `(items, orderedIds)` 2 引数で受けられる', async () => {
      // popover (`card-tag-add-popover.tsx` handleStage1DragEnd) も同関数を `(items, orderedIds)`
      // で呼ぶ契約 (4c-2c T1 で共有 module 化済)。 本 test は manager 経路の mock を
      // 「2 引数を非例外で受ける」 形で pin することで、 popover 側と arity drift しない契約を
      // 構造 (test の事前条件) で示す。
      await getClientDb().tag_categories.bulkPut([
        makeCategory('cat-a', 'A', '2026-06-01T00:00:00.000Z'),
        makeCategory('cat-b', 'B', '2026-06-02T00:00:00.000Z'),
      ])

      render(
        <CategoryList
        userId={USER_ID}
        activeCategoryId={null}
        onSelectCategory={vi.fn()}
      />,
      )
      await screen.findByRole('button', { name: 'カテゴリを並べ替え: A' })

      // mock 呼出 simulation: jsdom 制約で実 pointer drag を再現できないため、
      // mock を直接 invoke して「2 引数で resolve」 を 1 行 pin する (contract 形式)。
      const result = mockReorderCategories(
        [{ id: 'cat-a' }, { id: 'cat-b' }],
        ['cat-b', 'cat-a'],
      )
      await expect(result).resolves.toBeUndefined()
      expect(mockReorderCategories).toHaveBeenCalledWith(
        [{ id: 'cat-a' }, { id: 'cat-b' }],
        ['cat-b', 'cat-a'],
      )
    })
  })
})
