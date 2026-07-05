// @vitest-environment jsdom
// exam-card-table-sorting unit test (Grid-2 T2 / S3-1)。
// sorting 機能の 8 case:
//   1. currentStreak 昇順/降順
//   2. lastReview ソートで null が末尾
//   3. lastCorrect ソートで null が末尾
//   4. tags / select 列がソート不可 (enableSorting: false)
//   5. title 昇順/降順 (localeCompare 'ja') [S3-1 (a)]
//   6. sort_key 昇順/降順 + NULLS LAST/FIRST [S3-1 (b)(e)]
//   7. question 列が getCanSort() === false [S3-1 (c)]
//   8. 初期連番順 (pre-sort レイヤー回帰防止) [S3-1 (d)]

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

// ---------------------------------------------------------------------------
// case 5 / (a): title 昇順/降順 (localeCompare 'ja') [S3-1]
// ---------------------------------------------------------------------------

describe('Sorting: title 昇順/降順 [S3-1 (a)]', () => {
  // ASCII サンプルで direction を確認。exact collation は pin しない (環境差)。
  const data = [
    makeRow('card-b', { title: 'B', sort_key: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-a', { title: 'A', sort_key: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-c', { title: 'C', sort_key: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('昇順ソートで A→B→C 順', () => {
    const ids = getSortedIds(data, [{ id: 'title', desc: false }])
    expect(ids).toEqual(['card-a', 'card-b', 'card-c'])
  })

  it('降順ソートで C→B→A 順', () => {
    const ids = getSortedIds(data, [{ id: 'title', desc: true }])
    expect(ids).toEqual(['card-c', 'card-b', 'card-a'])
  })

  it('かな2文字で昇順が正しい向き (あ→い)', () => {
    const kanaData = [
      makeRow('card-i', { title: 'い', sort_key: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
      makeRow('card-a', { title: 'あ', sort_key: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    ]
    const ids = getSortedIds(kanaData, [{ id: 'title', desc: false }])
    expect(ids[0]).toBe('card-a') // 'あ' < 'い'
  })
})

// ---------------------------------------------------------------------------
// case 6 / (b)(e): sort_key 昇順/降順 + NULLS LAST/FIRST [S3-1]
// ---------------------------------------------------------------------------

describe('Sorting: sort_key 昇順/降順 + null 位置 [S3-1 (b)(e)]', () => {
  const data = [
    makeRow('card-2', { sort_key: '0002', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-null', { sort_key: null, created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-1', { sort_key: '0001', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('昇順ソートで連番順 (0001→0002→null)', () => {
    const ids = getSortedIds(data, [{ id: 'sort_key', desc: false }])
    expect(ids).toEqual(['card-1', 'card-2', 'card-null'])
  })

  it('昇順ソートで sort_key null が末尾 (NULLS LAST)', () => {
    const ids = getSortedIds(data, [{ id: 'sort_key', desc: false }])
    expect(ids[ids.length - 1]).toBe('card-null')
  })

  // (e): sortLikeServer + TanStack desc 反転 の継承挙動を明示 pin。
  // "バグ" ではなく意図した挙動 — spec D-2 参照。
  it('降順ソートで sort_key null が先頭 (inherited desc reversal)', () => {
    const ids = getSortedIds(data, [{ id: 'sort_key', desc: true }])
    expect(ids[0]).toBe('card-null')
  })

  it('降順ソートで非 null 行は 0002→0001 順', () => {
    const ids = getSortedIds(data, [{ id: 'sort_key', desc: true }])
    const nonNull = ids.filter((id) => id !== 'card-null')
    expect(nonNull).toEqual(['card-2', 'card-1'])
  })
})

// ---------------------------------------------------------------------------
// case 7 / (c): question 列が getCanSort() === false [S3-1]
// ---------------------------------------------------------------------------

describe('Sorting: question 列は getCanSort() === false [S3-1 (c)]', () => {
  const data = [makeRow('card-1')]

  it('question 列は getCanSort() が false (sort 撤去)', () => {
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
    const questionCol = result.current.getColumn('question')
    expect(questionCol).toBeDefined()
    expect(questionCol!.getCanSort()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// case 8 / (d): 初期連番順 (pre-sort レイヤー回帰防止) [S3-1]
// ---------------------------------------------------------------------------

describe('Sorting: 初期連番順 pre-sort レイヤー回帰防止 [S3-1 (d)]', () => {
  // exam-card-table.tsx の liveData pre-sort (sortLikeServer) により、
  // テーブルに渡るデータは既に連番順 (sort_key ASC + created_at tiebreak)。
  // sorting=[] では TanStack がデータ順を変えない = pre-sort 順が保たれる。
  const preSortedData = [
    makeRow('card-1', { sort_key: '0001', title: 'C', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-2', { sort_key: '0002', title: 'A', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-3', { sort_key: '0003', title: 'B', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('sorting=[] では入力データ順 (pre-sort 順) を保持する', () => {
    const ids = getSortedIds(preSortedData, [])
    expect(ids).toEqual(['card-1', 'card-2', 'card-3'])
  })

  it('title ソート適用後に sorting=[] へ戻すと pre-sort 順に復帰する', () => {
    // title 昇順でソートすると C→A→B のタイトル順 = card-2, card-3, card-1
    const idsWithSort = getSortedIds(preSortedData, [{ id: 'title', desc: false }])
    // タイトルソートが効いており、pre-sort 順と異なる
    expect(idsWithSort).not.toEqual(['card-1', 'card-2', 'card-3'])
    // sorting=[] へ戻すと pre-sort 順 (連番順) に復帰する
    const idsAfterClear = getSortedIds(preSortedData, [])
    expect(idsAfterClear).toEqual(['card-1', 'card-2', 'card-3'])
  })
})
