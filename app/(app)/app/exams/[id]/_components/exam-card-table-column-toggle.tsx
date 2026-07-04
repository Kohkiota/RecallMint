// ColumnVisibilityToggle — 試験詳細テーブルの列表示/非表示 popover。
// S2-5: controlled 化。 live `table` instance ではなく静的列メタ (examCardTableColumns から
// 導出) を列挙し、 columnVisibility / onColumnVisibilityChange を controlled prop で受ける。
// 永続・state 所有は exam-detail-view.tsx が単一所有 (本 component は表示 + toggle 通知のみ)。
//
// 'use client' は付けない: 親 (= 'use client') からのみ import される子で boundary は親側で
// 確立済。 file 自体に付けると Next.js TS plugin が function 型 prop (onColumnVisibilityChange)
// を Server Action prop として誤検出する (ConditionBar / 旧実装と同 pattern)。

import * as React from 'react'
import { SlidersHorizontal } from 'lucide-react'
import type { ColumnDef, OnChangeFn, VisibilityState } from '@tanstack/react-table'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'

/** 列トグルが表示する列メタ (live table instance 非依存)。 */
export type ColumnToggleMeta = { id: string; label: string; hideable: boolean }

/**
 * ColumnDef 配列から列トグル用メタを導出する (S2-5 interface 凍結節の規約)。
 * - select 列は除外 (全選択 checkbox は常時表示)。
 * - label = header が string ならそれ、 非 string (JSX header) は id fallback。
 * - hideable = enableHiding !== false (getCanHide() 相当)。
 * 将来 columns.tsx に列が追加されても examCardTableColumns 経由で自動的に載る。
 */
export function deriveColumnToggleMeta(
  columns: ColumnDef<ExamCardRow>[],
): ColumnToggleMeta[] {
  return columns
    .filter((column) => column.id !== 'select')
    .map((column) => ({
      id: column.id as string,
      label:
        typeof column.header === 'string'
          ? column.header
          : (column.id as string),
      hideable: column.enableHiding !== false,
    }))
}

export function ColumnVisibilityToggle({
  columnVisibility,
  onColumnVisibilityChange,
}: {
  columnVisibility: VisibilityState
  onColumnVisibilityChange: OnChangeFn<VisibilityState>
}): React.JSX.Element {
  // 静的列メタから hideable 列のみを列挙 (select 除外は derive 内、 非 hideable はここで除外)。
  const toggleableColumns = deriveColumnToggleMeta(examCardTableColumns).filter(
    (meta) => meta.hideable,
  )

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
          {toggleableColumns.map((meta) => {
            // checked = 可視 (columnVisibility[id] !== false)。 hidden 列のみ false が入る。
            const checked = columnVisibility[meta.id] !== false
            return (
              <label
                key={meta.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    onColumnVisibilityChange({
                      ...columnVisibility,
                      [meta.id]: e.target.checked,
                    })
                  }
                  aria-label={`列表示: ${meta.label}`}
                />
                <span>{meta.label}</span>
              </label>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
