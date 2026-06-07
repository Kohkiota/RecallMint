// @vitest-environment jsdom
// CardTagPill: 1 つのタグ pill を name + color + × ボタンで表示する presentational
// component の test。 onRemove callback の発火と aria-label を固定する。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import type { ClientTagOption } from '@/lib/client-db'

import { CardTagPill } from './card-tag-pill'

const baseOption: ClientTagOption = {
  id: 'opt-1',
  user_id: 'user-1',
  category_id: 'cat-1',
  name: '高',
  color: 'red',
  sort_key: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
})

describe('CardTagPill', () => {
  it('option.name を表示する', () => {
    render(<CardTagPill option={baseOption} onRemove={vi.fn()} />)
    expect(screen.getByText('高')).toBeInTheDocument()
  })

  it('option.color に応じた Tailwind class が pill に付く', () => {
    const { container } = render(
      <CardTagPill option={baseOption} onRemove={vi.fn()} />,
    )
    const root = container.firstElementChild as HTMLElement
    // colorToClass('red') === 'bg-red-100 text-red-800 border-red-200'
    expect(root.className).toMatch(/bg-red-100/)
    expect(root.className).toMatch(/text-red-800/)
    expect(root.className).toMatch(/border-red-200/)
  })

  it('color=null は fallback (bg-slate-100) になる', () => {
    const { container } = render(
      <CardTagPill
        option={{ ...baseOption, color: null }}
        onRemove={vi.fn()}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/bg-slate-100/)
  })

  it('× button の aria-label は「タグ削除: {name}」', () => {
    render(<CardTagPill option={baseOption} onRemove={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'タグ削除: 高' }),
    ).toBeInTheDocument()
  })

  it('× button click で onRemove() が呼ばれる', () => {
    const onRemove = vi.fn()
    render(<CardTagPill option={baseOption} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'タグ削除: 高' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
