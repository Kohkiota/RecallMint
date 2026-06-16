'use client'

// ExamCardTable — TanStack Table 最小構成。
// 案 X-A: ExamCardTable 内で独自 useLiveQuery を呼ぶ (InlineCardList と subscription を共有しない)。
// view='table' 時のみ mount (OQ-5 案 S-A / conditional unmount) されるため、
// 同時刻に 1 subscription のみ = spec §9 の「二重 subscription にしない」を構造的に保証。
//
// OQ-3 案 J-A: join シェイプ = flat array { card, tags: { category, option }[] }。
// join は useLiveQuery 解決時に 1 回、useMemo で ref 安定化 (TanStack 参照不安定対策の核)。

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type RowSelectionState,
} from '@tanstack/react-table'
import { getClientDb } from '@/lib/client-db'
import { toExamDetailCard, sortLikeServer } from './inline-card-list'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'

type ExamCardTableProps = {
  examId: string
  userId: string
}

export function ExamCardTable({ examId, userId }: ExamCardTableProps) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})

  // useLiveQuery: 案 X-A。 4 store (cards / tag_categories / tag_options / card_tags) を
  // 1 subscription で一括 pull。 InlineCardList の useLiveQuery と同パターンを踏襲
  // (T-B5 最適化: card_tags は filteredCards の card_id 集合だけに絞って fetch)。
  // view='table' 時のみ mount されるため、 view='card' 時は InlineCardList の subscription
  // のみが生存 = 同時刻に 2 subscription にならない (OQ-5 案 S-A で構造的に保証)。
  const liveData = useLiveQuery(async () => {
    const db = getClientDb()
    const [cardRows, categories, options] = await Promise.all([
      db.cards.where('exam_id').equals(examId).toArray(),
      db.tag_categories.toArray(),
      db.tag_options.toArray(),
    ])
    const filteredCards = cardRows
      .filter((c) => c.user_id === userId)
      .sort(sortLikeServer)
    const pageCardIds = filteredCards.map((c) => c.id)
    const cardTags =
      pageCardIds.length === 0
        ? []
        : await db.card_tags.where('card_id').anyOf(pageCardIds).toArray()
    return { filteredCards, categories, options, cardTags }
  }, [examId, userId])

  // join (OQ-3 案 J-A): useLiveQuery 解決時に 1 回 join + useMemo で ref 安定化。
  // data prop ref が不安定だと TanStack 参照不安定で再描画暴発するため、
  // useMemo は smoke ③ 対策の核。 deps = liveData (オブジェクト ref) で
  // 同じオブジェクト ref ならキャッシュ再利用 = 余分な TanStack 更新なし。
  const data = useMemo<ExamCardRow[]>(() => {
    if (!liveData) return []
    const { filteredCards, categories, options, cardTags } = liveData
    const tagsByCardId = new Map<string, ExamCardRow['tags']>()
    for (const ct of cardTags) {
      const option = options.find((o) => o.id === ct.option_id)
      if (!option) continue
      const category = categories.find((c) => c.id === option.category_id)
      if (!category) continue
      const arr = tagsByCardId.get(ct.card_id) ?? []
      arr.push({ category, option })
      tagsByCardId.set(ct.card_id, arr)
    }
    return filteredCards.map((c) => ({
      card: toExamDetailCard(c),
      tags: tagsByCardId.get(c.id) ?? [],
    }))
  }, [liveData])

  // TanStack table instance。 columns は module スコープ参照 (再採番なし)。
  // enableRowSelection: true + getRowId で card.id を row id とする。
  // rowSelection は controlled state (useState) で持つ。
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table の useReactTable は React Compiler 非対応 API だが、TanStack 側の既知 tradeoff であり抑止が推奨方針
  const table = useReactTable<ExamCardRow>({
    data,
    columns: examCardTableColumns,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    getRowId: (row) => row.card.id,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
  })

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-border">
              {hg.headers.map((h) => {
                const isSticky =
                  (h.column.columnDef.meta as { sticky?: boolean } | undefined)
                    ?.sticky === true
                return (
                  <th
                    key={h.id}
                    className={[
                      'px-3 py-2 text-left font-medium text-muted-foreground',
                      isSticky
                        ? 'sticky left-0 z-10 bg-background'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              data-testid={`row-${row.original.card.id}`}
              className="border-b border-border hover:bg-muted/50"
            >
              {row.getVisibleCells().map((cell) => {
                const isSticky =
                  (
                    cell.column.columnDef.meta as
                      | { sticky?: boolean }
                      | undefined
                  )?.sticky === true
                return (
                  <td
                    key={cell.id}
                    className={[
                      'px-3 py-2',
                      isSticky
                        ? 'sticky left-0 z-10 bg-background'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
