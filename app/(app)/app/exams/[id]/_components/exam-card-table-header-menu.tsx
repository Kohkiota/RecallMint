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
  // S2-6: trigger 内容全体(親が描画する label + filter dot + sort glyph)。
  // 未指定時は label 文字列のみを trigger 内に描画(単体 harness / 後方互換)。
  children?: React.ReactNode
  // S5-2: capability-driven 固定節(省略時は固定節を描画しない = 既存 test 後方互換)。
  // isBoundary=true → 「固定を解除」 / false → 「固定表示」。
  // 配置: 昇順/降順の下 ・ filterEditor の上。
  pinning?: { isBoundary: boolean; onSelect: () => void }
}

export function ColumnHeaderMenu({
  column,
  label,
  filterEditor,
  children,
  pinning,
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
        {/* S2-6: trigger を cell 全体化。 w-full + text-left で th 全幅を占め、
            label + dot + glyph(= children)のどこを押しても menu が開く。
            cursor-pointer / select-none は trigger button 側に集約(th からは撤去)。 */}
        <button
          type="button"
          aria-label={`${label} の列メニュー`}
          className="w-full inline-flex items-center gap-1 text-left cursor-pointer select-none"
        >
          {children ?? label}
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
          {/* S5-2: 固定節 — pinning prop が渡された列のみ描画 (capability-driven)。
              昇順/降順の下 ・ filterEditor の上に配置。sort 項目と同規約で click 後に close。 */}
          {pinning && (
            <button
              type="button"
              className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                pinning.onSelect()
                setOpen(false)
              }}
            >
              {pinning.isBoundary ? '固定を解除' : '固定表示'}
            </button>
          )}
          {filterEditor}
        </div>
      </PopoverContent>
    </Popover>
  )
}
