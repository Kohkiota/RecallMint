// @vitest-environment jsdom
// CategoryRow client component の test。
// 1 行のカテゴリ表示 + inline rename + 削除 button + select_type バッジ + active 表示。
// inline rename の patch shape (entity_type='tag_category' / op='update_field' /
// patch.field='name') と onSelect / onDelete callback 配線を固定する。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// rename の楽観反映は親 (useLiveQuery) 側で吸収するため、 本 test では Dexie 直書きは行わない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react'

import { getClientDb, type ClientTagCategory } from '@/lib/client-db'

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import { CategoryRow } from './category-row'

const baseCategory: ClientTagCategory = {
  id: 'cat-1',
  user_id: 'user-1',
  name: '重要度',
  select_type: 'multi',
  color: null,
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
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

describe('CategoryRow — 表示', () => {
  it('カテゴリ名を表示する', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('重要度')).toBeInTheDocument()
  })

  it('select_type バッジ (multi) を表示する', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('multi')).toBeInTheDocument()
  })

  it('select_type バッジ (single) を表示する', () => {
    render(
      <CategoryRow
        category={{ ...baseCategory, select_type: 'single' }}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('single')).toBeInTheDocument()
  })

  it('「削除」 button が描画される', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'カテゴリ削除' }),
    ).toBeInTheDocument()
  })

  it('pen icon button (aria-label="編集") が描画される (rename の明示 trigger)', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument()
  })

  it('editing=true 時は pen icon button が非表示 (input のみ)', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(
      screen.queryByRole('button', { name: '編集' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('active=true で背景クラス (bg-slate-100) を持つ', () => {
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={true}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/bg-slate-100/)
  })

  it('active=false で背景クラス (bg-slate-100) を持たない', () => {
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).not.toMatch(/bg-slate-100/)
  })
})

describe('CategoryRow — onSelect / onDelete callback', () => {
  it('row click で onSelect(category.id) が呼ばれる', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />,
    )
    // row 全体に onClick が乗る (Tag-4a-fix Task 2: name は static span、
    // pen icon button のみ rename trigger、 row click で active 切替)。
    const root = container.firstElementChild as HTMLElement
    fireEvent.click(root)
    expect(onSelect).toHaveBeenCalledWith('cat-1')
  })

  it('row 全体に role="button" + tabIndex=0 が付与される (a11y)', () => {
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.getAttribute('role')).toBe('button')
    expect(root.getAttribute('tabIndex')).toBe('0')
  })

  it('row への Enter キーで onSelect(category.id) が呼ばれる (a11y)', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('cat-1')
  })

  it('row への Space キーで onSelect(category.id) が呼ばれる (a11y)', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    fireEvent.keyDown(root, { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith('cat-1')
  })

  it('「削除」 button click で onDelete(category) が呼ばれ、 onSelect は呼ばれない', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ削除' }))
    expect(onDelete).toHaveBeenCalledWith(baseCategory)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('pen icon click で onSelect は呼ばれない (stopPropagation)', () => {
    const onSelect = vi.fn()
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('CategoryRow — inline rename', () => {
  it('pen icon click で edit mode に入り input に現値がセットされる', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input).toHaveValue('重要度')
  })

  it('rename input click は row click と独立 (onSelect は発火しない)', () => {
    const onSelect = vi.fn()
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    // pen icon click 自体で onSelect は発火しない (stopPropagation 確認)
    expect(onSelect).not.toHaveBeenCalled()
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.click(input)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('値変更 + blur で update_field mutation を enqueue + drain', async () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '優先度' } })
    fireEvent.blur(input)

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalledWith({
        entity_type: 'tag_category',
        entity_id: 'cat-1',
        op: 'update_field',
        patch: { field: 'name', value: '優先度' },
      })
    })
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalled()
    })
  })

  it('値変更なし blur では enqueue / drain を呼ばない', async () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)

    // 1 tick 待っても呼ばれない
    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it('空文字確定では enqueue しない (カテゴリ名 0 文字は不正、 元値復元)', async () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockFlush).not.toHaveBeenCalled()
    // display 復帰で元値表示
    expect(screen.getByText('重要度')).toBeInTheDocument()
  })

  it('Enter で確定 → enqueue + display 復帰', async () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '優先度' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await vi.waitFor(() => {
      expect(mockEnqueue).toHaveBeenCalled()
    })
  })

  it('Esc でキャンセル → enqueue しない、 display 復帰 (元値表示)', async () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '中断値' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
    // display 復帰
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('重要度')).toBeInTheDocument()
  })
})

describe('CategoryRow — optimistic IDB update (rename)', () => {
  it('rename 確定で IDB tag_categories.update が呼ばれ name + updated_at を bump', async () => {
    const db = getClientDb()
    await db.tag_categories.put(baseCategory)

    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '優先度' } })
    fireEvent.blur(input)

    await waitFor(async () => {
      const row = await db.tag_categories.get(baseCategory.id)
      expect(row?.name).toBe('優先度')
    })
    const row = await db.tag_categories.get(baseCategory.id)
    expect(row?.updated_at).not.toBe(baseCategory.updated_at)
  })

  it('IDB update が enqueueEntityMutation より先に呼ばれる (発行順序)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(baseCategory)
    const updateSpy = vi.spyOn(db.tag_categories, 'update')

    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '優先度' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalled()
    })
    const updateOrder = updateSpy.mock.invocationCallOrder[0]
    const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(enqueueOrder)
    updateSpy.mockRestore()
  })

  it('値変更なし blur では IDB update も呼ばない', async () => {
    const db = getClientDb()
    await db.tag_categories.put(baseCategory)
    const updateSpy = vi.spyOn(db.tag_categories, 'update')

    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)

    await Promise.resolve()
    expect(updateSpy).not.toHaveBeenCalled()
    updateSpy.mockRestore()
  })
})
