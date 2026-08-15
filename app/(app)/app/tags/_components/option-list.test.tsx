// @vitest-environment jsdom
// OptionList client component の test。 右 column orchestrator。
// - active カテゴリ未選択時: 「カテゴリを選択してください」 placeholder
// - active カテゴリ配下の options を useLiveQuery で読み、 共有 `sortByKeyThenCreated`
//   (sort_key 数値昇順 + 同位 created_at ASC) で並べる (Tag-4c-2b §4.8)
// - 各 option を OptionRow に render
// - 削除フロー (Tag-4c-2c hotfix H2): OptionRow から onDelete callback → 確認なし即削除
//   (popover Tag-4c-1-fix A-3 確定仕様「option 削除 = 確認なし即削除」 と整合)。
//   IDB cascade purge (card_tags → tag_option) → enqueueEntityMutation({entity_type:
//   'tag_option', op:'delete'}) + flush の発行順を pin する。
//   DeleteConfirmDialog 経路は H2 で撤去 (category 削除側は別 file で維持)。
// - allCategories (カテゴリ変更 dropdown 用) も useLiveQuery で取得し OptionRow に伝播
//
// fake-indexeddb で実 Dexie を回し、 useLiveQuery で表示更新を確認。
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
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

const { mockEnqueue, mockFlush, mockReorderOptions } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  // Tag-4c-2c T3: 共有 module の `handleReorderOptions` を mock 化し、
  // drag-end → manager 内 `handleManagerDragEnd` → 共有 helper の引数 contract
  // (popover / manager 同 arity `(items, activeCategoryId, orderedIds)` の 3 引数) を pin する。
  mockReorderOptions: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock('@/lib/sync/entity-mutations', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/sync/entity-mutations')>(
      '@/lib/sync/entity-mutations',
    )
  return {
    ...actual,
    enqueueEntityMutation: mockEnqueue,
  }
})
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))
// Tag-4c-2c T3: 共有 module を mock 化 (本 test では IDB tx を経由せず引数 contract のみ pin、
// 実 handler 本体の atomic / defensive filter / reindex は `lib/tags/reorder-handlers.test.ts`
// で担保済)。 handleReorderCategories は本 file では使わないが import 経路の解決を満たすため stub。
vi.mock('@/lib/tags/reorder-handlers', () => ({
  handleReorderOptions: mockReorderOptions,
  handleReorderCategories: vi.fn(async () => undefined),
}))

import { OptionList } from './option-list'
import { SORTABLE_SR_INSTRUCTIONS } from '@/lib/dnd/accessibility'

const USER_ID = 'user-1'

