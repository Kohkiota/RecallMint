// @vitest-environment jsdom
// exam-card-table-sorting unit test (Grid-2 T2)。
// sorting 機能の 4 case:
//   1. currentStreak 昇順/降順
//   2. lastReview ソートで null が末尾
//   3. lastCorrect ソートで null が末尾
//   4. tags / select 列がソート不可 (enableSorting: false)

import { describe, it, expect } from 'vitest'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
} from '@tanstack/react-table'
import { renderHook } from '@testing-library/react'
import type { ClientCard } from '@/lib/client-db'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function makeClientCard(overrides: Partial<ClientCard> = {}): ClientCard {
  return {
    id: 'sort-test-card',
    user_id: 'u-test',
    exam_id: 'e-test',
    title: 'Test Card',
    sort_key: '0001',
    question_text: 'Test question?',
    options: [],
    correct_answer_ids: [],
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2024-01-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

function makeRow(id: string, cardOverrides: Partial<ClientCard> = {}): ExamCardRow {
  return {
    card: makeClientCard({ id, ...cardOverrides }),
    tags: [],
  }
}

// ---------------------------------------------------------------------------
// TanStack table instance harness for sorting tests
// ---------------------------------------------------------------------------

/**
 * useReactTable を renderHook で呼び出し、指定 sorting state で sorted rows を返す。
 * accessorFn / sortingFn / sortUndefined の設定が効いているかを検証するための最小 harness。
 */
function getSortedIds(data: ExamCardRow[], sorting: SortingState): string[] {
  const { result } = renderHook(() =>
    useReactTable<ExamCardRow>({
      data,
      columns: examCardTableColumns,
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
      state: { sorting },
      onSortingChange: () => {},
    }),
  )
  return result.current.getSortedRowModel().rows.map((r) => r.original.card.id)
}

// ---------------------------------------------------------------------------
// case 1: currentStreak 昇順/降順
// ---------------------------------------------------------------------------

describe('Sorting: currentStreak', () => {
  const data = [
    makeRow('card-a', { current_streak: 5, sort_key: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-b', { current_streak: 1, sort_key: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-c', { current_streak: 3, sort_key: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('昇順ソートで current_streak 小→大に並ぶ', () => {
    const ids = getSortedIds(data, [{ id: 'currentStreak', desc: false }])
    expect(ids).toEqual(['card-b', 'card-c', 'card-a'])
  })

  it('降順ソートで current_streak 大→小に並ぶ', () => {
    const ids = getSortedIds(data, [{ id: 'currentStreak', desc: true }])
    expect(ids).toEqual(['card-a', 'card-c', 'card-b'])
  })
})

// ---------------------------------------------------------------------------
// case 2: lastReview ソートで null が昇順・降順とも末尾
// ---------------------------------------------------------------------------

describe('Sorting: lastReview null が末尾固定', () => {
  const data = [
    makeRow('card-null', { last_review: null, sort_key: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-early', { last_review: '2024-03-01T00:00:00.000Z', sort_key: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-late', { last_review: '2024-06-01T00:00:00.000Z', sort_key: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('昇順ソートで null が末尾に来る', () => {
    const ids = getSortedIds(data, [{ id: 'lastReview', desc: false }])
    expect(ids[ids.length - 1]).toBe('card-null')
  })

  it('降順ソートでも null が末尾に来る', () => {
    const ids = getSortedIds(data, [{ id: 'lastReview', desc: true }])
    expect(ids[ids.length - 1]).toBe('card-null')
  })

  it('昇順ソートで非 null 行は early→late の順', () => {
    const ids = getSortedIds(data, [{ id: 'lastReview', desc: false }])
    const nonNullIds = ids.filter((id) => id !== 'card-null')
    expect(nonNullIds).toEqual(['card-early', 'card-late'])
  })
})

// ---------------------------------------------------------------------------
// case 3: lastCorrect ソートで null が昇順・降順とも末尾
// ---------------------------------------------------------------------------

describe('Sorting: lastCorrect null が末尾固定', () => {
  const data = [
    makeRow('card-null', { last_correct: null, sort_key: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-false', { last_correct: false, sort_key: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-true', { last_correct: true, sort_key: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('昇順ソートで null が末尾に来る', () => {
    const ids = getSortedIds(data, [{ id: 'lastCorrect', desc: false }])
    expect(ids[ids.length - 1]).toBe('card-null')
  })

  it('降順ソートでも null が末尾に来る', () => {
    const ids = getSortedIds(data, [{ id: 'lastCorrect', desc: true }])
    expect(ids[ids.length - 1]).toBe('card-null')
  })

  it('昇順ソートで非 null 行は false→true の順 (false < true)', () => {
    const ids = getSortedIds(data, [{ id: 'lastCorrect', desc: false }])
    const nonNullIds = ids.filter((id) => id !== 'card-null')
    expect(nonNullIds).toEqual(['card-false', 'card-true'])
  })
})

// ---------------------------------------------------------------------------
// case 4: tags / select 列がソート不可 (enableSorting: false)
// ---------------------------------------------------------------------------

describe('Sorting: tags / select 列は getCanSort() === false', () => {
  const data = [makeRow('card-1')]

  it('tags 列は getCanSort() が false', () => {
    const { result } = renderHook(() =>
      useReactTable<ExamCardRow>({
        data,
        columns: examCardTableColumns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        state: { sorting: [] },
        onSortingChange: () => {},
      }),
    )
    const tagsCol = result.current.getColumn('tags')
    expect(tagsCol).toBeDefined()
    expect(tagsCol!.getCanSort()).toBe(false)
  })

  it('select 列は getCanSort() が false', () => {
    const { result } = renderHook(() =>
      useReactTable<ExamCardRow>({
        data,
        columns: examCardTableColumns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        state: { sorting: [] },
        onSortingChange: () => {},
      }),
    )
    const selectCol = result.current.getColumn('select')
    expect(selectCol).toBeDefined()
    expect(selectCol!.getCanSort()).toBe(false)
  })
})
