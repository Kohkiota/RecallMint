'use client'

// exam-card-table-columns — TanStack Table column defs for ExamCardTable。
// module スコープで定義 (component 内 useMemo 不使用)。
// 列順: [checkbox, 問題文(sticky), タグ(T6 TagCell)]。
//
// 'use client' は JSX を含む ColumnDef を使うため必要 (T2 学び: pure helper でも
// React component を含む場合は boundary が必要)。

import type { ColumnDef, FilterFn } from '@tanstack/react-table'
import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { TagEditCallbacks } from './card-tags-section'
import type { ToggleFn } from '../_hooks/use-card-tag-toggle'
import { TagCell } from './exam-card-table-tag-cell'
import { sortLikeServer } from './inline-card-list'
import {
  matchesTagFilter,
  matchesAnswerState,
  matchesStreakFilter,
  type TagFilterValue,
  type AnswerStateFilter,
  type StreakFilterValue,
} from '../_lib/card-filter-predicates'
import type { CardWithTags } from '@/lib/cards/join-card-tags'

// 既存 import 互換維持: ExamCardRow = CardWithTags (pure alias)。
export type ExamCardRow = CardWithTags

/** TanStack Table meta 型。 table レベルで 1 回構築し、 columns の cell から参照する。 */
export type ExamCardTableMeta = {
  userId: string
  toggle: ToggleFn
  tagEditCallbacks: TagEditCallbacks
  categories: ClientTagCategory[]
  options: ClientTagOption[]
}

// ---------------------------------------------------------------------------
// filterFn (Grid-2 T3) — module スコープで定義し、 純関数 (../_lib) に委譲する。
// columnFilters の value 形は filter-bar が書込む型と一致させる。
// ---------------------------------------------------------------------------

const tagsFilterFn: FilterFn<ExamCardRow> = (row, _columnId, filterValue) =>
  matchesTagFilter(row.original.tags, filterValue as TagFilterValue)

const answerStateFilterFn: FilterFn<ExamCardRow> = (row, _columnId, filterValue) =>
  matchesAnswerState(row.original.card, filterValue as AnswerStateFilter)

const streakFilterFn: FilterFn<ExamCardRow> = (row, _columnId, filterValue) =>
  matchesStreakFilter(row.original.card.current_streak, filterValue as StreakFilterValue)

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
    accessorFn: (row) => row.card.question_text,
    cell: ({ row }) => (
      <div className="line-clamp-2">{row.original.card.question_text}</div>
    ),
    // 問題文列は第 1 列 pin。 sticky CSS は ExamCardTable 側の <th>/<td> で付与。
    // column def には meta だけ持たせ、 layout は render 側で解決する。
    meta: { sticky: true },
    enableSorting: true,
    // sortKey(連番)順 = sortLikeServer (sort_key NULLS-LAST 辞書順 + created_at tiebreak)。
    // 問題文列ヘッダクリックで「連番順」ソートを担う (Grid-2 T2 設計: # 列削除済のため代替)。
    sortingFn: (rowA, rowB) => sortLikeServer(rowA.original.card, rowB.original.card),
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
    // Grid-2 T3: tag フィルタ (カテゴリ内 OR / カテゴリ間 AND)。 value = TagFilterValue。
    filterFn: tagsFilterFn,
  },
  {
    id: 'lastCorrect',
    header: '直近正誤',
    // null → undefined 変換: TanStack の sortUndefined: 'last' に乗せるため必須。
    // false ?? undefined === false なので false は保持される (boolean 値は消えない)。
    accessorFn: (row) => row.card.last_correct ?? undefined,
    cell: ({ row }) => {
      const v = row.original.card.last_correct
      if (v === true) {
        return <span className="font-medium text-green-600">正 ○</span>
      }
      if (v === false) {
        return <span className="font-medium text-red-500">誤 ×</span>
      }
      return <span className="text-muted-foreground">—</span>
    },
    enableSorting: true,
    // null/undefined を昇順・降順とも末尾に固定 (direction 非依存)。
    sortUndefined: 'last',
    // boolean 比較は TanStack default ('basic' = 数値変換後比較、false=0 < true=1) で OK。
    // Grid-2 T3: 回答状態フィルタ (AS-1) を last_correct 列に attach。 value = AnswerStateFilter。
    filterFn: answerStateFilterFn,
  },
  {
    id: 'currentStreak',
    header: '連続正解数',
    // 数値フィールド。null なし。default sortingFn ('auto') で数値ソート。
    accessorFn: (row) => row.card.current_streak,
    cell: ({ row }) => (
      <span>{row.original.card.current_streak}</span>
    ),
    enableSorting: true,
    // Grid-2 T3: 数値比較フィルタ (N-1)。 value = StreakFilterValue。
    filterFn: streakFilterFn,
  },
  {
    id: 'lastReview',
    header: '最終回答日時',
    // null → undefined 変換: sortUndefined: 'last' を効かせるため必須。
    accessorFn: (row) => row.card.last_review ?? undefined,
    cell: ({ row }) => {
      const v = row.original.card.last_review
      if (!v) {
        return <span className="text-muted-foreground">未回答</span>
      }
      // JST 表示: Asia/Tokyo タイムゾーンで日付 + 時刻を表示
      const jst = new Date(v).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      return <span>{jst}</span>
    },
    enableSorting: true,
    // ISO 文字列を純粋文字列比較 (辞書順 = 時系列順)。
    // 'alphanumeric' は数値分割で ISO に意図しない結果を生む可能性があるため 'text' を明示。
    // undefined (= null 変換済) は sortUndefined: 'last' が処理するため custom 内不要。
    sortingFn: 'text',
    sortUndefined: 'last',
  },
]