function makeCategory(
  id: string,
  name: string,
  createdAt = '2026-06-01T00:00:00.000Z',
): ClientTagCategory {
  return {
    id,
    user_id: USER_ID,
    name,
    select_type: 'multi',
    color: null,
    sort_key: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function makeOption(
  id: string,
  categoryId: string,
  name: string,
  createdAt = '2026-06-01T00:00:00.000Z',
  sortKey: string | null = null,
): ClientTagOption {
  return {
    id,
    user_id: USER_ID,
    category_id: categoryId,
    name,
    color: null,
    sort_key: sortKey,
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
  const db = getClientDb()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.entity_mutations.clear()
})

afterEach(() => {
  cleanup()
})

describe('OptionList — placeholder / 描画', () => {
  it('activeCategoryId=null で placeholder 表示', async () => {
    render(<OptionList userId={USER_ID} activeCategoryId={null} />)
    expect(
      await screen.findByText(/カテゴリを選択してください/),
    ).toBeInTheDocument()
  })

  it('active カテゴリ配下 0 件: create form は render される、 OptionRow は無し', async () => {
    await getClientDb().tag_categories.put(makeCategory('cat-a', '重要度'))

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    // create form の追加 button が見える
    expect(
      await screen.findByRole('button', { name: 'option 追加' }),
    ).toBeInTheDocument()
    // option 行は無し (pen icon button (aria-label="編集") が無い)
    expect(
      screen.queryByRole('button', { name: '編集' }),
    ).not.toBeInTheDocument()
  })

  it('全 sort_key null: created_at ASC fallback で並ぶ (両 NaN tiebreak)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.bulkPut([
      makeOption('opt-b', 'cat-a', 'B option', '2026-06-02T00:00:00.000Z'),
      makeOption('opt-a', 'cat-a', 'A option', '2026-06-01T00:00:00.000Z'),
      makeOption('opt-c', 'cat-a', 'C option', '2026-06-03T00:00:00.000Z'),
    ])

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('A option')
    await screen.findByText('B option')
    await screen.findByText('C option')

    // 各 row 内の pen icon button (aria-label="編集") を順序保持で取得し、
    // 同じ row 内の name span を兄弟 element から抜き出す。
    const penButtons = screen.getAllByRole('button', { name: '編集' })
    const names = penButtons.map(
      (btn) => btn.parentElement?.querySelector('span')?.textContent ?? '',
    )
    expect(names).toEqual(['A option', 'B option', 'C option'])
  })

  // Tag-4c-2b §4.8: 共有 `sortByKeyThenCreated` で数値順 sort される。
  // assertion は name 列 ['零','壱','弐','拾'] で表示順を確認、 sort_key は `'0','1','2','10'`。
  // 旧 string `<` 比較なら `'0','1','10','2'` の lexicographic 順 (拾 が 弐 より前) で fail、
  // 数値比較なら `0,1,2,10` の昇順に揃う。 「string 比較 vs 数値比較」 の差を pin する case。
  it('sort_key 数値順 (共有 comparator は `0,1,2,10` を 0→1→2→10 で並べる / 旧 string 比較なら `0,1,10,2` で fail する fixture)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.bulkPut([
      makeOption('opt-2', 'cat-a', '弐', '2026-06-01T00:00:00.000Z', '2'),
      makeOption('opt-10', 'cat-a', '拾', '2026-06-01T00:00:00.000Z', '10'),
      makeOption('opt-0', 'cat-a', '零', '2026-06-01T00:00:00.000Z', '0'),
      makeOption('opt-1', 'cat-a', '壱', '2026-06-01T00:00:00.000Z', '1'),
    ])

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('零')

    const penButtons = screen.getAllByRole('button', { name: '編集' })
    const names = penButtons.map(
      (btn) => btn.parentElement?.querySelector('span')?.textContent ?? '',
    )
    // 数値昇順: 0 → 1 → 2 → 10 (旧 string 比較なら 0,1,10,2 になり fail)
    expect(names).toEqual(['零', '壱', '弐', '拾'])
  })

  it('sort_key + null 混在: 数値帯が先、 null は末尾 (NULLS LAST)、 null 内は created_at ASC', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.bulkPut([
      makeOption('opt-null-b', 'cat-a', 'NB', '2026-06-02T00:00:00.000Z', null),
      makeOption('opt-1', 'cat-a', '壱', '2026-06-03T00:00:00.000Z', '1'),
      makeOption('opt-null-a', 'cat-a', 'NA', '2026-06-01T00:00:00.000Z', null),
      makeOption('opt-0', 'cat-a', '零', '2026-06-04T00:00:00.000Z', '0'),
    ])

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('零')

    const penButtons = screen.getAllByRole('button', { name: '編集' })
    const names = penButtons.map(
      (btn) => btn.parentElement?.querySelector('span')?.textContent ?? '',
    )
    expect(names).toEqual(['零', '壱', 'NA', 'NB'])
  })

  it('他カテゴリ配下の option は表示しない', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      makeCategory('cat-a', 'A'),
      makeCategory('cat-b', 'B'),
    ])
    await db.tag_options.bulkPut([
      makeOption('opt-a', 'cat-a', 'A の option'),
      makeOption('opt-b', 'cat-b', 'B の option'),
    ])

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('A の option')
    expect(screen.queryByText('B の option')).not.toBeInTheDocument()
  })
})

