'use client'

// ExamCardTable — TanStack Table 最小構成。
// 案 X-A: ExamCardTable 内で独自 useLiveQuery を呼ぶ (InlineCardList と subscription を共有しない)。
// view='table' 時のみ mount (OQ-5 案 S-A / conditional unmount) されるため、
// 同時刻に 1 subscription のみ = spec §9 の「二重 subscription にしない」を構造的に保証。
//
// OQ-3 案 J-A: join シェイプ = flat array { card, tags: { category, option }[] }。
// join は useLiveQuery 解決時に 1 回、useMemo で ref 安定化 (TanStack 参照不安定対策の核)。
//
// Grid-1 T6:
//   - useCardTagToggle を table レベルで 1 回 instantiate (OT 制約 2)。
//   - tagEditCallbacks も table レベルで 1 回構築 (案 EC-A)。
//   - 両者を meta 経由で各 TagCell に配る (TanStack 標準 pattern)。

import { useMemo, useState, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type RowSelectionState,
} from '@tanstack/react-table'
import { getClientDb } from '@/lib/client-db'
import { sortLikeServer } from './inline-card-list'
import { examCardTableColumns, type ExamCardRow, type ExamCardTableMeta } from './exam-card-table-columns'
import { useCardTagToggle } from '../_hooks/use-card-tag-toggle'
import {
  handleRenameCategory,
  handleSetCategoryColor,
  handleDeleteCategory,
  handleRenameOption,
  handleSetOptionColor,
  handleDeleteOption,
  countCategoryImpact,
  countOptionImpact,
  handleCreateCategory,
  type TagEditCallbacks,
} from './card-tags-section'

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
      card: c,
      tags: tagsByCardId.get(c.id) ?? [],
    }))
  }, [liveData])

  // Grid-1 T6: useCardTagToggle を table レベルで 1 回 instantiate (OT 制約 2)。
  // getCardContext は liveData から card ごとの context を返す getter pattern (OT 制約 1:
  // hook 内で useLiveQuery を呼ばない)。 inline arrow は latest-ref pattern で安定化済。
  const getCardContext = useCallback(
    (cardId: string) => {
      if (!liveData) return undefined
      const cardTagsForCard = liveData.cardTags.filter((ct) => ct.card_id === cardId)
      return {
        categories: liveData.categories,
        options: liveData.options,
        allAssignedOptionIds: cardTagsForCard.map((ct) => ct.option_id),
      }
    },
    [liveData],
  )

  const toggle = useCardTagToggle({ userId, getCardContext })

  // Grid-1 T6 案 EC-A: tagEditCallbacks を table レベルで 1 回構築。
  // module スコープ handler (rename/color/delete/count) は import で共有。
  // create 系は userId / liveData を bind した useCallback closure。
  // ExamCardTable は per-row cardId を tagEditCallbacks に bind できないため、
  // createOptionAndAssign は TagCell の onToggle callback が行うので不要に見えるが、
  // CardTagAddPopover の createOptionAndAssign 経路 (option 新規作成) は popover 内で
  // selectedCategoryId + input name を取り、 onToggle ではなく tagEditCallbacks.createOptionAndAssign
  // を呼ぶ設計 (card-tags-section.tsx L541-558 参照)。 そのため cardId を bind した closure が必要。
  //
  // ここでは per-card の cardId は取得できないため、 createOptionAndAssign に cardId を
  // 渡す経路は TagCell 経由の sharedPopoverProps.onToggle 内で行う (TagCell 実装参照)。
  // tagEditCallbacks.createOptionAndAssign は fallback として no-op にはせず、
  // TagCell が cardId=row.original.card.id を閉じ込めた onToggle を渡す設計になっている。
  //
  // 問題: tagEditCallbacks.createOptionAndAssign は cardId をどこから取るか。
  // TagCell で sharedPopoverProps.onToggle は (categoryId, optionId) のため、
  // createOptionAndAssign の cardId は TagCell スコープで bind する必要がある。
  // ExamCardTable ではテーブル全体で 1 つの tagEditCallbacks を構築しているが、
  // createOptionAndAssign だけは per-row で closure が異なる。
  //
  // 解決: tagEditCallbacks.createOptionAndAssign は「最後に render された行」の cardId を
  // 使う実装ではなく、 TagCell 側で cardId-bound な createOptionAndAssign を構築し
  // tagEditCallbacks を上書きして渡す方式にする。 具体的には TagCell が受け取った
  // tagEditCallbacks を spread し createOptionAndAssign だけ cardId-bound に差し替える。
  // ExamCardTable では createOptionAndAssign の placeholder として渡し、 TagCell 側で override。
  //
  // placeholder: 空関数 (型を満たすが実際は TagCell 側で override される)。
  const createCategory = useCallback(
    (name: string, selectType: 'single' | 'multi') =>
      handleCreateCategory(
        userId,
        liveData?.categories ?? [],
        name,
        selectType,
      ),
    [userId, liveData?.categories],
  )

  // createOptionAndAssign の placeholder (TagCell 側で cardId-bound に差し替え)。
  // 実際の呼出では TagCell が自分の cardId を使った closure に上書きするため、
  // ExamCardTable レベルでは cardId = '' の placeholder で OK。
  const createOptionAndAssignPlaceholder = useCallback(
    (_categoryId: string, _name: string): Promise<void> => {
      // TagCell 側で override されるため、 ここに到達する呼び出しは発生しない。
      // 万が一呼ばれた場合は no-op (card が特定できないため書込不可)。
      return Promise.resolve()
    },
    [],
  )

  const tagEditCallbacks: TagEditCallbacks = useMemo(
    () => ({
      renameCategory: handleRenameCategory,
      setCategoryColor: handleSetCategoryColor,
      deleteCategory: handleDeleteCategory,
      renameOption: handleRenameOption,
      setOptionColor: handleSetOptionColor,
      deleteOption: handleDeleteOption,
      countCategoryImpact,
      countOptionImpact,
      createCategory,
      createOptionAndAssign: createOptionAndAssignPlaceholder,
    }),
    [createCategory, createOptionAndAssignPlaceholder],
  )

  // TanStack table instance。 columns は module スコープ参照 (再採番なし)。
  // enableRowSelection: true + getRowId で card.id を row id とする。
  // rowSelection は controlled state (useState) で持つ。
  // meta に toggle / tagEditCallbacks / categories / options を渡し、
  // TagCell が cell render 時に table.options.meta 経由でアクセスする (TanStack 標準 pattern)。
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table の useReactTable は React Compiler 非対応 API だが、TanStack 側の既知 tradeoff であり抑止が推奨方針
  const table = useReactTable<ExamCardRow>({
    data,
    columns: examCardTableColumns,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    getRowId: (row) => row.card.id,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    meta: {
      userId,
      toggle,
      tagEditCallbacks,
      categories: liveData?.categories ?? [],
      options: liveData?.options ?? [],
    } satisfies ExamCardTableMeta,
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
