// @vitest-environment jsdom
// exam-card-table-sorting unit test (Grid-2 T2 / S3-1 / S3-2)。
// sorting 機能の 9 case:
//   1. currentStreak 昇順/降順
//   2. lastReview ソートで null が末尾
//   3. lastCorrect ソートで null が末尾
//   4. select 列がソート不可 (enableSorting: false)
//   5. title 昇順/降順 (localeCompare 'ja') [S3-1 (a)]
//   6. question_label 昇順/降順 + NULLS LAST/FIRST [S3-1 (b)(e)]
//   7. question 列が getCanSort() === false [S3-1 (c)]
//   8. 初期連番順 (pre-sort レイヤー回帰防止) [S3-1 (d)]
//   9. tags 列 getCanSort()===true + localeCompare 昇降 + タグ無し末尾 + tiebreak [S3-2 (b)(c)]

import { describe, it, expect, vi } from 'vitest'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  type SortingState,
} from '@tanstack/react-table'
import { renderHook } from '@testing-library/react'
import type { ClientCard, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10、 './exam-card-table-columns' → inline-card-list.tsx 経由の
// transitive import)。 本 test は sorting 純ロジックのみ検証するため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

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
    question_label: '0001',
    base_order: 1024,
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
    makeRow('card-a', { current_streak: 5, question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-b', { current_streak: 1, question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-c', { current_streak: 3, question_label: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
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
    makeRow('card-null', { last_review: null, question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-early', { last_review: '2024-03-01T00:00:00.000Z', question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-late', { last_review: '2024-06-01T00:00:00.000Z', question_label: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
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
    makeRow('card-null', { last_correct: null, question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-false', { last_correct: false, question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-true', { last_correct: true, question_label: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
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
// case 4: select 列がソート不可 (enableSorting: false)
// tags は S3-2 で sortable 化 (case 9 参照)
// ---------------------------------------------------------------------------

describe('Sorting: select 列は getCanSort() === false', () => {
  const data = [makeRow('card-1')]

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
    makeRow('card-b', { title: 'B', question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-a', { title: 'A', question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-c', { title: 'C', question_label: '0003', created_at: '2024-01-03T00:00:00.000Z' }),
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
      makeRow('card-i', { title: 'い', question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }),
      makeRow('card-a', { title: 'あ', question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }),
    ]
    const ids = getSortedIds(kanaData, [{ id: 'title', desc: false }])
    expect(ids[0]).toBe('card-a') // 'あ' < 'い'
  })
})

// ---------------------------------------------------------------------------
// case 6 / (b)(e): question_label 昇順/降順 + NULLS LAST/FIRST [S3-1]
// ---------------------------------------------------------------------------

describe('Sorting: question_label 昇順/降順 + null 位置 [S3-1 (b)(e)]', () => {
  const data = [
    makeRow('card-2', { question_label: '0002', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-null', { question_label: null, created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-1', { question_label: '0001', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('昇順ソートで連番順 (0001→0002→null)', () => {
    const ids = getSortedIds(data, [{ id: 'question_label', desc: false }])
    expect(ids).toEqual(['card-1', 'card-2', 'card-null'])
  })

  it('昇順ソートで question_label null が末尾 (NULLS LAST)', () => {
    const ids = getSortedIds(data, [{ id: 'question_label', desc: false }])
    expect(ids[ids.length - 1]).toBe('card-null')
  })

  // (e): compareByQuestionLabel(ラベル列 sortingFn)+ TanStack desc 反転 の継承挙動を明示 pin。
  // "バグ" ではなく意図した挙動 — spec D-2 参照。
  it('降順ソートで question_label null が先頭 (inherited desc reversal)', () => {
    const ids = getSortedIds(data, [{ id: 'question_label', desc: true }])
    expect(ids[0]).toBe('card-null')
  })

  it('降順ソートで非 null 行は 0002→0001 順', () => {
    const ids = getSortedIds(data, [{ id: 'question_label', desc: true }])
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
  // exam-card-table.tsx の liveData pre-sort (compareByBaseOrder) により、
  // テーブルに渡るデータは既に基準順 (base_order ASC + id tiebreak)。
  // sorting=[] では TanStack がデータ順を変えない = pre-sort 順が保たれる。
  const preSortedData = [
    makeRow('card-1', { question_label: '0001', title: 'C', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow('card-2', { question_label: '0002', title: 'A', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow('card-3', { question_label: '0003', title: 'B', created_at: '2024-01-03T00:00:00.000Z' }),
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

// ---------------------------------------------------------------------------
// S3-2 fixtures: tag 付き行を作るためのヘルパー
// ---------------------------------------------------------------------------

function makeTagCategory(overrides: Partial<ClientTagCategory> = {}): ClientTagCategory {
  return {
    id: 'cat-1',
    user_id: 'u-test',
    name: 'カテゴリ',
    select_type: 'single',
    color: null,
    sort_key: '1',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeTagOption(overrides: Partial<ClientTagOption> = {}): ClientTagOption {
  return {
    id: 'opt-1',
    user_id: 'u-test',
    category_id: 'cat-1',
    name: 'オプション',
    color: null,
    sort_key: '1',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeTaggedRow(
  id: string,
  cardOverrides: Partial<ClientCard>,
  tags: ExamCardRow['tags'],
): ExamCardRow {
  return {
    card: makeClientCard({ id, ...cardOverrides }),
    tags,
  }
}

// ---------------------------------------------------------------------------
// case 9 / (b)(c): tags 列 S3-2
// ---------------------------------------------------------------------------

describe('Sorting: tags 列は getCanSort() === true [S3-2 (b)]', () => {
  const data = [makeRow('card-1')]

  it('tags 列は getCanSort() が true (S3-2 で sortable 化)', () => {
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
    expect(tagsCol!.getCanSort()).toBe(true)
  })
})

describe('Sorting: tags 代表値 localeCompare 昇降 [S3-2 (b)]', () => {
  // 代表値 = `{category.name}: {option.name}` を localeCompare('ja') で比較。
  // 各行の category sort_key=1 で同一 → option.name による代表値の差で順序が決まる。
  const cat = makeTagCategory({ id: 'cat-a', name: 'カテゴリ', sort_key: '1' })
  const optA = makeTagOption({ id: 'opt-a', name: 'あいう', sort_key: '1' })
  const optU = makeTagOption({ id: 'opt-u', name: 'うえお', sort_key: '2' })
  const optZ = makeTagOption({ id: 'opt-z', name: 'おかき', sort_key: '3' })

  const data = [
    makeTaggedRow('card-u', { question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }, [{ category: cat, option: optU }]),
    makeTaggedRow('card-z', { question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }, [{ category: cat, option: optZ }]),
    makeTaggedRow('card-a', { question_label: '0003', created_at: '2024-01-03T00:00:00.000Z' }, [{ category: cat, option: optA }]),
  ]
  // 代表値: card-u='カテゴリ: うえお', card-z='カテゴリ: おかき', card-a='カテゴリ: あいう'
  // 昇順: あいう < うえお < おかき → card-a, card-u, card-z

  it('昇順ソートで代表値 localeCompare 小→大 (あいう→うえお→おかき)', () => {
    const ids = getSortedIds(data, [{ id: 'tags', desc: false }])
    expect(ids).toEqual(['card-a', 'card-u', 'card-z'])
  })

  it('降順ソートで代表値 localeCompare 大→小 (おかき→うえお→あいう)', () => {
    const ids = getSortedIds(data, [{ id: 'tags', desc: true }])
    expect(ids).toEqual(['card-z', 'card-u', 'card-a'])
  })
})

describe('Sorting: tags タグ無しカードが末尾 [S3-2 (b)(c)]', () => {
  const cat = makeTagCategory({ id: 'cat-a', name: 'カテゴリ', sort_key: '1' })
  const opt = makeTagOption({ id: 'opt-a', name: 'あ', sort_key: '1' })

  const data = [
    makeTaggedRow('card-no-tag', { question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }, []),
    makeTaggedRow('card-tagged', { question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }, [{ category: cat, option: opt }]),
  ]

  it('昇順ソートでタグ無しカードが末尾に来る (sortUndefined:last)', () => {
    const ids = getSortedIds(data, [{ id: 'tags', desc: false }])
    expect(ids[ids.length - 1]).toBe('card-no-tag')
  })

  it('降順ソートでもタグ無しカードが末尾に来る (sortUndefined:last)', () => {
    const ids = getSortedIds(data, [{ id: 'tags', desc: true }])
    expect(ids[ids.length - 1]).toBe('card-no-tag')
  })
})

describe('Sorting: tags 同値 tiebreak = 連番順 (stable sort) [S3-2 (b)]', () => {
  // 代表値が同一の 2 行は stable sort + pre-sort (連番順) で相対順が維持される。
  // TanStack の sort は stable (ECMAScript 2019 以降 Array.prototype.sort = stable)。
  const cat = makeTagCategory({ id: 'cat-a', name: 'カテゴリ', sort_key: '1' })
  // 同じ option を使い、代表値を同一にする
  const opt = makeTagOption({ id: 'opt-same', name: '同値', sort_key: '1' })

  // 両者とも makeClientCard 既定の base_order=1024(同値)。 pre-sort が配列順を保つ
  // ことに依存した case で、順序は data の並び + stable sort で決まる。
  const data = [
    makeTaggedRow('card-1', { question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }, [{ category: cat, option: opt }]),
    makeTaggedRow('card-2', { question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }, [{ category: cat, option: opt }]),
  ]

  it('代表値同値の 2 行は昇順で pre-sort 相対順 (card-1→card-2) を保つ', () => {
    const ids = getSortedIds(data, [{ id: 'tags', desc: false }])
    expect(ids).toEqual(['card-1', 'card-2'])
  })

  it('代表値同値の 2 行は降順でも pre-sort 相対順 (card-1→card-2) を保つ', () => {
    const ids = getSortedIds(data, [{ id: 'tags', desc: true }])
    expect(ids).toEqual(['card-1', 'card-2'])
  })
})

describe('Sorting: tags filterFn は accessorFn 追加後も機能 (sort/filter 独立) [S3-2 (c)]', () => {
  // accessorFn 追加後も filterFn が row.original.tags を読んで機能することを確認。
  // sort と filter が独立 (getValue 経由 vs row.original 直読み) を固定。
  const cat = makeTagCategory({ id: 'cat-test', name: 'テスト', sort_key: '1' })
  const opt = makeTagOption({ id: 'opt-test', name: 'オプション', sort_key: '1' })

  const data = [
    makeTaggedRow('card-tagged', { question_label: '0001', created_at: '2024-01-01T00:00:00.000Z' }, [{ category: cat, option: opt }]),
    makeTaggedRow('card-no-tag', { question_label: '0002', created_at: '2024-01-02T00:00:00.000Z' }, []),
  ]

  it('tags filter が accessorFn 追加後も正しく機能する', () => {
    const { result } = renderHook(() =>
      useReactTable<ExamCardRow>({
        data,
        columns: examCardTableColumns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        state: {
          sorting: [{ id: 'tags', desc: false }],
          columnFilters: [{ id: 'tags', value: { [cat.id]: [opt.id] } }],
        },
        onSortingChange: () => {},
        onColumnFiltersChange: () => {},
      }),
    )
    // タグフィルタ後 = card-tagged のみ残る (card-no-tag は対象外)
    const filteredIds = result.current.getFilteredRowModel().rows.map((r) => r.original.card.id)
    expect(filteredIds).toContain('card-tagged')
    expect(filteredIds).not.toContain('card-no-tag')
  })
})
