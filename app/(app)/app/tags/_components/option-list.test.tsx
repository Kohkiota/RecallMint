// @vitest-environment jsdom
// OptionList client component の test。 右 column orchestrator。
// - active カテゴリ未選択時: 「カテゴリを選択してください」 placeholder
// - active カテゴリ配下の options を useLiveQuery で読み、 共有 `sortByKeyThenCreated`
//   (sort_key 数値昇順 + 同位 created_at ASC) で並べる (Tag-4c-2b §4.8)
// - 各 option を OptionRow に render
// - 削除フロー: OptionRow から onDelete callback → 影響範囲 (`db.card_tags
//   .where('option_id').equals(opt.id).count()`) → DeleteConfirmDialog 表示
//   → 確定で enqueueEntityMutation({entity_type:'tag_option', op:'delete'}) + flush
// - allCategories (カテゴリ変更 dropdown 用) も useLiveQuery で取得し OptionRow に伝播
//
// fake-indexeddb で実 Dexie を回し、 useLiveQuery で表示更新を確認。
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。

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

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
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

import { OptionList } from './option-list'

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
    render(<OptionList activeCategoryId={null} />)
    expect(
      await screen.findByText(/カテゴリを選択してください/),
    ).toBeInTheDocument()
  })

  it('active カテゴリ配下 0 件: create form は render される、 OptionRow は無し', async () => {
    await getClientDb().tag_categories.put(makeCategory('cat-a', '重要度'))

    render(<OptionList activeCategoryId="cat-a" />)
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

    render(<OptionList activeCategoryId="cat-a" />)
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

    render(<OptionList activeCategoryId="cat-a" />)
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

    render(<OptionList activeCategoryId="cat-a" />)
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

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('A の option')
    expect(screen.queryByText('B の option')).not.toBeInTheDocument()
  })
})

describe('OptionList — 削除フロー', () => {
  it('削除 button click → 影響範囲 (card_tags count) 集計し ConfirmDialog (option 用) が開く', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))
    await db.card_tags.bulkPut([
      makeCardTag('card-1', 'opt-1'),
      makeCardTag('card-2', 'opt-1'),
    ])

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))

    await screen.findByText(/option.*高.*削除しますか/)
    expect(screen.getByText(/2 件の card に紐付いています/)).toBeInTheDocument()
  })

  it('「削除する」 確定 → enqueue (tag_option / op=delete) + drain', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
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

  it('「キャンセル」 → enqueue を呼ばずダイアログが閉じる', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }))

    await waitFor(() => {
      expect(screen.queryByText(/option.*高.*削除しますか/)).not.toBeInTheDocument()
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })
})

describe('OptionList — optimistic cascade purge (削除確定時)', () => {
  it('削除確定で IDB から option + 紐付き card_tags が即時消滅', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory('cat-a', '重要度'))
    await db.tag_options.put(makeOption('opt-1', 'cat-a', '高'))
    await db.card_tags.bulkPut([
      makeCardTag('card-1', 'opt-1'),
      makeCardTag('card-2', 'opt-1'),
    ])

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

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

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'option 削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    await waitFor(() => {
      expect(cardTagWhereSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    // confirm 後の card_tags.where (cascade purge 開始点) は 最低 1 度発火する。
    // count 集計でも card_tags.where が呼ばれているため、 確定後の最後の呼出が
    // enqueue より先である事を確認するために最終 invocationCallOrder を比較する。
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

    render(<OptionList activeCategoryId="cat-a" />)
    await screen.findByText('高')

    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ変更' }))
    await screen.findByRole('menuitem', { name: '難易度' })
  })
})
