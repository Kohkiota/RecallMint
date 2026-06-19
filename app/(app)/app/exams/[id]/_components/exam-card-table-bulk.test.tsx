// @vitest-environment jsdom
// ExamCardTable bulk 統合 test (Grid-2 T6)。
// action bar + selection 統合 + bulk 配線 + 失敗 UI を ExamCardTable 経由で検証する。
//
// sync layer (enqueueEntityMutation / runGuardedEntityMutationFlush) は spy mock。
// runOptimisticMutation が見る enqueue/flush を置換し、 flush 回数 / throw 注入を制御する。
// それ以外 (Dexie mirror) は fake-indexeddb の実 read で検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync/entity-mutations')>()
  return { ...actual, enqueueEntityMutation: mockEnqueue }
})

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import {
  getClientDb,
  type ClientCard,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { ExamCardTable } from './exam-card-table'

const EXAM_ID = 'test-exam-bulk'
const USER_ID = 'test-user-bulk'

function makeCard(n: number, overrides: Partial<ClientCard> = {}): ClientCard {
  return {
    id: `card-${n}`,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    title: `Card ${n}`,
    sort_key: String(n).padStart(4, '0'),
    question_text: `Question text for card ${n}`,
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
    created_at: new Date(Date.now() + n * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
    ...overrides,
  }
}

const CATEGORY: ClientTagCategory = {
  id: 'cat-1',
  user_id: USER_ID,
  name: 'Difficulty',
  select_type: 'multi',
  color: null,
  sort_key: '0001',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}
const OPTION: ClientTagOption = {
  id: 'opt-1',
  user_id: USER_ID,
  category_id: 'cat-1',
  name: 'Hard',
  color: null,
  sort_key: '0001',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

async function seedTags() {
  const db = getClientDb()
  await db.tag_categories.put(CATEGORY)
  await db.tag_options.put(OPTION)
}

beforeEach(async () => {
  const db = getClientDb()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
  mockEnqueue.mockClear()
  mockFlush.mockClear()
  mockEnqueue.mockImplementation(async () => ({}) as never)
})

afterEach(() => cleanup())

function selectRow(n: number) {
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`行選択.*Card ${n}`) }))
}

// ===========================================================================
// 1. 選択時のみ action bar 表示 / N件カウント
// ===========================================================================

describe('T6: action bar 表示 / 件数', () => {
  it('未選択で非表示、 2 行選択で「2件選択中」', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    expect(screen.queryByTestId('exam-card-table-action-bar')).not.toBeInTheDocument()

    selectRow(1)
    selectRow(2)

    await waitFor(() => {
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中')
    })
  })
})

// ===========================================================================
// 2. 全選択がフィルタ後行のみ (§7.3)
// ===========================================================================

describe('T6: 全選択スコープ = filtered (§7.3)', () => {
  it('フィルタ適用中の全選択は可視行のみ選択し、 隠れた行は含めない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
      makeCard(3, { answered: false, last_correct: null }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    // 「直近正解」で card-1 のみ可視に絞る
    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 全選択 header
    fireEvent.click(screen.getByRole('checkbox', { name: '全選択' }))

    // 可視 1 行のみ選択 = action bar は 1 件 (隠れた card-2 / card-3 は含まれない)
    await waitFor(() => {
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('1件選択中')
    })
  })
})

// ===========================================================================
// 3. タグ操作後 selection 維持 + 統合 smoke (1 flush)
// ===========================================================================

describe('T6: タグ操作後 selection 維持 + 1 tx/flush', () => {
  it('2 行選択 → bulk タグ付与 → 同 2 行が選択維持 + flush 1 回', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])
    await seedTags()

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    selectRow(1)
    selectRow(2)
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // action bar 内の「タグ付与」popover を開く
    const bar = screen.getByTestId('exam-card-table-action-bar')
    fireEvent.click(within(bar).getByText('タグ付与'))

    // stage1: category 選択
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))
    // stage2: option 選択 → bulk add 発火
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))

    // card_tags が 2 件 (card-1 / card-2) put された
    await waitFor(async () => {
      const tags = await db.card_tags.toArray()
      expect(tags).toHaveLength(2)
    })

    // selection 維持 = 2件選択中のまま
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // 統合 smoke: 1 tx → 1 flush
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// 4. 削除後に削除 id が selection から除外
// ===========================================================================

describe('T6: 削除後 selection 除外', () => {
  it('2 行選択 → bulk 削除 → 削除 id が消え action bar 非表示', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    selectRow(1)
    selectRow(2)
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    const bar = screen.getByTestId('exam-card-table-action-bar')
    fireEvent.click(within(bar).getByRole('button', { name: '削除' }))
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }))

    // card-1 / card-2 が mirror から消え、 残り 1 行
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))
    // 選択 0 件 = action bar 非表示
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-table-action-bar')).not.toBeInTheDocument(),
    )
  })
})

// ===========================================================================
// 5. フィルタ変更で隠れた選択行が自動解除 (HS-2)
// ===========================================================================

describe('T6: フィルタ変更で隠れた選択行 自動解除 (HS-2)', () => {
  it('全行から数行選択 → フィルタで一部を隠す → 件数が可視選択行に一致', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 2 行とも選択
    selectRow(1)
    selectRow(2)
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // フィルタで card-1 (last_correct=true) のみ可視 → card-2 が隠れる
    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })

    // 隠れた card-2 は selection から外れ、 件数が可視選択 1 行に一致
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('1件選択中')
    })
  })
})

// ===========================================================================
// 6. bulk 失敗時の件数表示
// ===========================================================================

describe('T6: bulk 失敗 UI', () => {
  it('enqueue throw で tx rollback → action bar に失敗件数 inline 表示', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])
    await seedTags()

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    selectRow(1)
    selectRow(2)
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // enqueue を throw させ tx を rollback (atomic all-or-nothing)
    mockEnqueue.mockImplementation(async () => {
      throw new Error('enqueue failed')
    })

    const bar = screen.getByTestId('exam-card-table-action-bar')
    fireEvent.click(within(bar).getByText('タグ付与'))
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))

    // 失敗 inline 表示 (全件失敗 = 2件)
    await waitFor(() => {
      const err = screen.getByTestId('action-bar-error')
      expect(err).toHaveTextContent('2件')
      expect(err).toHaveTextContent('再試行されます')
    })
  })
})
