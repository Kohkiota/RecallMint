// ColumnHeaderMenu — S1-1: ヘッダーメニュー shell(並び替え節のみ)。
// capability-driven Popover: column.getCanSort() で並び替え節を出し分け、
// filterEditor が渡された時のみフィルタ節を render する(S1-3 で配線)。
// trigger = header label (aria-label="${label} の列メニュー")。
// sort 項目 = add-or-update (toggleSorting(desc, true) = isMulti=true)。
//   - 未追加列 → sorting 末尾に append。
//   - 追加済列 → direction を更新(重複 entry なし)。
// menu 項目 click 後は open state 制御で Popover を閉じる。
// filter editor 操作では閉じない(filterEditor 内の要素が自前で制御する)。
//
// 'use client' は不要: 親 ExamCardTable (= 'use client') からのみ import される子で
// boundary は親側で確立済(exam-card-table-column-toggle.tsx と同 pattern)。

import * as React from 'react'
import type { Column } from '@tanstack/react-table'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExamCardRow } from './exam-card-table-columns'

type ColumnHeaderMenuProps = {
  column: Column<ExamCardRow, unknown>
  label: string
  filterEditor?: React.ReactNode
}

export function ColumnHeaderMenu({
  column,
  label,
  filterEditor,
}: ColumnHeaderMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const canSort = column.getCanSort()

  const handleSort = (desc: boolean) => {
    // isMulti=true: 未追加なら末尾 append、追加済なら direction 更新(removal cycle なし — 明示 desc 値を渡すため)。
    column.toggleSorting(desc, true)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label} の列メニュー`}
          className="inline-flex items-center"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-36 p-1">
        <div className="flex flex-col">
          {canSort && (
            <>
              <button
                type="button"
                className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => handleSort(false)}
              >
                昇順
              </button>
              <button
                type="button"
                className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => handleSort(true)}
              >
                降順
              </button>
            </>
          )}
          {filterEditor}
        </div>
      </PopoverContent>
    </Popover>
  )
}
