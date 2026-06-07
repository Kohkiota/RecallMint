// @vitest-environment jsdom
// OptionList client component の test。 右 column orchestrator。
// - active カテゴリ未選択時: 「カテゴリを選択してください」 placeholder
// - active カテゴリ配下の options を useLiveQuery で読み、 created_at ASC sort
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
    // option 行は無し (option 名 編集 button が無い)
    expect(
      screen.queryByRole('button', { name: 'option 名 編集' }),
    ).not.toBeInTheDocument()
  })

  it('active カテゴリ配下 複数件: created_at ASC で並ぶ', async () => {
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

    const names = screen
      .getAllByRole('button', { name: 'option 名 編集' })
      .map((el) => el.textContent)
    expect(names).toEqual(['A option', 'B option', 'C option'])
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
