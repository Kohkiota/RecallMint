// ConditionBar — S1-2: sorting + columnFilters を chip で描画する動的条件バー。
// conditions は useMemo 派生値(独自 state 化しない)。
// 条件ゼロの時は null を返しシュリンク(ResizeObserver で listOffset 再計測される)。
//
// hidden 列の条件も描画する: table.getColumn(id) は visibility 非依存で取得可。
// 列名は columnDef.header が string の場合はその値、非 string の場合は columnId fallback。
//
// 'use client' は不要: 親 ExamCardTable (= 'use client') からのみ import される子で
// boundary は親側で確立済(exam-card-table-column-toggle.tsx と同 pattern)。

import * as React from 'react'
import type { SortingState, ColumnFiltersState, Table } from '@tanstack/react-table'
import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { AnswerStateFilter, StreakFilterValue, TagFilterValue } from '../_lib/card-filter-predicates'
import { ANSWER_STATE_LABELS, STREAK_OP_LABELS } from '../_lib/card-filter-labels'
import type { ExamCardRow } from './exam-card-table-columns'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { CardTagAddPopover } from './card-tag-add-popover'
import { cardTableFilterEditors } from './exam-card-table-filter-editors'

// ---------------------------------------------------------------------------
// 公開 type / 純関数 (task interface 凍結)
// ---------------------------------------------------------------------------

export type TableCondition =
  | { kind: 'sort'; columnId: string; desc: boolean }
  | { kind: 'filter'; columnId: string; value: unknown }

/** sorting → sort 条件、columnFilters → filter 条件の順で連結して返す。 */
export function deriveConditions(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
): TableCondition[] {
  const sortConditions: TableCondition[] = sorting.map((s) => ({
    kind: 'sort',
    columnId: s.id,
    desc: s.desc,
  }))
  const filterConditions: TableCondition[] = columnFilters.map((f) => ({
    kind: 'filter',
    columnId: f.id,
    value: f.value,
  }))
  return [...sortConditions, ...filterConditions]
}

// ---------------------------------------------------------------------------
// FilterEditorContext (凍結 interface。S1-3 で使用 — S1-2 では受け取るのみ)
// ---------------------------------------------------------------------------

export type FilterEditorContext = {
  categories: ClientTagCategory[]
  options: ClientTagOption[]
}

// ---------------------------------------------------------------------------
// 内部ヘルパー: filter value → 要約 label
// ---------------------------------------------------------------------------

function getFilterSummary(value: unknown): string {
  // AnswerStateFilter = string ('unanswered' | 'correct' | 'incorrect')
  if (typeof value === 'string') {
    const label = ANSWER_STATE_LABELS[value as AnswerStateFilter]
    return `回答状態: ${label ?? value}`
  }
  // StreakFilterValue = { op: StreakFilterOp; value: number }
  if (value !== null && typeof value === 'object' && 'op' in value) {
    const sv = value as StreakFilterValue
    return `連続正解数: ${STREAK_OP_LABELS[sv.op]} ${sv.value}`
  }
  // TagFilterValue = Record<string, string[]>
  if (value !== null && typeof value === 'object') {
    const tagFilter = value as TagFilterValue
    const count = Object.values(tagFilter).flat().length
    return `タグ: ${count} 件`
  }
  return String(value)
}

// ---------------------------------------------------------------------------
// ConditionBar component
// ---------------------------------------------------------------------------

type ConditionBarProps = {
  table: Table<ExamCardRow>
  editorContext: FilterEditorContext
}

