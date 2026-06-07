'use client'

// CardTagEditPopover: バッジ click で開く単 stage 編集 popover。
// children (= CardTagBadge) を PopoverTrigger asChild として受け取り、
// クリックで該当カテゴリの option 一覧を表示する。
//
// 内部 state (open / setOpen) で popover 開閉を管理。
// onClose を CardTagOptionList に渡し、 single 選択時に setOpen(false) を呼ぶ。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md §3/§5

import * as React from 'react'
import Link from 'next/link'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { CardTagOptionList } from './card-tag-option-list'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  category: ClientTagCategory
  /** 当該カテゴリ配下の全 option (created_at ASC 推奨) */
  categoryOptions: ClientTagOption[]
  /** 当該カテゴリで付与済みの option_id set */
  selectedOptionIds: Set<string>
  /** option toggle callback。 parent (Task 5 section) で (optionId) => onToggle(cat.id, optionId) に bind */
  onToggle: (optionId: string) => void
  /** trigger element (CardTagBadge)。 asChild で Radix trigger と merge される */
  children: React.ReactNode
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagEditPopover({
  category,
  categoryOptions,
  selectedOptionIds,
  onToggle,
  children,
}: Props) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto max-w-sm p-0">
        {/* header */}
        <div className="border-b px-3 py-2 text-sm font-medium text-slate-700">
          {category.name} を編集
        </div>
        {/* option list */}
        <div className="py-1">
          <CardTagOptionList
            options={categoryOptions}
            selectedOptionIds={selectedOptionIds}
            selectType={category.select_type}
            onToggle={onToggle}
            onClose={() => setOpen(false)}
          />
        </div>
        {/* footer: tag manager link (option が 1 件以上のときのみ表示。
            0 件のときは CardTagOptionList 内の placeholder に link が含まれる) */}
        {categoryOptions.length > 0 && (
          <div className="border-t px-3 py-2">
            <Link
              href="/app/tags"
              prefetch={false}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              タグ管理 →
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
