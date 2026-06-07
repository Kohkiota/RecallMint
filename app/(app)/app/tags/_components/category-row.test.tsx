// @vitest-environment jsdom
// CategoryRow client component の test。
// 1 行のカテゴリ表示 + inline rename + 削除 button + select_type バッジ + active 表示。
// inline rename の patch shape (entity_type='tag_category' / op='update_field' /
// patch.field='name') と onSelect / onDelete callback 配線を固定する。
//
// enqueueEntityMutation / runGuardedEntityMutationFlush は spy mock。
// rename の楽観反映は親 (useLiveQuery) 側で吸収するため、 本 test では Dexie 直書きは行わない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagCategory } from '@/lib/client-db'

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

beforeEach(() => {
  vi.clearAllMocks()
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
  it('row click (空白領域) で onSelect(category.id) が呼ばれる', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />,
    )
    // row 全体に onClick が乗る (rename input click は伝播 stop で除外)。
    // 名前 button click は edit mode に入るため、 row 直下の wrapper を直叩きする
    // (select_type バッジ周辺 = 空白領域 click を再現)。
    const root = container.firstElementChild as HTMLElement
    fireEvent.click(root)
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
})

describe('CategoryRow — inline rename', () => {
  it('カテゴリ名 click で edit mode に入り input に現値がセットされる', () => {
    render(
      <CategoryRow
        category={baseCategory}
        active={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'カテゴリ名 編集' }))
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
