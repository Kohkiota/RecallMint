// @vitest-environment jsdom
// exam-card-table-filter-editors.test.tsx — S1-3
// filter-editors registry の統合テスト: header menu / tags header 経由で editor を開き
// filter-bar.test.tsx と同値の行絞り込み結果を検証する。
//
// 重要: S1-3 は旧 fixed filter bar と新 editors が共存する期間。
//   aria-label 衝突 ("回答状態フィルタ" / "連続正解数 しきい値" が DOM に 2 個) を
//   within(<opened dialog>) スコーピングで回避する (リネーム禁止・filter-bar 変更禁止)。
//
// 追加カバレッジ (S1-3 完了条件):
//   - chip-click reopen: existing filter → value change reflected
//   - selectOnly: tags editor shows NO 新規作成/kebab affordance
//   - tag 全解除 → filter value が `undefined` になり chip/rows が消える (空 {} 残置 = dot 誤点灯)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import {
  getClientDb,
  type ClientCard,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'

// ---------------------------------------------------------------------------
// Mocks (same pattern as exam-card-table-header-menu.test.tsx)
// ---------------------------------------------------------------------------

const { mockCreateOption, mockBulkTag } = vi.hoisted(() => ({
  mockCreateOption: vi.fn(async () => 'new-opt-editor-test'),
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

import { ControlledExamCardTable } from './exam-card-table-test-harness'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const EXAM_ID = 'test-exam-editors'
const USER_ID = 'test-user-editors'

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

function makeCategory(overrides: Partial<ClientTagCategory> = {}): ClientTagCategory {
  return {
    id: 'cat-editors-1',
    user_id: USER_ID,
    name: 'Difficulty',
    select_type: 'multi',
    color: null,
    sort_key: '0001',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeOption(overrides: Partial<ClientTagOption> = {}): ClientTagOption {
  return {
    id: 'opt-editors-1',
    user_id: USER_ID,
    category_id: 'cat-editors-1',
    name: 'Hard',
    color: null,
    sort_key: '0001',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
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
// 回答状態: lastCorrect header menu → filter
// ===========================================================================

describe('FilterEditors: 回答状態フィルタ (header menu 経由)', () => {
  it('「直近正解」選択で last_correct=true の行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
      makeCard(3, { answered: false, last_correct: null }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3)
    })

    // 直近正誤 列のヘッダーメニューを開く
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    // dialog 内でフィルタ select を操作 (aria-label 衝突を within で回避)
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-card-/)
      expect(rows).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
  })

  it('「直近正解」→「すべて」に戻すと全行復元', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 直近正誤 header menu → 「直近正解」に設定
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 同じ dialog で「すべて」に戻す
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'all' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))
  })
})

// ===========================================================================
// 連続正解数: currentStreak header menu → filter
// ===========================================================================

describe('FilterEditors: 連続正解数フィルタ (header menu 経由)', () => {
  it('≤ 2 入力で streak<=2 の行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { current_streak: 0 }),
      makeCard(2, { current_streak: 2 }),
      makeCard(3, { current_streak: 5 }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    // 連続正解数 header menu を開く
    fireEvent.click(screen.getByLabelText('連続正解数 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    // dialog 内でしきい値 input を操作
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('連続正解数 しきい値'), {
      target: { value: '2' },
    })

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-card-/)
      expect(rows).toHaveLength(2)
      expect(screen.queryByTestId('row-card-3')).not.toBeInTheDocument()
    })
  })

  it('空入力で filter 解除 → 全行復元', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { current_streak: 0 }),
      makeCard(2, { current_streak: 5 }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // filter 設定
    fireEvent.click(screen.getByLabelText('連続正解数 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('連続正解数 しきい値'), {
      target: { value: '2' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 空入力で解除
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('連続正解数 しきい値'), {
      target: { value: '' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))
  })
})

// ===========================================================================
// タグ: tags header popover → filter + chip × 解除
// ===========================================================================

