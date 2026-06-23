'use client'

// CustomFilterForm — セッション開始前に絞り込み条件を設定するフォーム (S2.3 T10)。
// 5 条件: 試験 multiselect / tag (selectOnly popover) / 回答状態 / 連続正解数 / 出題順
// を local state で集約し、「演習開始」 click で親へ Omit<CustomSessionCriteria,'userId'|'limit'> を渡す。
//
// Q-7 制約: Dexie 読み取りのみ (tag 作成・編集導線なし)。 tagEditCallbacks は不使用。
// filter-bar の logic (handleTagToggle / applyStreakFilter / ANSWER_STATE_LABELS) を
// local state 版に re-host する (DRY 参照元: exam-card-table-filter-bar.tsx)。

import * as React from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { getClientDb, type ClientExam } from '@/lib/client-db'
import { CardTagAddPopover } from '@/app/(app)/app/exams/[id]/_components/card-tag-add-popover'
import type {
  TagFilterValue,
  AnswerStateFilter,
  StreakFilterValue,
  StreakFilterOp,
} from '@/app/(app)/app/exams/[id]/_lib/card-filter-predicates'
import type { CustomSessionCriteria } from '@/lib/cards/get-custom-session-cards'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type CustomFilterFormProps = {
  userId: string
  onStart: (c: Omit<CustomSessionCriteria, 'userId' | 'limit'>) => void
}

// ---------------------------------------------------------------------------
// Constants (re-host from filter-bar — 同じ値型を共有)
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