export function ConditionBar({
  table,
  editorContext,
}: ConditionBarProps): React.JSX.Element | null {
  const { sorting, columnFilters } = table.getState()

  const conditions = React.useMemo(
    () => deriveConditions(sorting, columnFilters),
    [sorting, columnFilters],
  )

  // 条件ゼロ → null (シュリンク)
  if (conditions.length === 0) return null

  const handleFlipSort = (columnId: string) => {
    table.setSorting((prev) =>
      prev.map((s) => (s.id === columnId ? { ...s, desc: !s.desc } : s)),
    )
  }

  const handleRemoveSort = (columnId: string) => {
    table.setSorting((prev) => prev.filter((s) => s.id !== columnId))
  }

  const handleRemoveFilter = (columnId: string) => {
    table.getColumn(columnId)?.setFilterValue(undefined)
  }

  const handleClearAll = () => {
    table.setSorting([])
    table.setColumnFilters([])
  }

  // タグ chip 用の adapter (chip body が CardTagAddPopover trigger になるため component 外で定義)。
  // empty-category pruning + empty-map → undefined (never leaves {} residue = dot 誤点灯防止)。
  const tagsColumn = table.getColumn('tags')
  const handleTagsChipToggle = (categoryId: string, optionId: string) => {
    const current = (tagsColumn?.getFilterValue() as TagFilterValue | undefined) ?? {}
    const existing = current[categoryId] ?? []
    const nextForCat = existing.includes(optionId)
      ? existing.filter((id) => id !== optionId)
      : [...existing, optionId]
    const next: TagFilterValue = { ...current, [categoryId]: nextForCat }
    if (nextForCat.length === 0) delete next[categoryId]
    tagsColumn?.setFilterValue(Object.keys(next).length === 0 ? undefined : next)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 py-2 text-sm">
      {conditions.map((condition) => {
        // hidden 列でも getColumn() は visibility 非依存で返す。
        const col = table.getColumn(condition.columnId)
        const headerDef = col?.columnDef.header
        const displayName =
          typeof headerDef === 'string' ? headerDef : condition.columnId

        if (condition.kind === 'sort') {
          return (
            <span
              key={`sort-${condition.columnId}`}
              data-testid={`condition-chip-sort-${condition.columnId}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {/* chip body: クリックで方向 flip */}
              <button
                type="button"
                onClick={() => handleFlipSort(condition.columnId)}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
              >
                並び替え: {displayName} {condition.desc ? '↓' : '↑'}
              </button>
              {/* × ボタン: sort 解除 */}
              <button
                type="button"
                aria-label={`ソート解除: ${displayName}`}
                onClick={() => handleRemoveSort(condition.columnId)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          )
        }

        // kind === 'filter'
        const summary = getFilterSummary(condition.value)

        // タグ chip: chip body が CardTagAddPopover の trigger になる。
        // ネスト popover を避けるため ConditionBar Popover wrapper を使わず
        // CardTagAddPopover 直接を chip body として配置する。
        if (condition.columnId === 'tags') {
          const rawTagFilter = tagsColumn?.getFilterValue() as TagFilterValue | undefined
          const tagsSelectedOptionIds = Object.values(rawTagFilter ?? {}).flat()
          return (
            <span
              key="filter-tags"
              data-testid="condition-chip-filter-tags"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {/* CardTagAddPopover: chip body (summary) が trigger。selectOnly で作成/編集非表示。 */}
              <CardTagAddPopover
                categories={editorContext.categories}
                options={editorContext.options}
                allAssignedOptionIds={tagsSelectedOptionIds}
                onToggle={handleTagsChipToggle}
                selectOnly
                trigger={
                  <button type="button" className="hover:text-foreground">
                    {summary}
                  </button>
                }
              />
              {/* × ボタン: filter 解除。stopPropagation で CardTagAddPopover trigger と分離。 */}
              <button
                type="button"
                aria-label={`フィルタを解除: ${displayName}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleRemoveFilter(condition.columnId)
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          )
        }

        // lastCorrect / currentStreak: chip body は Popover trigger、editor は PopoverContent。
        // filter editor が registry に存在する列のみ。存在しない列は summary span のまま。
        const columnId = condition.columnId as keyof typeof cardTableFilterEditors
        const EditorComponent =
          columnId in cardTableFilterEditors ? cardTableFilterEditors[columnId] : null

        if (EditorComponent && col) {
          return (
            <Popover key={`filter-${condition.columnId}`}>
              <span
                data-testid={`condition-chip-filter-${condition.columnId}`}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
              >
                {/* chip body: PopoverTrigger → editor が popover で開く */}
                <PopoverTrigger asChild>
                  <button type="button" className="hover:text-foreground">
                    {summary}
                  </button>
                </PopoverTrigger>
                {/* × ボタン: filter 解除 (popover は開かない) */}
                <button
                  type="button"
                  aria-label={`フィルタを解除: ${displayName}`}
                  onClick={() => handleRemoveFilter(condition.columnId)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </span>
              <PopoverContent align="start" className="w-auto p-0">
                {/* editor mounts fresh on Popover open (Radix が close 時に unmount する)。
                    初期値は EditorComponent 内で column.getFilterValue() から復元する。 */}
                <EditorComponent column={col} ctx={editorContext} />
              </PopoverContent>
            </Popover>
          )
        }

        // editor なし列: summary span のみ (× は解除)
        return (
          <span
            key={`filter-${condition.columnId}`}
            data-testid={`condition-chip-filter-${condition.columnId}`}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
          >
            <span>{summary}</span>
            <button
              type="button"
              aria-label={`フィルタを解除: ${displayName}`}
              onClick={() => handleRemoveFilter(condition.columnId)}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        )
      })}
      {/* すべてクリア: 条件が 1 件以上ある時のみ表示 (conditions.length > 0 は null check 済) */}
      <button
        type="button"
        onClick={handleClearAll}
        className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        すべてクリア
      </button>
    </div>
  )
}
