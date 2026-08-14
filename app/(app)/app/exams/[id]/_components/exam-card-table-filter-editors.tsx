// exam-card-table-filter-editors.tsx — S1-3 / S4-3: filter editor registry.
// 8 entries: lastCorrect (回答状態 select) / currentStreak (op+数値 input) /
//   tags (CardTagAddPopover selectOnly) /
//   title / question_label / question / explanation_text / memo (共有 TextColumnEditor)。
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
  TextFilterOp,
  TextFilterValue,
} from '@/lib/cards/card-filter-predicates'
import { isValuelessTextOp } from '@/lib/cards/card-filter-predicates'
import { ANSWER_STATE_LABELS, STREAK_OP_LABELS, TEXT_OP_LABELS } from '../_lib/card-filter-labels'

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
      {/* 指摘 B: ラベルを input の上に置く縦積み(flex-col)。TextColumnEditor と統一し
          narrow menu(w-36)でのラベル縦潰れを解消。 */}
      <div className="flex flex-col gap-1.5 text-sm">
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
      </div>
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
      {/* 指摘 B: ラベルを input の上に置く縦積み(flex-col)。TextColumnEditor と統一し
          narrow menu(w-36)でのラベル縦潰れを解消(op select + しきい値 input を縦に並べる)。 */}
      <div className="flex flex-col gap-1.5 text-sm">
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
          className="rounded-md border border-border bg-background px-2 py-1"
        />
      </div>
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
        // S2-6: tags header の trigger を cell 全体化(ラベル + filter dot)。
        // tags は sort 不可ゆえ glyph なし。 dot は registry-gated と等価に
        // column.getIsFiltered() で出し分け(見た目・表示条件は不変、位置が trigger 内へ移るのみ)。
        <button
          type="button"
          className="w-full inline-flex items-center gap-1 text-left cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground"
        >
          <span>タグで絞り込み</span>
          {column.getIsFiltered() && (
            <span
              role="img"
              aria-label="フィルタ適用中"
              className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </button>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// TextColumnEditor — S4-3: 共有テキストフィルタ editor (5 列共通)
// CurrentStreakEditor と同構造だが「undefined に落とさない」「local value 保持」の差分あり。
// 書込規約: op 変更・値入力の操作時に常に setFilterValue({op, value})。
//   値なし op は {op, value:''} — 空値で undefined に落とさない (無効化は predicate 側)。
// 入力値の保持: 値なし op へ切替時に localValue は保持し、値必須 op へ戻したら復元して書き込む。
// ---------------------------------------------------------------------------

function TextColumnEditor({
  column,
}: {
  column: Column<ExamCardRow, unknown>
  ctx: FilterEditorContext
}) {
  // 列名: columnDef.header が string のときそれを使い、非 string は column.id fallback (getDisplayName と同ロジック)。
  const columnName =
    typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id

  // editor mounts fresh on Popover open — initialize from current filter value.
  const textFilter = column.getFilterValue() as TextFilterValue | undefined
  const [op, setOp] = React.useState<TextFilterOp>(textFilter?.op ?? 'contains')
  // localValue は常に「最後にユーザーが入力したテキスト」を保持する。
  // 値なし op へ切替時は localValue を消さずに保持し、値必須 op へ戻したら復元する。
  const [localValue, setLocalValue] = React.useState<string>(textFilter?.value ?? '')

  const handleOpChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextOp = e.target.value as TextFilterOp
    setOp(nextOp)
    if (isValuelessTextOp(nextOp)) {
      // 値なし op: {op, value:''} を書く。localValue は保持(次に値必須 op へ戻した時に復元)。
      column.setFilterValue({ op: nextOp, value: '' } satisfies TextFilterValue)
    } else {
      // 値必須 op へ切替: 保持していた localValue を復元して書き込む。
      column.setFilterValue({ op: nextOp, value: localValue } satisfies TextFilterValue)
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setLocalValue(val)
    // 空値でも undefined に落とさない — {op, value:''} を書く。
    column.setFilterValue({ op, value: val } satisfies TextFilterValue)
  }

  return (
    <div className="px-2 py-2">
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted-foreground">{columnName}</span>
        <select
          aria-label={`${columnName} フィルタ演算子`}
          value={op}
          onChange={handleOpChange}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          {(Object.keys(TEXT_OP_LABELS) as TextFilterOp[]).map((o) => (
            <option key={o} value={o}>
              {TEXT_OP_LABELS[o]}
            </option>
          ))}
        </select>
        {!isValuelessTextOp(op) && (
          <input
            type="text"
            aria-label={`${columnName} フィルタ値`}
            value={localValue}
            onChange={handleInputChange}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Registry (frozen interface — S1-3 / S4-3 task interface)
// ---------------------------------------------------------------------------

export const cardTableFilterEditors: Record<
  'lastCorrect' | 'currentStreak' | 'tags' | 'title' | 'question_label' | 'question' | 'explanation_text' | 'memo',
  React.FC<{ column: Column<ExamCardRow, unknown>; ctx: FilterEditorContext }>
> = {
  lastCorrect: LastCorrectEditor,
  currentStreak: CurrentStreakEditor,
  tags: TagsEditor,
  title: TextColumnEditor,
  question_label: TextColumnEditor,
  question: TextColumnEditor,
  explanation_text: TextColumnEditor,
  memo: TextColumnEditor,
}
