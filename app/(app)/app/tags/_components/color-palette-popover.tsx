'use client'

// tag 色選択用の popover。 children を Popover trigger としてそのまま受け、
// open 時に 4×4 (実質 13 cell: 12 色 + 1「色なし」) の grid を表示する。
// 1 cell click で onChange(color | null) → 即 Popover を閉じる。
//
// なぜ全 cell を固定 class で書くか: Tailwind v4 の class 検出は静的解析のため、
// 動的構成 (`bg-${color}-500`) は purge で消える。 cell の bg は color-palette.ts
// の COLOR_TO_CLASS 経由で固定文字列として埋め込み、 build 時に必ず検出される。

import * as React from 'react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  TAG_COLOR_NAMES,
  COLOR_TO_CLASS,
  COLOR_NULL_CLASS,
  type TagColorName,
} from '@/lib/tags/color-palette'

type Props = {
  value: TagColorName | null
  onChange: (color: TagColorName | null) => void
  // Popover trigger に差し込む要素 (pill button 等)。 asChild 経由で渡す。
  children: React.ReactNode
}

export function ColorPalettePopover({ value, onChange, children }: Props) {
  const [open, setOpen] = React.useState(false)

  const handleSelect = (next: TagColorName | null) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div
          role="group"
          aria-label="タグの色を選択"
          className="grid grid-cols-4 gap-1.5"
        >
          {TAG_COLOR_NAMES.map((name) => {
            const selected = value === name
            return (
              <button
                key={name}
                type="button"
                aria-label={`色: ${name}`}
                aria-pressed={selected}
                onClick={() => handleSelect(name)}
                className={cn(
                  'h-7 w-7 rounded-md border transition-all',
                  COLOR_TO_CLASS[name],
                  selected
                    ? 'ring-2 ring-offset-1 ring-foreground'
                    : 'hover:scale-110',
                )}
              />
            )
          })}
          {/* 「色なし」 cell: 斜線 + neutral grey で識別。 */}
          <button
            type="button"
            aria-label="色なし"
            aria-pressed={value === null}
            onClick={() => handleSelect(null)}
            className={cn(
              'relative h-7 w-7 rounded-md border transition-all',
              COLOR_NULL_CLASS,
              value === null
                ? 'ring-2 ring-offset-1 ring-foreground'
                : 'hover:scale-110',
            )}
          >
            {/* 視覚的に「無し」 を示す斜線 (aria は label で補う)。 */}
            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center text-slate-500"
            >
              {/* SVG 斜線。 cell 内 28px に合わせる。 */}
              <svg
                viewBox="0 0 24 24"
                className="h-full w-full"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="4" y1="20" x2="20" y2="4" />
              </svg>
            </span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
