// @vitest-environment jsdom
// CardTagBadge: 「カテゴリ名: option名」 + × button + popover trigger の
// 各シナリオを pin する unit test。
// ファイル作成理由: Tag-4b-fix Task 3 にて新規追加されたバッジ表示 component のテスト。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { colorToClass } from '@/lib/tags/color-palette'

import { CardTagBadge } from './card-tag-badge'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const makeCategory = (
  overrides?: Partial<ClientTagCategory>,
): ClientTagCategory => ({
  id: 'cat-1',
  user_id: 'user-1',
  name: '分野',
  select_type: 'single',
  color: null,
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
  ...overrides,
})

const makeOption = (overrides?: Partial<ClientTagOption>): ClientTagOption => ({
  id: 'opt-1',
  user_id: 'user-1',
  category_id: 'cat-1',
  name: '循環器',
  color: 'red',
  sort_key: null,
  created_at: '2026-06-07T00:00:00.000Z',
  updated_at: '2026-06-07T00:00:00.000Z',
  ...overrides,
})

// ---------------------------------------------------------------------------
// 1. バッジ本体のテキスト表示
// ---------------------------------------------------------------------------

describe('CardTagBadge — テキスト表示', () => {
  it('「{カテゴリ名}: {option名}」 を表示する', () => {
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={vi.fn()}
        onOpenEdit={vi.fn()}
      />,
    )
    expect(screen.getByText('分野: 循環器')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 2. × button の aria-label
// ---------------------------------------------------------------------------

describe('CardTagBadge — × button a11y', () => {
  it('× span に aria-label が設定されている', () => {
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={vi.fn()}
        onOpenEdit={vi.fn()}
      />,
    )
    const closeBtn = screen.getByRole('button', {
      name: 'タグ削除: 分野: 循環器',
    })
    expect(closeBtn).toBeInTheDocument()
  })

  it('× span の tabIndex が 0 である', () => {
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={vi.fn()}
        onOpenEdit={vi.fn()}
      />,
    )
    const closeBtn = screen.getByRole('button', {
      name: 'タグ削除: 分野: 循環器',
    })
    expect(closeBtn).toHaveAttribute('tabindex', '0')
  })
})

// ---------------------------------------------------------------------------
// 3. バッジ本体 click で onOpenEdit が呼ばれる
// ---------------------------------------------------------------------------

describe('CardTagBadge — バッジ本体 click', () => {
  it('バッジ本体 click で onOpenEdit が 1 回呼ばれる', () => {
    const onOpenEdit = vi.fn()
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={vi.fn()}
        onOpenEdit={onOpenEdit}
      />,
    )
    // バッジ本体: aria-label で識別
    const badge = screen.getByRole('button', { name: 'タグ: 分野: 循環器' })
    fireEvent.click(badge)
    expect(onOpenEdit).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 4. × click で onRemove が呼ばれ、 onOpenEdit は呼ばれない
// ---------------------------------------------------------------------------

describe('CardTagBadge — × click の stopPropagation', () => {
  it('× click で onRemove が 1 回呼ばれる', () => {
    const onRemove = vi.fn()
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={onRemove}
        onOpenEdit={vi.fn()}
      />,
    )
    const closeBtn = screen.getByRole('button', {
      name: 'タグ削除: 分野: 循環器',
    })
    fireEvent.click(closeBtn)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('× click では onOpenEdit が呼ばれない (stopPropagation)', () => {
    const onOpenEdit = vi.fn()
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={vi.fn()}
        onOpenEdit={onOpenEdit}
      />,
    )
    const closeBtn = screen.getByRole('button', {
      name: 'タグ削除: 分野: 循環器',
    })
    fireEvent.click(closeBtn)
    expect(onOpenEdit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. キーボード: バッジ本体 Enter で onOpenEdit
// ---------------------------------------------------------------------------

describe('CardTagBadge — キーボード操作', () => {
  it('× span に Enter キーを押すと onRemove が呼ばれる', () => {
    const onRemove = vi.fn()
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={onRemove}
        onOpenEdit={vi.fn()}
      />,
    )
    const closeBtn = screen.getByRole('button', {
      name: 'タグ削除: 分野: 循環器',
    })
    fireEvent.keyDown(closeBtn, { key: 'Enter' })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('× span: Space で onRemove が呼ばれる (role="button" の ARIA 仕様)', () => {
    const onRemove = vi.fn()
    render(
      <CardTagBadge
        category={makeCategory()}
        option={makeOption()}
        onRemove={onRemove}
        onOpenEdit={vi.fn()}
      />,
    )
    const closeBtn = screen.getByRole('button', {
      name: 'タグ削除: 分野: 循環器',
    })
    fireEvent.keyDown(closeBtn, { key: ' ' })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 6. color class が className に含まれる
// ---------------------------------------------------------------------------

describe('CardTagBadge — color class', () => {
  it('option.color に対応する colorToClass の結果が className に含まれる', () => {
    const option = makeOption({ color: 'blue' })
    const expectedClass = colorToClass('blue')
    render(
      <CardTagBadge
        category={makeCategory()}
        option={option}
        onRemove={vi.fn()}
        onOpenEdit={vi.fn()}
      />,
    )
    const badge = screen.getByRole('button', { name: 'タグ: 分野: 循環器' })
    // colorToClass は複数クラスを返す可能性があるため、各クラスを個別チェック
    for (const cls of expectedClass.split(' ')) {
      if (cls) {
        expect(badge.className).toContain(cls)
      }
    }
  })
})