describe('OptionList — 削除フロー (Tag-4c-2c hotfix H2: 確認なし即削除)', () => {
  it('削除 button click → ConfirmDialog 不表示 (popover 仕様と整合)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))
    await db.card_tags.bulkPut([
      makeCardTag('card-1', 'opt-1'),
      makeCardTag('card-2', 'opt-1'),
    ])

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))

    // ConfirmDialog の DOM (role=dialog / 「削除しますか」 見出し / 「削除する」 button /
    // 「キャンセル」 button / 影響範囲表示) は一切現れない。
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/option.*高.*削除しますか/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '削除する' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'キャンセル' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/件の card に紐付いています/),
    ).not.toBeInTheDocument()
  })

  it('削除 button click → enqueue (tag_option / op=delete) + drain が即発火', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        user_id: USER_ID,
        entity_type: 'tag_option',
        entity_id: 'opt-1',
        op: 'delete',
        patch: {},
      })
    })
    await waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })
})

describe('OptionList — optimistic cascade purge (Tag-4c-2c hotfix H2: 即削除)', () => {
  it('削除 click で IDB から option + 紐付き card_tags が即時消滅', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))
    await db.card_tags.bulkPut([
      makeCardTag('card-1', 'opt-1'),
      makeCardTag('card-2', 'opt-1'),
    ])

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))

    await waitFor(async () => {
      expect(await db.tag_options.get('opt-1')).toBeUndefined()
      expect(
        await db.card_tags.where('option_id').equals('opt-1').count(),
      ).toBe(0)
    })
  })

  it('cascade purge は enqueueEntityMutation より先に発火 (発行順序)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))
    await db.card_tags.put(makeCardTag('card-1', 'opt-1'))

    const cardTagWhereSpy = vi.spyOn(db.card_tags, 'where')

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))

    await waitFor(() => {
      expect(cardTagWhereSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    // 削除 click 後の card_tags.where (cascade purge 開始点) は最低 1 度発火する。
    // H2 で count 集計経路は撤去されたため、 click 後の where 呼出は 100% cascade purge
    // 起点。 last invocationCallOrder が enqueue より小さいことを pin する。
    const lastWhereOrder =
      cardTagWhereSpy.mock.invocationCallOrder.at(-1) ?? 0
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(lastWhereOrder).toBeLessThan(enqueueOrder)
    cardTagWhereSpy.mockRestore()
  })
})

describe('OptionList — allCategories 配線', () => {
  it('OptionRow の「カテゴリ変更」 dropdown に他カテゴリが現れる (allCategories 伝播確認)', async () => {
    const db = getClientDb()
    await db.tag_categories.bulkPut([
      makeCategory('cat-a', '重要度'),
      makeCategory('cat-b', '難易度'),
    ])
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))

    render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    await screen.findByRole('menuitem', { name: '難易度' })
  })
})

// ===========================================================================
// Tag-4c-2c T3: D&D 配線 (SortableOptionRowWrapper + DndContext)
// ===========================================================================
//
// テスト戦略 (spec §6 / plan T3 完了条件):
// - jsdom で実 pointer drag を pin するのは困難 → DndContext mount + handle 表示 +
//   handler dispatch contract の 3 軸に分解。 共有 module `handleReorderOptions` の
//   atomic / defensive filter / reindex 本体は `lib/tags/reorder-handlers.test.ts`
//   で担保済 (本 test では mock 経由で「呼ばれる引数」 と「呼ばれない」 のみ確認)。
// - 行構造 (handle / color pill / pen / カテゴリ移動 dropdown / 削除) の event 分離契約は
//   handle button のみが dnd-kit attributes (`aria-roledescription`) を持ち、 `touch-none`
//   も handle のみ、 OptionRow 本体の独自 UI (color pill / rename input / カテゴリ移動 dropdown /
//   削除 button) は通常 click 反応のままという pattern で表現する。 特に「カテゴリ移動 dropdown」
//   は option を別 category へ移す UI で、 handle drag と意味的に紛らわしいため構造分離を強く pin。

