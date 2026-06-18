// @vitest-environment jsdom
// ExamCardTableFilterBar smoke (Grid-2 T3)。
// ExamCardTable を render し、 filter-bar 操作で表示行が絞られることを検証する:
//   - 回答状態 select 変更 → 行が絞られる
//   - 連続正解数 比較 → 行が絞られる
//   - tag フィルタ chip 表示 + × 解除 (popover adapter 経路)
//
// 環境: vitest + jsdom + @testing-library/react + fake-indexeddb (vitest.setup.ts global)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import {
  getClientDb,
  type ClientCard,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { ExamCardTable } from './exam-card-table'

const EXAM_ID = 'test-exam-filter'
const USER_ID = 'test-user-filter'

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

beforeEach(async () => {
  const db = getClientDb()
  await db.cards.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.card_tags.clear()
})

afterEach(() => {
  cleanup()
})

// ===========================================================================
// 回答状態 select → 行絞り込み
// ===========================================================================

describe('FilterBar: 回答状態フィルタ', () => {
  it('「直近正解」選択で last_correct=true の行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
      makeCard(3, { answered: false, last_correct: null }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3)
    })

    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-card-/)
      expect(rows).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
  })

  it('「未回答」選択で answered=false の行のみ残り、 すべてに戻すと全行', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: false }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    const select = screen.getByLabelText('回答状態フィルタ')
    fireEvent.change(select, { target: { value: 'unanswered' } })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-2')).toBeInTheDocument()
    })

    // 'all' に戻すと filter 解除
    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), { target: { value: 'all' } })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))
  })
})

// ===========================================================================
// 連続正解数 → 行絞り込み
// ===========================================================================

describe('FilterBar: 連続正解数フィルタ', () => {
  it('≤ 2 入力で streak<=2 の行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { current_streak: 0 }),
      makeCard(2, { current_streak: 2 }),
      makeCard(3, { current_streak: 5 }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    fireEvent.change(screen.getByLabelText('連続正解数 しきい値'), {
      target: { value: '2' },
    })

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-card-/)
      expect(rows).toHaveLength(2)
      expect(screen.queryByTestId('row-card-3')).not.toBeInTheDocument()
    })

    // 空入力で解除
    fireEvent.change(screen.getByLabelText('連続正解数 しきい値'), { target: { value: '' } })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))
  })

  it('演算子を ≥ に変えると streak>=2 の行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { current_streak: 0 }),
      makeCard(2, { current_streak: 2 }),
      makeCard(3, { current_streak: 5 }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    fireEvent.change(screen.getByLabelText('連続正解数 しきい値'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('連続正解数 演算子'), { target: { value: 'gte' } })

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
      expect(screen.queryByTestId('row-card-1')).not.toBeInTheDocument()
    })
  })
})

// ===========================================================================
// tag フィルタ chip + × 解除 (popover adapter 経路)
// ===========================================================================

describe('FilterBar: tag フィルタ adapter', () => {
  it('popover で option を選ぶと chip 表示 + 行絞り込み、 × で解除', async () => {
    const db = getClientDb()
    const category: ClientTagCategory = {
      id: 'cat-1',
      user_id: USER_ID,
      name: 'Difficulty',
      select_type: 'multi',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const option: ClientTagOption = {
      id: 'opt-1',
      user_id: USER_ID,
      category_id: 'cat-1',
      name: 'Hard',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await db.tag_categories.put(category)
    await db.tag_options.put(option)
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    // card-1 のみ opt-1 を付与
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'opt-1',
      user_id: USER_ID,
      created_at: new Date().toISOString(),
    })

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // popover を開く (filter-bar 内の「タグで絞り込み」 = bar 内に限定して取得)
    const bar = screen.getByTestId('exam-card-table-filter-bar')
    fireEvent.click(within(bar).getByText('タグで絞り込み'))

    // stage1: category 選択
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))

    // stage2: option 選択
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))

    // chip 表示 + 行が card-1 のみに絞られる
    await waitFor(() => {
      expect(screen.getByTestId('filter-chip-opt-1')).toBeInTheDocument()
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    // × で解除 → 全行に戻る
    fireEvent.click(screen.getByLabelText(/フィルタ解除/))
    await waitFor(() => {
      expect(screen.queryByTestId('filter-chip-opt-1')).not.toBeInTheDocument()
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })
  })
})
