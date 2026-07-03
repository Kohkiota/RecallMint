// exam-card-table-filter-editors.tsx — S1-3: filter editor registry.
// 3 entries: lastCorrect (回答状態 select) / currentStreak (op+数値 input) /
//   tags (CardTagAddPopover selectOnly).
// Each editor component receives { column, ctx } and reads/writes column filter value directly.
// Aria-labels preserved from exam-card-table-filter-bar.tsx for test asset reuse.
//
// 'use client' は不要: 親 ExamCardTable (= 'use client') からのみ import される子で
// boundary は親側で確立済。

import * as React from 'react'
import type { Column } from '@tanstack/react-table'

import type { ExamCardRow } from './exam-card-table-columns'
import type { FilterEditorContext } from './exam-card-table-condition-bar'
import { CardTagAddPopover } from './card-tag-add-popover'
import type {
  TagFilterValue,
  AnswerStateFilter,
  StreakFilterValue,
  StreakFilterOp,
} from '../_lib/card-filter-predicates'
import { ANSWER_STATE_LABELS, STREAK_OP_LABELS } from '../_lib/card-filter-labels'

// ---------------------------------------------------------------------------
// LastCorrect editor — 回答状態 select
// Verbatim-equivalent to filter-bar answer-state handler; aria-label preserved.
// ---------------------------------------------------------------------------

function LastCorrectEditor({
  column,
}: {
  column: Column<ExamCardRow, unknown>
  ctx: FilterEditorContext
}) {
  const answerState = (column.getFilterValue() as AnswerStateFilter | undefined) ?? 'all'

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as AnswerStateFilter
    // 'all' は filter を外す (columnFilters から除去 = undefined を set)。
    column.setFilterValue(next === 'all' ? undefined : next)
  }

  return (
    <div className="px-2 py-2">
      <label className="inline-flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">回答状態</span>
        <select
          aria-label="回答状態フィルタ"
          value={answerState}
          onChange={handleChange}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          {(Object.keys(ANSWER_STATE_LABELS) as AnswerStateFilter[]).map((s) => (
            <option key={s} value={s}>
              {ANSWER_STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CurrentStreak editor — op select + 数値 input
// Local state initialized from column.getFilterValue() on mount (editor mounts fresh on open).
// NaN/empty → setFilterValue(undefined). aria-labels preserved from filter-bar.
// ---------------------------------------------------------------------------

function CurrentStreakEditor({
  column,
}: {
  column: Column<ExamCardRow, unknown>
  ctx: FilterEditorContext
}) {
  // editor mounts fresh on Popover open — initialize from current filter value.
  const streakFilter = column.getFilterValue() as StreakFilterValue | undefined
  const [streakOp, setStreakOp] = React.useState<StreakFilterOp>(streakFilter?.op ?? 'lte')
  const [streakInput, setStreakInput] = React.useState<string>(
    streakFilter && !Number.isNaN(streakFilter.value) ? String(streakFilter.value) : '',
  )

  const applyStreakFilter = (op: StreakFilterOp, raw: string) => {
    if (raw.trim() === '') {
      column.setFilterValue(undefined)
      return
    }
    const value = Number(raw)
    if (Number.isNaN(value)) {
      column.setFilterValue(undefined)
      return
    }
    column.setFilterValue({ op, value } satisfies StreakFilterValue)
  }

  const handleOpChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const op = e.target.value as StreakFilterOp
    // Derive effective input from current external filter state (not stale local state).
    // Mirrors filter-bar's handleStreakOpChange to prevent stale-value re-application.
    const currentFilter = column.getFilterValue() as StreakFilterValue | undefined
    const effectiveInput =
      currentFilter && !Number.isNaN(currentFilter.value) ? String(currentFilter.value) : ''
    setStreakOp(op)
    setStreakInput(effectiveInput)
    applyStreakFilter(op, effectiveInput)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setStreakInput(raw)
    applyStreakFilter(streakOp, raw)
  }

  return (
    <div className="px-2 py-2">
      <label className="inline-flex items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">連続正解数</span>
        <select
          aria-label="連続正解数 演算子"
          value={streakOp}
          onChange={handleOpChange}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          {(Object.keys(STREAK_OP_LABELS) as StreakFilterOp[]).map((op) => (
            <option key={op} value={op}>
              {STREAK_OP_LABELS[op]}
            </option>
          ))}
        </select>
        <input
          type="number"
          aria-label="連続正解数 しきい値"
          value={streakInput}
          onChange={handleInputChange}
          placeholder="—"
          className="w-16 rounded-md border border-border bg-background px-2 py-1"
        />
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tags editor — CardTagAddPopover with selectOnly
// Moves tag adapter logic from filter-bar: handleTagToggle builds TagFilterValue
// with empty-category pruning → setFilterValue(undefined when empty).
// selectOnly: hides 新規作成/kebab affordances (filter+toggle only).
// ---------------------------------------------------------------------------

function TagsEditor({
  column,
  ctx,
}: {
  column: Column<ExamCardRow, unknown>
  ctx: FilterEditorContext
}) {
  const { categories, options } = ctx

  // ref-stable tagFilter (useMemo avoids ?? {} creating a new ref every render)
  const rawTagFilter = column.getFilterValue() as TagFilterValue | undefined
  const tagFilter = React.useMemo<TagFilterValue>(() => rawTagFilter ?? {}, [rawTagFilter])

  // tag adapter: onToggle で filter map に (categoryId, optionId) を toggle。
  // empty-category pruning + empty-map → undefined (never leaves {} residue).
  const handleTagToggle = (categoryId: string, optionId: string) => {
    const current = (column.getFilterValue() as TagFilterValue | undefined) ?? {}
    const existing = current[categoryId] ?? []
    const nextForCat = existing.includes(optionId)
      ? existing.filter((id) => id !== optionId)
      : [...existing, optionId]
    const next: TagFilterValue = { ...current, [categoryId]: nextForCat }
    if (nextForCat.length === 0) delete next[categoryId]
    column.setFilterValue(Object.keys(next).length === 0 ? undefined : next)
  }

  // popover の option 行 Check 表示用 = 現在 filter 中の全 option id
  const allAssignedOptionIds = React.useMemo(
    () => Object.values(tagFilter).flat(),
    [tagFilter],
  )

  return (
    <CardTagAddPopover
      categories={categories}
      options={options}
      allAssignedOptionIds={allAssignedOptionIds}
      onToggle={handleTagToggle}
      selectOnly
      trigger={
        <button
          type="button"
          className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30"
        >
          タグで絞り込み
        </button>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Registry (frozen interface — S1-3 task interface)
// ---------------------------------------------------------------------------

export const cardTableFilterEditors: Record<
  'lastCorrect' | 'currentStreak' | 'tags',
  React.FC<{ column: Column<ExamCardRow, unknown>; ctx: FilterEditorContext }>
> = {
  lastCorrect: LastCorrectEditor,
  currentStreak: CurrentStreakEditor,
  tags: TagsEditor,
}
