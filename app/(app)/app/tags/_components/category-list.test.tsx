// @vitest-environment jsdom
// CategoryList client component の test。 左 column orchestrator。
// - useLiveQuery で db.tag_categories.orderBy('created_at').toArray() 直読
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
): ClientTagCategory {
  return {
    id,
    user_id: USER_ID,
    name,
    select_type: selectType,
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

  it('カテゴリ複数件: created_at ASC で並ぶ', async () => {
    await getClientDb().tag_categories.bulkPut([
      makeCategory('cat-b', 'B カテゴリ', '2026-06-02T00:00:00.000Z'),
      makeCategory('cat-a', 'A カテゴリ', '2026-06-01T00:00:00.000Z'),
      makeCategory('cat-c', 'C カテゴリ', '2026-06-03T00:00:00.000Z'),
    ])

    render(
      <CategoryList activeCategoryId={null} onSelectCategory={vi.fn()} />,
    )
    // 全 3 件描画 + created_at ASC で a, b, c の順
    await screen.findByText('A カテゴリ')
    await screen.findByText('B カテゴリ')
    await screen.findByText('C カテゴリ')

    const names = screen
      .getAllByRole('button', { name: 'カテゴリ名 編集' })
      .map((el) => el.textContent)
    expect(names).toEqual(['A カテゴリ', 'B カテゴリ', 'C カテゴリ'])
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

    // class に bg-slate-100 を含む row が 1 件のみ
    const activeRows = container.querySelectorAll('[class*="bg-slate-100"]')
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