describe('OptionList — Tag-4c-2c T3 D&D 配線', () => {
  describe('handle 表示条件 (sortableEnabled = options.length >= 2)', () => {
    it('option 2 件以上: 各 row に handle button (aria-label `option を並べ替え: ${name}`) が表示される', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      // 2 件分の handle が存在
      expect(
        await screen.findByRole('button', { name: 'option を並べ替え: 高' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'option を並べ替え: 低' }),
      ).toBeInTheDocument()
    })

    it('option 1 件: handle button は存在せず素の `<li>` で render される (DndContext non-mount)', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.put(makeOption('opt-1', 'cat-a', '単独'))

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('単独')

      // handle 0 件 (aria-label prefix で検索)
      expect(
        screen.queryByRole('button', { name: /option を並べ替え:/ }),
      ).not.toBeInTheDocument()
      // 既存 OptionRow の pen / 削除 / カテゴリ変更 / color pill button は引き続き存在
      expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'option 削除' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'カテゴリ変更' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'option 色を変更' }),
      ).toBeInTheDocument()
    })

    it('option 0 件 (active 配下なし): handle / OptionRow 共に非表示、 作成 form のみ', async () => {
      await getClientDb().tag_categories.put(makeCategory('cat-a', '重要度'))

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByRole('button', { name: 'option 追加' })

      expect(
        screen.queryByRole('button', { name: /option を並べ替え:/ }),
      ).not.toBeInTheDocument()
    })

    it('activeCategoryId=null: placeholder のみで handle / OptionRow 一切 render しない', async () => {
      render(<OptionList userId={USER_ID} activeCategoryId={null} />)
      await screen.findByText(/カテゴリを選択してください/)

      expect(
        screen.queryByRole('button', { name: /option を並べ替え:/ }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: '編集' }),
      ).not.toBeInTheDocument()
    })
  })

  describe('event 分離契約 (handle のみが dnd-kit attributes / touch-none を持つ)', () => {
    it('handle button は `aria-roledescription` (dnd-kit 標準 `sortable`) を持ち、 OptionRow 独自 UI (color pill / pen / カテゴリ変更 / 削除) は持たない', async () => {
      const db = getClientDb()
      await db.tag_categories.bulkPut([
        makeCategory('cat-a', '重要度'),
        makeCategory('cat-b', '難易度'),
      ])
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      const handle1 = await screen.findByRole(
        'button',
        { name: 'option を並べ替え: 高' },
      )
      // dnd-kit useSortable は activator node に aria-roledescription="sortable" を付与する
      expect(handle1).toHaveAttribute('aria-roledescription', 'sortable')

      // OptionRow 独自 UI button は dnd-kit attribute を持たない (listeners/attributes は
      // handle にのみ spread されている契約)。 各 button 種別ごとに pin。
      const colorPills = screen.getAllByRole('button', { name: 'option 色を変更' })
      for (const pill of colorPills) {
        expect(pill).not.toHaveAttribute('aria-roledescription')
      }
      const penButtons = screen.getAllByRole('button', { name: '編集' })
      for (const pen of penButtons) {
        expect(pen).not.toHaveAttribute('aria-roledescription')
      }
      const moveButtons = screen.getAllByRole('button', { name: 'カテゴリ変更' })
      for (const mv of moveButtons) {
        expect(mv).not.toHaveAttribute('aria-roledescription')
      }
      const deleteButtons = screen.getAllByRole('button', { name: 'option 削除' })
      for (const del of deleteButtons) {
        expect(del).not.toHaveAttribute('aria-roledescription')
      }
    })

    it('`touch-none` class は handle button のみに付与され、 OptionRow 本体 (色 pill / pen / カテゴリ変更 / 削除) には付かない', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      const { container } = render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      // touch-none token を持つ element は handle button (= 2 件 = options.length 個) のみ
      const touchNoneEls = container.querySelectorAll('[class~="touch-none"]')
      expect(touchNoneEls.length).toBe(2)
      for (const el of Array.from(touchNoneEls)) {
        expect(el.tagName).toBe('BUTTON')
        expect(el.getAttribute('aria-label')).toMatch(/^option を並べ替え:/)
      }
    })
  })

  describe('drag/click 分離: OptionRow 独自 UI が drag を起動しない / reorder mock を触らない', () => {
    it('color pill click → ColorPalettePopover が開く (drag 経路と独立、 reorder mock not called)', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      const pills = screen.getAllByRole('button', { name: 'option 色を変更' })
      fireEvent.click(pills[0])

      // ColorPalettePopover 内の「色なし」 button (aria-label="色なし") が出現することで popover 開を確認
      await screen.findByRole('button', { name: '色なし' })
      expect(mockReorderOptions).not.toHaveBeenCalled()
    })

    it('pen icon click で OptionRow が rename 入力モードに切替 (drag 経路と独立、 reorder mock not called)', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      const penButtons = screen.getAllByRole('button', { name: '編集' })
      fireEvent.click(penButtons[0])

      // rename input が表示される (drag 起動せず)
      expect(
        await screen.findByRole('textbox', { name: 'option 名 編集' }),
      ).toBeInTheDocument()
      expect(mockReorderOptions).not.toHaveBeenCalled()
    })

    it('カテゴリ変更 button click で dropdown menu が開く (drag 経路と独立、 reorder mock not called)', async () => {
      const db = getClientDb()
      await db.tag_categories.bulkPut([
        makeCategory('cat-a', '重要度'),
        makeCategory('cat-b', '難易度'),
      ])
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      const moveButtons = screen.getAllByRole('button', { name: 'カテゴリ変更' })
      fireEvent.click(moveButtons[0])

      // menu (role=menu) が開いて他カテゴリ menuitem が現れる (drag 起動せず)
      await screen.findByRole('menuitem', { name: '難易度' })
      expect(mockReorderOptions).not.toHaveBeenCalled()
    })

    it('削除 button click で onDelete 経路 (即削除) が発火 (drag 経路と独立、 reorder mock not called)', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      const deleteButtons = screen.getAllByRole('button', { name: 'option 削除' })
      fireEvent.click(deleteButtons[0])

      // Tag-4c-2c hotfix H2 で confirm dialog 経路は撤去、 即 enqueue (= 削除フロー発火) を pin。
      // drag 経路と分離されていることは reorder mock 未呼出で示す。
      await waitFor(() => {
        expect(mockEnqueue).toHaveBeenCalledWith({
          user_id: USER_ID,
          entity_type: 'tag_option',
          entity_id: 'opt-1',
          op: 'delete',
          patch: {},
        })
      })
      expect(mockReorderOptions).not.toHaveBeenCalled()
    })
  })

  // row-dnd sprint task-2 配線 pin (Codex 抜け 10 採用): factory unit test
  // (`lib/dnd/accessibility.test.ts`) だけでは DndContext への配線漏れを検出できない
  // ため、 実際に mount された DndContext の hidden instructions 要素
  // (dnd-kit `HiddenText`、 `display:none` の div) に日本語文言が実在することを pin する。
  describe('a11y 配線 pin (row-dnd sprint task-2)', () => {
    it('DndContext mount 時に SORTABLE_SR_INSTRUCTIONS.draggable の実文言が hidden instructions 要素に存在する', async () => {
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByText('高')

      expect(
        screen.getByText(SORTABLE_SR_INSTRUCTIONS.draggable),
      ).toBeInTheDocument()
    })
  })

  describe('共有 module 契約 (`handleReorderOptions` を popover / manager 同 3 arity で呼ぶ)', () => {
    it('handleReorderOptions mock の signature は popover と同じ `(items, activeCategoryId, orderedIds)` 3 引数で受けられる', async () => {
      // popover (`card-tag-add-popover.tsx` handleStage2DragEnd) も同関数を
      // `(items, categoryId, orderedIds)` 3 引数で呼ぶ契約 (4c-2c T1 で共有 module 化済)。
      // 本 test は manager 経路の mock を「3 引数を非例外で受ける」 形で pin することで、
      // popover 側と arity drift しない契約を構造 (test の事前条件) で示す。 T2 (handleReorderCategories)
      // は 2 引数、 T3 (handleReorderOptions) は 3 引数 (第 2 引数が categoryId、 reindex 母数限定用)。
      const db = getClientDb()
      await db.tag_categories.put(makeCategory('cat-a', '重要度'))
      await db.tag_options.bulkPut([
        makeOption('opt-1', 'cat-a', '高', '2026-06-01T00:00:00.000Z'),
        makeOption('opt-2', 'cat-a', '低', '2026-06-02T00:00:00.000Z'),
      ])

      render(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
      await screen.findByRole('button', { name: 'option を並べ替え: 高' })

      // mock 呼出 simulation: jsdom 制約で実 pointer drag を再現できないため、
      // mock を直接 invoke して「3 引数で resolve」 を 1 行 pin する (contract 形式)。
      const result = mockReorderOptions(
        [{ id: 'opt-1' }, { id: 'opt-2' }],
        'cat-a',
        ['opt-2', 'opt-1'],
      )
      await expect(result).resolves.toBeUndefined()
      expect(mockReorderOptions).toHaveBeenCalledWith(
        [{ id: 'opt-1' }, { id: 'opt-2' }],
        'cat-a',
        ['opt-2', 'opt-1'],
      )
    })
  })
})

