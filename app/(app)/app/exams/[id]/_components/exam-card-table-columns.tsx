'use client'

// exam-card-table-columns — TanStack Table column defs for ExamCardTable。
// module スコープで定義 (component 内 useMemo 不使用)。
// 列順: [checkbox, 問題文(sticky), タグ(T6 TagCell)]。
//
// 'use client' は JSX を含む ColumnDef を使うため必要 (T2 学び: pure helper でも
// React component を含む場合は boundary が必要)。

import type { ColumnDef } from '@tanstack/react-table'
import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { ExamDetailCard } from '@/lib/exams/list'
import type { TagEditCallbacks } from './card-tags-section'
import type { ToggleFn } from '../_hooks/use-card-tag-toggle'
import { TagCell } from './exam-card-table-tag-cell'

export type ExamCardRow = {
  card: ExamDetailCard
  tags: Array<{ category: ClientTagCategory; option: ClientTagOption }>
}

/** TanStack Table meta 型。 table レベルで 1 回構築し、 columns の cell から参照する。 */
export type ExamCardTableMeta = {
  userId: string
  toggle: ToggleFn
  tagEditCallbacks: TagEditCallbacks
  categories: ClientTagCategory[]
  options: ClientTagOption[]
}

export const examCardTableColumns: ColumnDef<ExamCardRow>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <input
        type="checkbox"
        checked={table.getIsAllRowsSelected()}
        ref={(el) => {
          if (el) el.indeterminate = table.getIsSomeRowsSelected()
        }}
        onChange={table.getToggleAllRowsSelectedHandler()}
        aria-label="全選択"
      />
    ),
    cell: ({ row }) => (
      <input
        type="checkbox"
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
        aria-label={`行選択: ${row.original.card.title}`}
      />
    ),
    enableSorting: false,
  },
  {
    id: 'question',
    header: '問題文',
    accessorFn: (row) => row.card.questionText,
    cell: ({ row }) => (
      <div className="line-clamp-2">{row.original.card.questionText}</div>
    ),
    // 問題文列は第 1 列 pin。 sticky CSS は ExamCardTable 側の <th>/<td> で付与。
    // column def には meta だけ持たせ、 layout は render 側で解決する。
    meta: { sticky: true },
    enableSorting: false,
  },
  {
    id: 'tags',
    header: 'タグ',
    cell: ({ row, table }) => {
      const meta = table.options.meta as ExamCardTableMeta | undefined
      if (!meta) return null
      return (
        <TagCell
          cardId={row.original.card.id}
          userId={meta.userId}
          tags={row.original.tags}
          categories={meta.categories}
          options={meta.options}
          toggle={meta.toggle}
          tagEditCallbacks={meta.tagEditCallbacks}
        />
      )
    },
    enableSorting: false,
  },
]
