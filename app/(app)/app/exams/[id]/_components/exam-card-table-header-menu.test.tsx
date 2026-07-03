// @vitest-environment jsdom
// S1-1: ColumnHeaderMenu unit + integration tests。
// 完了条件 ①–⑤:
// ① canSort 列 header click で menu 開・「昇順」「降順」項目表示
// ② 「降順」click → sorting に {id, desc:true} が append(他列 sort 維持 = multi)
// ③ 追加済列の「昇順」click → 方向更新(重複 entry なし)
// ④ 非 canSort 列(title 等)は ExamCardTable で trigger 化されない
// ⑤ select 列は ExamCardTable で trigger 化されない
//
// Radix Popover open/close: fireEvent.click on trigger(列 toggle test:78-98 準拠)。
// 環境: vitest + jsdom + @testing-library/react + fake-indexeddb (vitest.setup.ts global)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
} from '@tanstack/react-table'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'
import { ColumnHeaderMenu } from './exam-card-table-header-menu'

// ---------------------------------------------------------------------------
// Mocks for ExamCardTable (tests ④ ⑤)。exam-card-table.test.tsx と同 pattern。
// ---------------------------------------------------------------------------

const { mockCreateOption, mockBulkTag } = vi.hoisted(() => ({
  mockCreateOption: vi.fn(async () => 'new-opt-menu-test'),
  mockBulkTag: vi.fn(async () => ({ ok: true, succeeded: [] as string[], failed: [] as string[] })),
}))

vi.mock('./card-tags-section', async (importActual) => {
  const actual = await importActual<typeof import('./card-tags-section')>()
  return { ...actual, createOption: mockCreateOption }
})

vi.mock('../_hooks/use-bulk-card-tags', async (importActual) => {
  const actual = await importActual<typeof import('../_hooks/use-bulk-card-tags')>()
  return { ...actual, useBulkCardTags: () => mockBulkTag }
})

import { ExamCardTable } from './exam-card-table'

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_ROW: ExamCardRow = {
  card: {
    id: 'menu-test-card',
    user_id: 'u-test',
    exam_id: 'e-test',
    title: 'Test Card',
    sort_key: '0001',
    question_text: 'Test?',
    options: [],
    correct_answer_ids: [],
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 5,
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
  },
  tags: [],
}

// ---------------------------------------------------------------------------
// TestMenu: ColumnHeaderMenu を real TanStack column で包む最小 harness。
// sorting state を data-testid で外部検証できるよう表示する。
// ---------------------------------------------------------------------------

function TestMenu({
  columnId,
  label,
  initialSorting = [],
  filterEditor,
}: {
  columnId: string
  label: string
  initialSorting?: SortingState
  filterEditor?: React.ReactNode
}) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting)
  // eslint-disable-next-line react-hooks/incompatible-library -- test harness: useReactTable は React Compiler 非対応だが test 専用 component のため許容
  const table = useReactTable<ExamCardRow>({
    data: React.useMemo(() => [TEST_ROW], []),
    columns: examCardTableColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    state: { sorting },
    onSortingChange: setSorting,
  })
  const column = table.getColumn(columnId)!
  return (
    <>
      <div data-testid="sorting-state">{JSON.stringify(sorting)}</div>
      <ColumnHeaderMenu column={column} label={label} filterEditor={filterEditor} />
    </>
  )
}

// ---------------------------------------------------------------------------
// ExamCardTable setup helpers (tests ④ ⑤)
// ---------------------------------------------------------------------------

const EXAM_ID = 'header-menu-exam'
const USER_ID = 'header-menu-user'

function makeCard(): ClientCard {
  return {
    id: 'card-menu-1',
    user_id: USER_ID,
    exam_id: EXAM_ID,
    title: 'Menu Test Card',
    sort_key: '0001',
    question_text: 'Question?',
    options: [],
    correct_answer_ids: [],
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: new Date().toISOString(),
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
  }
}

beforeEach(async () => {
  const db = getClientDb()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  await db.sync_meta.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// ① canSort 列 header click で menu 開・「昇順」「降順」項目表示
// ===========================================================================

describe('ColumnHeaderMenu ①: canSort 列 header click で menu が開く', () => {
  it('question 列(canSort)の trigger click で「昇順」「降順」が表示される', async () => {
    render(<TestMenu columnId="question" label="問題文" />)

    const trigger = screen.getByRole('button', { name: '問題文 の列メニュー' })
    fireEvent.click(trigger)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '昇順' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '降順' })).toBeInTheDocument()
    })
  })
})