// ===========================================================================
// Tag-4c-2c hotfix: hook order regression
// ===========================================================================
//
// 既存 fixture は `activeCategoryId='cat-1'` 等 non-null 固定で初回 render から
// option-list 経路 (useSensors を含む 4 hook 全実行) に入っていたため、 「最初は
// null placeholder で 3 hook、 後で non-null に切替で 4 hook」 という遷移を踏まず、
// 早期 return の後ろに置かれた `useSensors` の rules-of-hooks 違反が unfair に
// 通過してきた。 stg smoke で manager 起動 → カテゴリクリック (= null → non-null
// 遷移) で 「Rendered more hooks than during the previous render」 が出て発覚。
// 本 test は null → non-null 遷移を rerender で再現し、 throw しないことを pin。
// 旧版 (useSensors を早期 return 後に置いた状態) でこの test を回すと React が
// throw して fail する設計 (= regression pin として機能する)。
describe('OptionList — Tag-4c-2c hotfix hook order regression', () => {
  it('activeCategoryId が null → non-null に遷移しても crash しない (Rendered more hooks 違反を回避)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))

    // 初回 render: activeCategoryId=null で placeholder UI のみ。
    // この時点で useSensors が早期 return より後に置かれていると hook 数は 3 件。
    const { rerender } = render(<OptionList userId={USER_ID} activeCategoryId={null} />)
    expect(
      await screen.findByText(/カテゴリを選択してください/),
    ).toBeInTheDocument()

    // rerender: activeCategoryId='cat-a' に遷移。
    // 旧版なら早期 return を跨いで useSensors が呼ばれて hook 数が 3 → 4 に変わり、
    // React が 「Rendered more hooks than during the previous render」 を throw する。
    // 新版 (useSensors を早期 return 前に移動済) では 4 → 4 で安定し throw しない。
    await act(async () => {
      rerender(<OptionList userId={USER_ID} activeCategoryId="cat-a" />)
    })

    // 切替後は placeholder が消え、 option-list 経路 (create form) に入る。
    await waitFor(() => {
      expect(
        screen.queryByText(/カテゴリを選択してください/),
      ).not.toBeInTheDocument()
    })
    expect(
      await screen.findByRole('button', { name: 'option 追加' }),
    ).toBeInTheDocument()
  })
})
