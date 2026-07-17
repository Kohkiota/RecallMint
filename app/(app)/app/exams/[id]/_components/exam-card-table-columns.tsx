'use client'

// exam-card-table-columns — TanStack Table column defs for ExamCardTable。
// module スコープで定義 (component 内 useMemo 不使用)。
// 列順: [select, title, sort_key, question, options, tags,
//        explanation_text, memo, lastCorrect, currentStreak, lastReview]。
// Fix-3 T2: 決め打ち sticky 固定は撤去(不変)。S5 でユーザー選択式の列固定(column pinning)を導入 — 固定境界は examViewPrefs V3 + TanStack columnPinning で管理。
//
// 'use client' は JSX を含む ColumnDef を使うため必要 (T2 学び: pure helper でも
// React component を含む場合は boundary が必要)。

import type { ColumnDef, FilterFn } from '@tanstack/react-table'
import { PanelRightOpen } from 'lucide-react'
import type { ClientCard, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { cn } from '@/lib/utils'
import type { TagEditCallbacks } from '@/lib/tags/tag-crud'
import type { ToggleFn } from '../_hooks/use-card-tag-toggle'
import { TagCell } from './exam-card-table-tag-cell'
import { tagSortKey } from '../_lib/tag-sort-key'
import { sortLikeServer } from './inline-card-list'
import { CompactOptionsCell } from './exam-card-table-options-edit-cell'
import { CardImageGallery } from './card-image-gallery'
import {
  matchesTagFilter,
  matchesAnswerState,
  matchesStreakFilter,
  matchesTextFilter,
  type TagFilterValue,
  type AnswerStateFilter,
  type StreakFilterValue,
  type TextFilterValue,
} from '@/lib/cards/card-filter-predicates'
import type { CardWithTags } from '@/lib/cards/join-card-tags'
import { InlineTextField } from './inline-text-field'

// 既存 import 互換維持: ExamCardRow = CardWithTags (pure alias)。
export type ExamCardRow = CardWithTags

/** TanStack Table meta 型。 table レベルで 1 回構築し、 columns の cell から参照する。 */
export type ExamCardTableMeta = {
  userId: string
  toggle: ToggleFn
  tagEditCallbacks: TagEditCallbacks
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  // T2: side peek trigger。optional — T3 が配線するまでは undefined のまま。
  // optional にすることで既存の `satisfies ExamCardTableMeta`(exam-card-table.tsx)を変更不要にする。
  activeCardId?: string | null
  openCard?: (cardId: string) => void
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

// S4-1: テキストフィルタ factory。read(card) でセル値を取り出して matchesTextFilter に委譲。
// 5 列 (title / sort_key / question / explanation_text / memo) に適用 (rule of three 充足)。
// row.original 直読み — accessorFn / getValue とは独立 (sort と filter は別レイヤー)。
const makeTextFilterFn = (
  read: (card: ClientCard) => string | null | undefined,
): FilterFn<ExamCardRow> =>
  (row, _columnId, filterValue) =>
    matchesTextFilter(read(row.original.card), filterValue as TextFilterValue)

export const examCardTableColumns: ColumnDef<ExamCardRow>[] = [
  {
    id: 'select',
    // チェックボックス実体 (~16px) + px-1 左右 合計 (8px) = 24px コンテンツ幅 →
    // text-center で前後 ~4px 余白 → 合計 32px (クリップなしの最小幅)。
    size: 32,
    header: ({ table }) => (
      <input
        type="checkbox"
        checked={table.getIsAllRowsSelected()}
        ref={(el) => {
          if (el) el.indeterminate = table.getIsSomeRowsSelected()
        }}
        onChange={table.getToggleAllRowsSelectedHandler()}
        // B: th 全域が onClick で全選択トグルするため、checkbox 直 click の bubbling を止めて
        //    二重発火 (onChange + th onClick) による net no-op を防ぐ。onChange は温存 (Space キー不変)。
        onClick={(e) => e.stopPropagation()}
        aria-label="全選択"
      />
    ),
    cell: ({ row }) => (
      <input
        type="checkbox"
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
        // B: td 全域が onClick で選択トグルするため、checkbox 直 click の bubbling を止めて
        //    二重発火 (onChange + td onClick) による net no-op を防ぐ。onChange は温存 (Space キー不変)。
        onClick={(e) => e.stopPropagation()}
        aria-label={`行選択: ${row.original.card.title}`}
      />
    ),
    enableSorting: false,
  },
  {
    id: 'title',
    size: 80,
    header: 'タイトル',
    // S3-1 D-1: TanStack v8 の getCanSort() は !!accessorFn が必須 (RowSorting.js:178)。
    // display column (accessorFn なし) では enableSorting:true でも getCanSort()===false になり
    // getSortedRowModel がフィルタアウトするため、title を非 null accessor で sortable 化。
    // sortingFn は row.original から直接読んで localeCompare('ja') で比較する。
    accessorFn: (row) => row.card.title,
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      // openCard が実際に配線された時だけボタンを描画する。T3 が配線するまでは undefined のため非表示。
      const openCard = meta?.openCard
      return (
        <div className="relative w-full group/peek">
          <InlineTextField
            cardId={card.id}
            field="title"
            initialValue={card.title}
            ariaLabel="タイトル 編集"
          />
          {openCard && (
            <button
              type="button"
              aria-label="カードを開く"
              aria-pressed={meta?.activeCardId === card.id}
              onClick={() => openCard(card.id)}
              className={cn(
                'absolute right-0.5 top-0.5 z-[1] inline-flex size-7 items-center justify-center rounded bg-background shadow-sm text-muted-foreground hover:text-foreground',
                'opacity-100 md:opacity-0 md:group-hover/peek:opacity-100 md:focus-visible:opacity-100',
                'group-has-[input]/peek:opacity-0 group-has-[input]/peek:pointer-events-none',
                'aria-pressed:text-foreground',
              )}
            >
              <PanelRightOpen className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      )
    },
    enableSorting: true,
    sortingFn: (rowA, rowB) =>
      rowA.original.card.title.localeCompare(rowB.original.card.title, 'ja'),
    // S4-1: テキストフィルタ。row.original.card.title を直読み (sort と独立)。
    filterFn: makeTextFilterFn((card) => card.title),
  },
  {
    id: 'sort_key',
    size: 100,
    header: 'ソートキー',
    // S3-1 D-2: accessorFn は getCanSort() を有効化するために必要 (TanStack v8 制約)。
    // sortLikeServer = 連番順(文字列辞書比較 + NULLS LAST + created_at tiebreak)。
    // TanStack desc 反転により昇順→null 末尾 / 降順→null 先頭 (継承挙動・意図的)。
    accessorFn: (row) => row.card.sort_key,
    cell: ({ row }) => (
      <InlineTextField
        cardId={row.original.card.id}
        field="sort_key"
        initialValue={row.original.card.sort_key ?? null}
        ariaLabel="ソートキー 編集"
      />
    ),
    enableSorting: true,
    sortingFn: (rowA, rowB) => sortLikeServer(rowA.original.card, rowB.original.card),
    // S4-1: テキストフィルタ。row.original.card.sort_key を直読み (nullable)。
    filterFn: makeTextFilterFn((card) => card.sort_key),
  },
  {
    id: 'question',
    size: 320,
    header: '問題文',
    // accessorFn は表示 (question_text) のために残置 — sort は撤去 (S3-1 D-3 前段)。
    accessorFn: (row) => row.card.question_text,
    // Sprint T T6 + add(2026-07-17 OT): カードビュー同様に gallery を配線(thumbnail +
    // compact add icon)。add は「面ごとの出し分けをしない」原則で table にも配線。
    // 既存 attach 経路(CardImageGallery 内 attachImageToCard)を流用・独自経路なし。userId は meta 経由。
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      return (
        <>
          <InlineTextField
            cardId={card.id}
            field="question_text"
            initialValue={card.question_text}
            ariaLabel="問題文 編集"
            multiline
            displayClassName="text-sm md:min-h-6 md:py-0.5"
          />
          {meta && (
            <CardImageGallery
              images={card.images}
              target="question_text"
              cardId={card.id}
              userId={meta.userId}
              compact
              attachAriaLabel="問題文に画像を追加"
            />
          )}
        </>
      )
    },
    // S3-1: 問題文ソート撤去。連番順の役割は sort_key 列 sortingFn へ移管。
    // 注意: 初期連番順(liveData の pre-sort)は別レイヤーで不変(exam-card-table.tsx)。
    enableSorting: false,
    // S4-1: テキストフィルタ。row.original.card.question_text を直読み。
    filterFn: makeTextFilterFn((card) => card.question_text),
  },
  {
    id: 'options',
    size: 240,
    header: '選択肢',
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      return (
        <CompactOptionsCell
          cardId={card.id}
          options={card.options}
          images={card.images}
          userId={meta?.userId ?? ''}
        />
      )
    },
    enableSorting: false,
  },
  {
    id: 'tags',
    size: 200,
    header: 'タグ',
    // S3-2 D-3: 代表値 = TagCell 表示順と同一 comparator で並べた先頭タグの
    // `{category.name}: {option.name}`。TanStack の getCanSort() には !!accessorFn が必要。
    accessorFn: (row) => tagSortKey(row.tags),
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
    enableSorting: true,
    // 代表値を localeCompare('ja') で比較。undefined (タグ無し) は sortUndefined:'last' が処理。
    sortingFn: (rowA, rowB, columnId) =>
      String(rowA.getValue(columnId) ?? '').localeCompare(
        String(rowB.getValue(columnId) ?? ''),
        'ja',
      ),
    // タグ無しカード (accessorFn → undefined) は昇降ともに末尾固定。
    sortUndefined: 'last',
    // Grid-2 T3: tag フィルタ (カテゴリ内 OR / カテゴリ間 AND)。value = TagFilterValue。
    // filterFn は row.original.tags を直読み — accessorFn/getValue とは独立 (sort/filter 独立)。
    filterFn: tagsFilterFn,
  },
  {
    id: 'explanation_text',
    size: 220,
    header: '解説',
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      return (
        <>
          <InlineTextField
            cardId={card.id}
            field="explanation_text"
            initialValue={card.explanation_text ?? null}
            multiline
            ariaLabel="解説 編集"
            displayClassName="text-sm md:min-h-6 md:py-0.5"
          />
          {meta && (
            <CardImageGallery
              images={card.images}
              target="explanation_text"
              cardId={card.id}
              userId={meta.userId}
              compact
              attachAriaLabel="解説に画像を追加"
            />
          )}
        </>
      )
    },
    enableSorting: false,
    // S4-1: テキストフィルタ。row.original.card.explanation_text を直読み (nullable)。
    filterFn: makeTextFilterFn((card) => card.explanation_text),
  },
  {
    id: 'memo',
    size: 220,
    header: 'メモ',
    cell: ({ row, table }) => {
      const card = row.original.card
      const meta = table.options.meta as ExamCardTableMeta | undefined
      return (
        <>
          <InlineTextField
            cardId={card.id}
            field="memo"
            initialValue={card.memo ?? null}
            multiline
            ariaLabel="メモ 編集"
            displayClassName="text-sm md:min-h-6 md:py-0.5"
          />
          {meta && (
            <CardImageGallery
              images={card.images}
              target="memo"
              cardId={card.id}
              userId={meta.userId}
              compact
              attachAriaLabel="メモに画像を追加"
            />
          )}
        </>
      )
    },
    enableSorting: false,
    // S4-1: テキストフィルタ。row.original.card.memo を直読み (nullable)。
    filterFn: makeTextFilterFn((card) => card.memo),
  },
  {
    id: 'lastCorrect',
    size: 96,
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
    size: 96,
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
    size: 160,
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
