'use client'

// CardTagBadge: 「カテゴリ名: option名」 + × button を持つバッジ。
// バッジ本体 click で onOpenEdit callback → 親 (CardTagEditPopover) が popover を開く。
// × span click で onRemove callback (stopPropagation で onOpenEdit は発火しない)。
//
// a11y:
//   - バッジ本体: <button aria-label="タグ: {cat}: {opt}">
//   - × span: role="button" tabIndex={0} aria-label="タグ削除: {cat}: {opt}"
//     (button 入れ子は HTML invalid のため span+role=button)
//   - × keyboard: Enter / Space で onRemove。stopPropagation でバッジ側へ伝播しない。
//
// forwardRef: Radix PopoverTrigger asChild が trigger の button に ref を attach できるよう
// forwardRef でラップする。 ref なしでは outside-click detection が trigger 境界を誤判定し、
// mousedown→mouseup で popover が即 close する (「無反応」 に見える)。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md §5

import * as React from 'react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { colorToClass } from '@/lib/tags/color-palette'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  category: ClientTagCategory
  option: ClientTagOption
  onRemove: () => void
  onOpenEdit: () => void
  /**
   * Radix PopoverTrigger asChild が注入する追加 onClick を受け取るため。
   * asChild は children の props を merge する際にこのフィールドを経由する。
   * 直接使用時は不要。
   */
  onClick?: React.MouseEventHandler<HTMLButtonElement>
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CardTagBadge = React.forwardRef<HTMLButtonElement, Props>(
  function CardTagBadge({ category, option, onRemove, onOpenEdit, onClick, ...rest }, ref) {
    const handleCloseKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.stopPropagation()
        e.preventDefault()
        onRemove()
      }
    }

    const handleCloseClick = (e: React.MouseEvent<HTMLSpanElement>) => {
      e.stopPropagation()
      onRemove()
    }

    return (
      <button
        ref={ref}
        type="button"
        aria-label={`タグ: ${category.name}: ${option.name}`}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
          colorToClass(option.color),
        )}
        onClick={(e) => {
          onOpenEdit()
          onClick?.(e)
        }}
        {...rest}
      >
        <span>
          {category.name}: {option.name}
        </span>
        <span
          role="button"
          aria-label={`タグ削除: ${category.name}: ${option.name}`}
          tabIndex={0}
          onClick={handleCloseClick}
          onKeyDown={handleCloseKeyDown}
          className="ml-0.5 hover:text-slate-900 cursor-pointer"
        >
          ×
        </span>
      </button>
    )
  },
)

CardTagBadge.displayName = 'CardTagBadge'
