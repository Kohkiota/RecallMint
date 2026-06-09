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

const { mockEnqueue, mockFlush, mockNewId, realNewId } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  mockNewId: vi.fn<() => string>(),
  realNewId: { current: (): string => crypto.randomUUID() },
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  newId: mockNewId,
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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

  // Tag-4c-2b §4.8: 共有 `sortByKeyThenCreated` で数値順 sort される。 旧 string `<` 比較
  // だと `'0','1','10','2'` が `'0','1','10','2'` の lexicographic 順 (10 が 2 より前) で
  // 表示され誤順、 数値比較版は `0,1,2,10` の昇順に揃う。
  it('sort_key で数値順 (旧 string 比較なら fail する `0,1,2,10` の並び)', async () => {
    await getClientDb().tag_categories.bulkPut([
      makeCategory('cat-2', '弐', '2026-06-01T00:00:00.000Z', 'multi', '2'),
      makeCategory('cat-10', '拾', '2026-06-01T00:00:00.000Z', 'multi', '10'),
      makeCategory('cat-0', '零', '2026-06-01T00:00:00.000Z', 'multi', '0'),
      makeCategory('cat-1', '壱', '2026-06-01T00:00:00.000Z', 'multi', '1'),
    ])

    render(
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId="cat-a" onSelectCategory={vi.fn()} />,
    )
    await screen.findByText('A')

    // class に bg-slate-100 を含む row が 1 件のみ。
    // `[class~="bg-slate-100"]` は class 属性内の token 一致 (word boundary) で
    // `hover:bg-slate-100` 等の prefix 付き utility class とは区別される。
    const activeRows = container.querySelectorAll('[class~="bg-slate-100"]')
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
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
