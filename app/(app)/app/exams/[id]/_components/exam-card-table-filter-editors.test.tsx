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

vi.mock('@/lib/tags/tag-crud', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tags/tag-crud')>()
  return { ...actual, createOption: mockCreateOption }
})

vi.mock('../_hooks/use-bulk-card-tags', async (importActual) => {
  const actual = await importActual<typeof import('../_hooks/use-bulk-card-tags')>()
  return { ...actual, useBulkCardTags: () => mockBulkTag }
})
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10)。 本 test は画像 gallery の挙動を検証しないため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

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
    question_label: String(n).padStart(4, '0'),
    base_order: 1024,
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

  // 指摘 B: メニュー内フィルタのラベルは input の上・縦積み(flex-col)。
  // 横並び(inline-flex)だと narrow menu(w-36)でラベルが縦に潰れるため。
  it('回答状態 editor はラベルを input の上に置く縦積み(flex-col)レイアウト', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1, { answered: true, last_correct: true })])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const select = within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ')
    const container = select.parentElement
    expect(container?.className).toContain('flex-col')
    expect(container?.className).not.toContain('inline-flex')
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

  // 指摘 B: 連続正解数 editor もラベルを input の上・縦積み(flex-col)。
  it('連続正解数 editor はラベルを input の上に置く縦積み(flex-col)レイアウト', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1, { current_streak: 1 })])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('連続正解数 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    // op select / しきい値 input が共通の flex-col コンテナ配下にある
    const input = within(screen.getByRole('dialog')).getByLabelText('連続正解数 しきい値')
    const container = input.parentElement
    expect(container?.className).toContain('flex-col')
    expect(container?.className).not.toContain('inline-flex')
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

  it('検索ボックスの placeholder / aria が「新規作成」を誘導しない(フィルタ文脈)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory())
    await db.tag_options.put(makeOption())
    await db.cards.bulkPut([makeCard(1)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))

    // stage1 (category): 検索専用文言。「新規作成」を含む input が存在しない。
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    const categorySearch = screen.getByLabelText('カテゴリを検索')
    expect(categorySearch).toHaveAttribute('placeholder', '検索')
    expect(screen.queryByLabelText(/新規作成/)).not.toBeInTheDocument()

    // stage2 (option): 同じく検索専用文言。
    fireEvent.click(screen.getByText('Difficulty'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    const optionSearch = screen.getByLabelText('タグを検索')
    expect(optionSearch).toHaveAttribute('placeholder', '検索')
    expect(screen.queryByLabelText(/新規作成/)).not.toBeInTheDocument()
  })

  it('フィルタ 0 件の空表示も「新規作成」を誘導しない(Codex P2)', async () => {
    const db = getClientDb()
    await db.tag_categories.put(makeCategory())
    await db.tag_options.put(makeOption())
    await db.cards.bulkPut([makeCard(1)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))

    // stage1 で存在しない名前で絞り込む → 空表示。「新規作成」を含まない検索専用の空文言。
    await waitFor(() => expect(screen.getByLabelText('カテゴリを検索')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('カテゴリを検索'), {
      target: { value: 'zzz該当なし名' },
    })
    expect(screen.getByText('該当するカテゴリなし')).toBeInTheDocument()
    expect(screen.queryByText(/新規作成/)).not.toBeInTheDocument()
  })
})

// ===========================================================================
// S4-3 (a) TextColumnEditor — question 列メニュー経由での editor 挙動テスト
// ===========================================================================

describe('FilterEditors: TextColumnEditor — デフォルト op は contains', () => {
  it('question 列メニューを開くと演算子 select のデフォルト値が "contains"', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // S4-3: question 列は非 canSort だが filterEditor 有りで menu が出る
    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    const opSelect = within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ演算子')
    expect((opSelect as HTMLSelectElement).value).toBe('contains')
    // 値必須 op なので input が存在する
    expect(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値')).toBeInTheDocument()
  })
})

describe('FilterEditors: TextColumnEditor — 値入力で行が絞れる', () => {
  it('contains: 検索語を含む行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { question_text: 'Question about Alps' }),
      makeCard(2, { question_text: 'Question about Fuji' }),
      makeCard(3, { question_text: 'Question about Pacific' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Fuji' },
    })

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-card-/)
      expect(rows).toHaveLength(1)
      expect(screen.getByTestId('row-card-2')).toBeInTheDocument()
    })
  })

  it('startsWith: 演算子変更後に対応行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { question_text: 'Alps view' }),
      makeCard(2, { question_text: 'Fuji mountain' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')

    // 演算子を startsWith に変更
    fireEvent.change(within(dialog).getByLabelText('問題文 フィルタ演算子'), {
      target: { value: 'startsWith' },
    })
    // 検索値を入力
    fireEvent.change(within(dialog).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Fuji' },
    })

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-2')).toBeInTheDocument()
    })
  })
})

