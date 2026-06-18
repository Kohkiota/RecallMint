// ExamCardTableFilterBar — Grid-2 T3: 試験詳細テーブルのフィルタ UI。
// 3 種フィルタを TanStack の columnFilters に read/write する:
//   - 回答状態 (lastCorrect 列): 4 値 select。 'all' のとき filter を外す。
//   - 連続正解数 (currentStreak 列): 演算子 select + 数値 input。 空入力で filter 解除。
//   - tag (tags 列): CardTagAddPopover を再利用 (本体無改造)。 onToggle を
//     「filter map への (categoryId, optionId) toggle」に差し替える adapter。
//     allAssignedOptionIds に現在 filter 選択中の option id を渡すと popover の
//     option 行に Check が付き「選択中フィルタ」を可視化する。
//
// 'use client' は付けない: 親 ExamCardTable (= 'use client') からのみ import される
// 子 component で boundary は親側で確立済。 file 自体に付けると Next.js TS plugin が
// function 型 prop を Server Action prop として誤検出する (TagCell と同 pattern)。

import * as React from 'react'
import type { Table } from '@tanstack/react-table'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import type { ExamCardRow } from './exam-card-table-columns'
import type { TagEditCallbacks } from './card-tags-section'
import { CardTagAddPopover } from './card-tag-add-popover'
import type {
  TagFilterValue,
  AnswerStateFilter,
  StreakFilterValue,
  StreakFilterOp,
} from '../_lib/card-filter-predicates'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ExamCardTableFilterBarProps = {
  table: Table<ExamCardRow>
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  tagEditCallbacks: TagEditCallbacks
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const ANSWER_STATE_LABELS: Record<AnswerStateFilter, string> = {
  all: 'すべて',
  unanswered: '未回答',
  correct: '直近正解',
  incorrect: '直近不正解',
}

const STREAK_OP_LABELS: Record<StreakFilterOp, string> = {
  lte: '≤',
  gte: '≥',
  eq: '=',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExamCardTableFilterBar({
  table,
  categories,
  options,
  tagEditCallbacks,
}: ExamCardTableFilterBarProps) {
  const tagColumn = table.getColumn('tags')
  const answerColumn = table.getColumn('lastCorrect')
  const streakColumn = table.getColumn('currentStreak')

  // --- 現在 filter 値の読み出し (columnFilters から該当 column の value) ---
  // tagFilter は useMemo の deps に使うため ref 安定化 (?? {} が毎 render 新 ref を生むのを防ぐ)。
  const rawTagFilter = tagColumn?.getFilterValue() as TagFilterValue | undefined
  const tagFilter = React.useMemo<TagFilterValue>(() => rawTagFilter ?? {}, [rawTagFilter])
  const answerState = (answerColumn?.getFilterValue() as AnswerStateFilter | undefined) ?? 'all'
  const streakFilter = streakColumn?.getFilterValue() as StreakFilterValue | undefined

  // 数値 input は空文字を保持したいので local state。 filter には NaN を書込まず undefined で解除。
  const [streakOp, setStreakOp] = React.useState<StreakFilterOp>(streakFilter?.op ?? 'lte')
  const [streakInput, setStreakInput] = React.useState<string>(
    streakFilter && !Number.isNaN(streakFilter.value) ? String(streakFilter.value) : '',
  )

  // --- 回答状態 ---
  const handleAnswerStateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as AnswerStateFilter
    // 'all' は filter を外す (columnFilters から除去 = undefined を set)。
    answerColumn?.setFilterValue(next === 'all' ? undefined : next)
  }

  // --- 数値比較 ---
  const applyStreakFilter = (op: StreakFilterOp, raw: string) => {
    if (raw.trim() === '') {
      streakColumn?.setFilterValue(undefined) // 空入力で filter 解除
      return
    }
    const value = Number(raw)
    if (Number.isNaN(value)) {
      streakColumn?.setFilterValue(undefined)
      return
    }
    streakColumn?.setFilterValue({ op, value } satisfies StreakFilterValue)
  }

  const handleStreakOpChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const op = e.target.value as StreakFilterOp
    setStreakOp(op)
    applyStreakFilter(op, streakInput)
  }

  const handleStreakInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setStreakInput(raw)
    applyStreakFilter(streakOp, raw)
  }

  // --- tag adapter: onToggle で filter map に (categoryId, optionId) を toggle ---
  const handleTagToggle = (categoryId: string, optionId: string) => {
    const current = (tagColumn?.getFilterValue() as TagFilterValue | undefined) ?? {}
    const existing = current[categoryId] ?? []
    const nextForCat = existing.includes(optionId)
      ? existing.filter((id) => id !== optionId)
      : [...existing, optionId]
    const next: TagFilterValue = { ...current, [categoryId]: nextForCat }
    if (nextForCat.length === 0) delete next[categoryId] // 空カテゴリは持たない
    tagColumn?.setFilterValue(Object.keys(next).length === 0 ? undefined : next)
  }

  // popover の option 行 Check 表示用 = 現在 filter 中の全 option id。
  const selectedOptionIds = React.useMemo(
    () => Object.values(tagFilter).flat(),
    [tagFilter],
  )

  // 選択中 tag chip ([{ categoryId, category 名, optionId, option 名 }]) を構築。
  const selectedTagChips = React.useMemo(() => {
    const chips: Array<{ categoryId: string; optionId: string; label: string }> = []
    for (const [categoryId, optionIds] of Object.entries(tagFilter)) {
      const cat = categories.find((c) => c.id === categoryId)
      for (const optionId of optionIds) {
        const opt = options.find((o) => o.id === optionId)
        chips.push({
          categoryId,
          optionId,
          label: `${cat?.name ?? categoryId}: ${opt?.name ?? optionId}`,
        })
      }
    }
    return chips
  }, [tagFilter, categories, options])

  const hasAnyFilter =
    table.getState().columnFilters.length > 0

  const clearAll = () => {
    table.setColumnFilters([])
    setStreakInput('')
    setStreakOp('lte')
  }

  return (
    <div
      data-testid="exam-card-table-filter-bar"
      className="flex flex-wrap items-center gap-3 border-b border-border px-1 py-2 text-sm"
    >
      {/* 回答状態 */}
      <label className="inline-flex items-center gap-1.5">
        <span className="text-muted-foreground">回答状態</span>
        <select
          aria-label="回答状態フィルタ"
          value={answerState}
          onChange={handleAnswerStateChange}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          {(Object.keys(ANSWER_STATE_LABELS) as AnswerStateFilter[]).map((s) => (
            <option key={s} value={s}>
              {ANSWER_STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      {/* 連続正解数 */}
      <label className="inline-flex items-center gap-1.5">
        <span className="text-muted-foreground">連続正解数</span>
        <select
          aria-label="連続正解数 演算子"
          value={streakOp}
          onChange={handleStreakOpChange}
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
          onChange={handleStreakInputChange}
          placeholder="—"
          className="w-16 rounded-md border border-border bg-background px-2 py-1"
        />
      </label>

      {/* tag フィルタ: CardTagAddPopover 再利用 (本体無改造) */}
      <CardTagAddPopover
        categories={categories}
        options={options}
        allAssignedOptionIds={selectedOptionIds}
        onToggle={handleTagToggle}
        tagEditCallbacks={tagEditCallbacks}
        trigger={
          <button
            type="button"
            className="rounded-md border border-border bg-background px-2.5 py-1 text-muted-foreground hover:text-foreground hover:border-foreground/30"
          >
            タグで絞り込み
          </button>
        }
      />

      {/* 選択中 tag chip */}
      {selectedTagChips.map((chip) => (
        <span
          key={`${chip.categoryId}-${chip.optionId}`}
          data-testid={`filter-chip-${chip.optionId}`}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`フィルタ解除: ${chip.label}`}
            onClick={() => handleTagToggle(chip.categoryId, chip.optionId)}
            className="text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}

      {/* クリア */}
      {hasAnyFilter && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          フィルタをクリア
        </button>
      )}
    </div>
  )
}