// ===========================================================================
// ② 「降順」click → {id, desc:true} が append(他列 sort 維持 = multi)
// ===========================================================================

describe('ColumnHeaderMenu ②: 「降順」click は multi-sort でその列を append する', () => {
  it('question が既にソート済の状態で currentStreak の「降順」click → 両列が sorting に含まれる', async () => {
    const initialSorting: SortingState = [{ id: 'question', desc: false }]
    render(
      <TestMenu columnId="currentStreak" label="連続正解数" initialSorting={initialSorting} />,
    )

    const trigger = screen.getByRole('button', { name: '連続正解数 の列メニュー' })
    fireEvent.click(trigger)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '降順' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '降順' }))

    await waitFor(() => {
      const state = JSON.parse(
        screen.getByTestId('sorting-state').textContent ?? '[]',
      ) as SortingState
      // question 昇順 が維持されていること(他列 sort 維持 = multi)
      expect(state).toContainEqual({ id: 'question', desc: false })
      // currentStreak 降順 が追加されていること
      expect(state).toContainEqual({ id: 'currentStreak', desc: true })
    })
  })
})

// ===========================================================================
// ③ 追加済列の「昇順」click → 方向更新(重複 entry なし)
// ===========================================================================

describe('ColumnHeaderMenu ③: 既存 sort 列の「昇順」click は方向更新(重複なし)', () => {
  it('question が desc=true の状態で「昇順」click → desc:false に更新・entry が 1 件のまま', async () => {
    const initialSorting: SortingState = [{ id: 'question', desc: true }]
    render(<TestMenu columnId="question" label="問題文" initialSorting={initialSorting} />)

    const trigger = screen.getByRole('button', { name: '問題文 の列メニュー' })
    fireEvent.click(trigger)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '昇順' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '昇順' }))

    await waitFor(() => {
      const state = JSON.parse(
        screen.getByTestId('sorting-state').textContent ?? '[]',
      ) as SortingState
      // entry が 1 件(重複なし)
      expect(state).toHaveLength(1)
      // 方向が desc:false に更新
      expect(state[0]).toEqual({ id: 'question', desc: false })
    })
  })
})

// ===========================================================================
// ④ 非 canSort 列(title 等)は ExamCardTable で trigger 化されない
// ===========================================================================

describe('ColumnHeaderMenu ④: 非 canSort 列は ExamCardTable でメニュー trigger 化されない', () => {
  it('title 列ヘッダーに「タイトル の列メニュー」ボタンが存在しない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard())
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    await waitFor(() => {
      expect(screen.getByTestId('row-card-menu-1')).toBeInTheDocument()
    })

    // title 列は enableSorting: false なのでメニュー trigger ボタンが存在しない
    expect(
      screen.queryByRole('button', { name: 'タイトル の列メニュー' }),
    ).not.toBeInTheDocument()
    // タイトルヘッダーは列自体として存在する
    expect(screen.getByRole('columnheader', { name: /タイトル/ })).toBeInTheDocument()
    // canSort 列(問題文)は ExamCardTable の thead で実際に menu trigger 化される
    // (production の thead 配線を positive に固定 = ternary を戻すと fail する非 vacuous guard)
    expect(
      screen.getByRole('button', { name: '問題文 の列メニュー' }),
    ).toBeInTheDocument()
  })
})

// ===========================================================================
// ⑤ select 列除外
// ===========================================================================

describe('ColumnHeaderMenu ⑤: select 列は ExamCardTable で trigger 化されない', () => {
  it('select 列 th に「の列メニュー」button がなく全選択 checkbox のみ存在する', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard())
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    await waitFor(() => {
      expect(screen.getByTestId('row-card-menu-1')).toBeInTheDocument()
    })

    // 全選択 checkbox を含む th を取得
    const headerCheckbox = screen.getByRole('checkbox', { name: '全選択' })
    const selectTh = headerCheckbox.closest('th') as HTMLElement
    expect(selectTh).not.toBeNull()

    // その th 内にメニュー trigger button がない
    const menuButton = selectTh.querySelector('button[aria-label$="の列メニュー"]')
    expect(menuButton).toBeNull()
  })
})