describe('FilterEditors: TextColumnEditor — 値なし op(empty/notEmpty)', () => {
  it('empty 選択で input が非 render、空のセル行のみ残る', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { explanation_text: null }),
      makeCard(2, { explanation_text: 'Some explanation' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // explanation_text 列メニューを開く
    fireEvent.click(screen.getByRole('button', { name: '解説 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')

    // empty を選択 → input が消える
    fireEvent.change(within(dialog).getByLabelText('解説 フィルタ演算子'), {
      target: { value: 'empty' },
    })

    await waitFor(() => {
      // 値なし op なので input が非 render
      expect(within(dialog).queryByLabelText('解説 フィルタ値')).not.toBeInTheDocument()
      // explanation_text が null(空)の行のみ残る
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
  })

  it('値なし op → 値必須 op へ戻すと local 値が復元されて書き込まれる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { question_text: 'Alps and Snow' }),
      makeCard(2, { question_text: 'Fuji and Cherry' }),
      makeCard(3, { question_text: 'Pacific and Wave' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')

    // Step 1: 'Alps' を入力 → 1 行
    fireEvent.change(within(dialog).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Alps' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // Step 2: empty op へ切替 → input 消え、全行通過ゼロ (question_text は全行非空)
    fireEvent.change(within(dialog).getByLabelText('問題文 フィルタ演算子'), {
      target: { value: 'empty' },
    })
    await waitFor(() => {
      expect(within(dialog).queryByLabelText('問題文 フィルタ値')).not.toBeInTheDocument()
      // 全カードに question_text が入っているため empty で 0 行
      expect(screen.queryAllByTestId(/^row-card-/).length).toBe(0)
    })

    // Step 3: contains へ戻す → local 値 'Alps' が復元されて再度 1 行に絞られる
    fireEvent.change(within(dialog).getByLabelText('問題文 フィルタ演算子'), {
      target: { value: 'contains' },
    })
    await waitFor(() => {
      // input が再表示される
      expect(within(dialog).getByLabelText('問題文 フィルタ値')).toBeInTheDocument()
      // local 値 'Alps' が復元されており 1 行のみ
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
  })
})

describe('FilterEditors: TextColumnEditor — 既存 filter 値からの mount 復元', () => {
  it('filter 設定 → menu 閉じる → 再 open で op/value が復元される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { question_text: 'Alps view' }),
      makeCard(2, { question_text: 'Fuji summit' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // Step 1: 問題文 menu を開き startsWith + 'Fuji' を設定
    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ演算子'), {
      target: { value: 'startsWith' },
    })
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Fuji' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // Step 2: Escape で閉じる
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Step 3: 再 open → editor が filter 値から復元される
    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    const opSelect = within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ演算子')
    expect((opSelect as HTMLSelectElement).value).toBe('startsWith')
    const valueInput = within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値')
    expect((valueInput as HTMLInputElement).value).toBe('Fuji')
  })
})

describe('FilterEditors: TextColumnEditor — 空入力でも filter が残る(undefined に落ちない)', () => {
  it('input を全消しても dot/chip が残り undefined に落ちない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { question_text: 'Alps' }),
      makeCard(2, { question_text: 'Fuji' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    // 'Alps' を入力 → 1 行 + dot 点灯
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Alps' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByRole('img', { name: 'フィルタ適用中' })).toBeInTheDocument()
    })

    // 全消し → value='' で全行通過、だが filter は undefined にならない(dot 維持)
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: '' },
    })
    await waitFor(() => {
      // 全行通過
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
      // dot は残る(filter value は {op:'contains', value:''} で非 undefined)
      expect(screen.getByRole('img', { name: 'フィルタ適用中' })).toBeInTheDocument()
    })
  })
})

// ===========================================================================
// S4-3 (a2) 整合テスト: TEXT_FILTER_COLUMN_IDS の全 id が registry に存在する
// ===========================================================================

describe('S4-3 (a2) 整合テスト: TEXT_FILTER_COLUMN_IDS と cardTableFilterEditors の同期', () => {
  it('TEXT_FILTER_COLUMN_IDS の全 id が cardTableFilterEditors の key に存在する', async () => {
    // 動的 import で循環参照なしに両方を取得
    const { TEXT_FILTER_COLUMN_IDS } = await import('../_lib/card-filter-labels')
    const { cardTableFilterEditors } = await import('./exam-card-table-filter-editors')
    for (const id of TEXT_FILTER_COLUMN_IDS) {
      expect(
        id in cardTableFilterEditors,
        `columnId "${id}" is in TEXT_FILTER_COLUMN_IDS but missing from cardTableFilterEditors`,
      ).toBe(true)
    }
  })

  // 三重管理の第3同期点: labels/registry に加え columns の filterFn attach も一致を明示ガード。
  // 片方漏れ (id は登録済だが filterFn 未 attach) だと chip+editor は出るが絞り込みが silent no-op になる。
  it('TEXT_FILTER_COLUMN_IDS の全 id が columns で filterFn を持つ', async () => {
    const { TEXT_FILTER_COLUMN_IDS } = await import('../_lib/card-filter-labels')
    const { examCardTableColumns } = await import('./exam-card-table-columns')
    for (const id of TEXT_FILTER_COLUMN_IDS) {
      const col = examCardTableColumns.find((c) => c.id === id)
      expect(col, `columnId "${id}" not found in examCardTableColumns`).toBeDefined()
      expect(
        typeof col?.filterFn,
        `columnId "${id}" is in TEXT_FILTER_COLUMN_IDS but has no filterFn attached in columns`,
      ).toBe('function')
    }
  })
})

// ===========================================================================
// S4-3 (c) chip 再編集: テキスト chip click で editor popover が開き値変更が反映される
// ===========================================================================

describe('FilterEditors: S4-3 テキスト chip 再編集 — question filter chip', () => {
  it('chip body クリックで editor が開き、値変更が絞り込みに反映される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { question_text: 'Alps adventure' }),
      makeCard(2, { question_text: 'Fuji experience' }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // Step 1: 問題文 menu から 'Alps' で絞り込む
    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Alps' },
    })
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // Escape で閉じる
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Step 2: ConditionBar に chip が出現する
    const chip = await screen.findByTestId('condition-chip-filter-question')
    expect(chip).toBeInTheDocument()

    // Step 3: chip summary ボタン(× 以外)をクリックして editor を再オープン
    const summaryBtn = within(chip).getAllByRole('button')[0]
    fireEvent.click(summaryBtn)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    // Step 4: editor 内で 'Fuji' に変更
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Fuji' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-2')).toBeInTheDocument()
    })
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
