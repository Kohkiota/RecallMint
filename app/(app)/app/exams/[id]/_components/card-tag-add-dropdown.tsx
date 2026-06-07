'use client'

// CardTagAddDropdown: card に option を追加する shadcn DropdownMenu。
// - trigger: 「タグ追加」 (Plus icon)
// - content: categoryOptions を menu item として一覧、 selected には check
// - selectType='multi' は item click で menu を閉じない (e.preventDefault)、
//   'single' は閉じる (preventDefault しない → radix default の close)
// - categoryOptions が 0 件のときは placeholder + /app/tags への link を出す
//
// 親 (Task 2: CardTagsRow) が optimistic + enqueue を担当するため、 本 component
// は onToggle の発火だけを責務とする (controlled / unselect 判定なし)。

import Link from 'next/link'
import { Plus, Check } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import type { ClientTagOption } from '@/lib/client-db'
import { colorToClass } from '@/lib/tags/color-palette'

type Props = {
  categoryOptions: ClientTagOption[]
  selectedOptionIds: Set<string>
  selectType: 'single' | 'multi'
  onToggle: (optionId: string) => void
}

export function CardTagAddDropdown({
  categoryOptions,
  selectedOptionIds,
  selectType,
  onToggle,
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="タグ追加"
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
      >
        <Plus className="w-3 h-3" />
        追加
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {categoryOptions.length === 0 ? (
          <div className="p-2 text-xs text-slate-500">
            このカテゴリには option がありません。{' '}
            <Link
              href="/app/tags"
              prefetch={false}
              className="text-slate-700 underline"
            >
              タグ管理 →
            </Link>
          </div>
        ) : (
          categoryOptions.map((opt) => {
            const selected = selectedOptionIds.has(opt.id)
            return (
              <DropdownMenuItem
                key={opt.id}
                onSelect={(e) => {
                  if (selectType === 'multi') {
                    e.preventDefault()
                  }
                  onToggle(opt.id)
                }}
                className="flex items-center gap-2"
              >
                <span
                  className={`inline-block w-3 h-3 rounded-full border ${colorToClass(opt.color)}`}
                />
                <span className="flex-1">{opt.name}</span>
                {selected ? (
                  <Check
                    data-testid="tag-check"
                    className="w-3 h-3 text-slate-700"
                  />
                ) : null}
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
