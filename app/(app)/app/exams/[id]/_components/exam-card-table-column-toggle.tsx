// ColumnVisibilityToggle — Edit-2 Task 4: 試験詳細テーブルの列表示/非表示 popover。
// table.getAllLeafColumns() を列挙し、 各列の getIsVisible() / toggleVisibility() を
// checkbox に bind する。 select 列 (全選択 checkbox) は常時表示なので toggle 対象外。
// 永続化は ExamCardTable 側の columnVisibility effect が担う (本 component は state 操作のみ)。
//
// 'use client' は付けない: 親 ExamCardTable (= 'use client') からのみ import される子で
// boundary は親側で確立済。 file 自体に付けると Next.js TS plugin が function 型 prop
// (table) を Server Action prop として誤検出する (ConditionBar と同 pattern)。

import * as React from 'react'
import { SlidersHorizontal } from 'lucide-react'
import type { Table } from '@tanstack/react-table'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExamCardRow } from './exam-card-table-columns'

export function ColumnVisibilityToggle({
  table,
}: {
  table: Table<ExamCardRow>
}): React.JSX.Element {
  // select 列は常時表示 (全選択 checkbox) なので除外。 getCanHide() で hide 不可列も除外。
  const toggleableColumns = table
    .getAllLeafColumns()
    .filter((column) => column.id !== 'select' && column.getCanHide())

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="列の表示・非表示"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        >
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          列
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56">
        <div className="flex flex-col gap-0.5">
          {toggleableColumns.map((column) => {
            // header が string のときはそれをラベルに、 それ以外 (JSX header) は id を使う。
            const label =
              typeof column.columnDef.header === 'string'
                ? column.columnDef.header
                : column.id
            return (
              <label
                key={column.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={(e) => column.toggleVisibility(e.target.checked)}
                  aria-label={`列表示: ${label}`}
                />
                <span>{label}</span>
              </label>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