describe('FilterEditors: tag フィルタ (tags header popover 経由)', () => {
  it('popover で option を選ぶと行絞り込み、chip × で解除', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory())
    await db.tag_options.put(makeOption())
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'opt-editors-1',
      user_id: USER_ID,
      created_at: new Date().toISOString(),
    })

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // タグ列ヘッダー: H-1 流儀で outer ColumnHeaderMenu → inner CardTagAddPopover を開く
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))

    // stage1: category 選択
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))

    // stage2: option 選択
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))

    // 行が card-1 のみに絞られる
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    // ConditionBar の filter chip × をクリックして解除 (S2b-3: testid は option 単位)
    const chip = await screen.findByTestId('condition-chip-filter-tags-opt-editors-1')
    fireEvent.click(within(chip).getByRole('button', { name: /フィルタを解除/ }))

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
      expect(screen.queryByTestId('condition-chip-filter-tags-opt-editors-1')).not.toBeInTheDocument()
    })
  })
})

// ===========================================================================
// chip-click reopen: existing filter → value change reflected
// ===========================================================================

describe('FilterEditors: chip-click reopen で値変更が反映される', () => {
  it('lastCorrect chip body クリックでエディタが開き、値を変更すると絞り込みが更新される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // Step 1: 直近正誤 header menu で「直近正解」に設定 → 1 行に絞る
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    // メニューを閉じる (Escape)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Step 2: ConditionBar の filter chip が出現している
    const chip = await screen.findByTestId('condition-chip-filter-lastCorrect')
    expect(chip).toBeInTheDocument()

    // Step 3: chip body (summary button) をクリックしてエディタを再オープン
    // chip 内の summary ボタン (× ではない方) をクリック
    const summaryBtn = within(chip).getAllByRole('button')[0]
    fireEvent.click(summaryBtn)

    // エディタ popover が開く
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    // Step 4: chip editor 内で値を「直近不正解」に変更
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'incorrect' },
    })

    // card-2 (last_correct=false) のみが表示される
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-2')).toBeInTheDocument()
    })
  })
})

// ===========================================================================
// selectOnly: tags editor shows NO 新規作成/kebab affordance
// ===========================================================================

describe('FilterEditors: selectOnly で新規作成/編集導線が非表示', () => {
  it('tags header editor を開くと kebab ボタンが存在しない', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory())
    await db.tag_options.put(makeOption())
    await db.cards.bulkPut([makeCard(1)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // tags header から editor を開く (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))

    // category 一覧が出る
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())

    // selectOnly=true のため kebab ボタン (カテゴリ操作: Difficulty) が存在しない
    expect(screen.queryByRole('button', { name: /カテゴリ操作/ })).not.toBeInTheDocument()

    // category を選択して option stage へ
    fireEvent.click(screen.getByText('Difficulty'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())

    // option stage でも kebab が存在しない
    expect(screen.queryByRole('button', { name: /option 操作/ })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// tag 全解除 → filter value becomes `undefined` (空 {} 残置 = dot 誤点灯防止)
// ===========================================================================

describe('FilterEditors: tag 全解除で filter value が undefined になる', () => {
  it('全 option を選択解除すると ConditionBar chip が消え全行復元される', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory())
    await db.tag_options.put(makeOption())
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'opt-editors-1',
      user_id: USER_ID,
      created_at: new Date().toISOString(),
    })

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // Step 1: tags header から Hard を選択 → 絞り込み (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      // S2b-3: testid は option 単位 condition-chip-filter-tags-{optionId}
      expect(screen.getByTestId('condition-chip-filter-tags-opt-editors-1')).toBeInTheDocument()
    })

    // Step 2: S2b-3 では per-option chip の × で直接解除できる。
    // handleTagsChipToggle 除去経路: 空カテゴリ prune + 空 map → undefined (= dot 消灯)。
    const chip = screen.getByTestId('condition-chip-filter-tags-opt-editors-1')
    fireEvent.click(within(chip).getByRole('button', { name: /フィルタを解除/ }))

    // filter value が undefined になり chip/rows が消える
    // (空 {} が残ると chip は消えず rows も絞られたまま → 誤点灯)
    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-filter-tags-opt-editors-1')).not.toBeInTheDocument()
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })
  })
})