export function CustomFilterForm({ userId, onStart }: CustomFilterFormProps) {
  // ---- Dexie 読み取り (read-only, Q-7) ----
  const exams = useLiveQuery(
    () => getClientDb().exams.where('user_id').equals(userId).toArray(),
    [userId],
  )
  const categories = useLiveQuery(
    () => getClientDb().tag_categories.toArray(),
    [],
  )
  const options = useLiveQuery(
    () => getClientDb().tag_options.toArray(),
    [],
  )

  // ---- local state ----
  const [examIds, setExamIds] = React.useState<string[]>([])
  const [tagFilter, setTagFilter] = React.useState<TagFilterValue>({})
  const [answerState, setAnswerState] = React.useState<AnswerStateFilter>('all')
  const [streakOp, setStreakOp] = React.useState<StreakFilterOp>('lte')
  const [streakInput, setStreakInput] = React.useState<string>('')
  const [order, setOrder] = React.useState<'random' | 'sequential'>('sequential')

  // ---- 試験 multiselect ----
  // 名前 → created_at の昇順 (サーバー由来の並び準拠)
  const sortedExams = React.useMemo<ClientExam[]>(
    () => [...(exams ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [exams],
  )

  const handleExamToggle = (examId: string) => {
    setExamIds((prev) =>
      prev.includes(examId) ? prev.filter((id) => id !== examId) : [...prev, examId],
    )
  }

  // ---- tag adapter (filter-bar の handleTagToggle を local-state 版に re-host) ----
  const handleTagToggle = (categoryId: string, optionId: string) => {
    setTagFilter((current) => {
      const existing = current[categoryId] ?? []
      const nextForCat = existing.includes(optionId)
        ? existing.filter((id) => id !== optionId)
        : [...existing, optionId]
      const next: TagFilterValue = { ...current, [categoryId]: nextForCat }
      if (nextForCat.length === 0) delete next[categoryId] // 空カテゴリは持たない
      return next
    })
  }

  // popover の option Check 表示 + chip 表示用
  const selectedOptionIds = React.useMemo(
    () => Object.values(tagFilter).flat(),
    [tagFilter],
  )

  const selectedTagChips = React.useMemo(() => {
    const chips: Array<{ categoryId: string; optionId: string; label: string }> = []
    const cats = categories ?? []
    const opts = options ?? []
    for (const [categoryId, optionIds] of Object.entries(tagFilter)) {
      const cat = cats.find((c) => c.id === categoryId)
      for (const optionId of optionIds) {
        const opt = opts.find((o) => o.id === optionId)
        chips.push({
          categoryId,
          optionId,
          label: `${cat?.name ?? categoryId}: ${opt?.name ?? optionId}`,
        })
      }
    }
    return chips
  }, [tagFilter, categories, options])

  // ---- 回答状態 ----
  const handleAnswerStateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setAnswerState(e.target.value as AnswerStateFilter)
  }

  // ---- 連続正解数 (filter-bar の applyStreakFilter を local-state 版に re-host) ----
  // 空入力 / NaN → null (絞り込みなし)
  const computeStreakFilter = (op: StreakFilterOp, raw: string): StreakFilterValue | null => {
    if (raw.trim() === '') return null
    const value = Number(raw)
    if (Number.isNaN(value)) return null
    return { op, value }
  }

  const handleStreakOpChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStreakOp(e.target.value as StreakFilterOp)
  }

  const handleStreakInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setStreakInput(e.target.value)
  }

  // ---- 演習開始 ----
  const handleStart = () => {
    onStart({
      examIds,
      tagFilter,
      answerState,
      streakFilter: computeStreakFilter(streakOp, streakInput),
      order,
    })
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 py-6">
      {/* 試験 multiselect */}
      <section aria-labelledby="exam-filter-label">
        <p id="exam-filter-label" className="mb-2 text-sm font-medium text-foreground">
          試験
          <span className="ml-1 text-xs text-muted-foreground">（空 = 全試験）</span>
        </p>
        {sortedExams.length === 0 ? (
          <p className="text-sm text-muted-foreground">試験データを読み込み中…</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sortedExams.map((exam) => {
              const selected = examIds.includes(exam.id)
              return (
                <button
                  key={exam.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => handleExamToggle(exam.id)}
                  className={[
                    'rounded-md border px-3 py-1.5 text-sm transition-colors',
                    selected
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border bg-background text-foreground hover:border-foreground/40',
                  ].join(' ')}
                >
                  {exam.name}
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* タグ */}
      <section aria-labelledby="tag-filter-label">
        <p id="tag-filter-label" className="mb-2 text-sm font-medium text-foreground">
          タグ
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CardTagAddPopover
            categories={categories ?? []}
            options={options ?? []}
            allAssignedOptionIds={selectedOptionIds}
            onToggle={handleTagToggle}
            selectOnly
            trigger={
              <button
                type="button"
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              >
                タグで絞り込み
              </button>
            }
          />
          {selectedTagChips.map((chip) => (
            <span
              key={`${chip.categoryId}-${chip.optionId}`}
              data-testid={`tag-chip-${chip.optionId}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs"
            >
              {chip.label}
              <button
                type="button"
                aria-label={`タグ解除: ${chip.label}`}
                onClick={() => handleTagToggle(chip.categoryId, chip.optionId)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </section>

      {/* 回答状態 */}
      <section aria-labelledby="answer-state-label">
        <label
          id="answer-state-label"
          className="mb-2 block text-sm font-medium text-foreground"
          htmlFor="answer-state-select"
        >
          回答状態
        </label>
        <select
          id="answer-state-select"
          aria-label="回答状態フィルタ"
          value={answerState}
          onChange={handleAnswerStateChange}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        >
          {(Object.keys(ANSWER_STATE_LABELS) as AnswerStateFilter[]).map((s) => (
            <option key={s} value={s}>
              {ANSWER_STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </section>

      {/* 連続正解数 */}
      <section aria-labelledby="streak-filter-label">
        <p id="streak-filter-label" className="mb-2 text-sm font-medium text-foreground">
          連続正解数
        </p>
        <div className="flex items-center gap-2">
          <select
            aria-label="連続正解数 演算子"
            value={streakOp}
            onChange={handleStreakOpChange}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
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
            className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
      </section>

      {/* 出題順 */}
      <section aria-labelledby="order-label">
        <p id="order-label" className="mb-2 text-sm font-medium text-foreground">
          出題順
        </p>
        <div className="flex gap-3">
          {(
            [
              { value: 'sequential', label: '順番どおり' },
              { value: 'random', label: 'ランダム' },
            ] as const
          ).map(({ value, label }) => (
            <label key={value} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="order"
                value={value}
                checked={order === value}
                onChange={() => setOrder(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      {/* 演習開始 */}
      <button
        type="button"
        onClick={handleStart}
        className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90"
      >
        演習開始
      </button>
    </div>
  )
}
