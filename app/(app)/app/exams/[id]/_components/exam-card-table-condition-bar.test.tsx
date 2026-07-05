// @vitest-environment jsdom
// ConditionBar tests (S1-2 + S2b-3).
// 完了条件 ①–⑦ (S1-2) + (a)–(g) (S2b-3) を網羅:
//   ① deriveConditions: 2 sort + 1 filter → 3 chips in array order (sort first)
//   ② sort chip × → 当該のみ削除
//   ③ sort chip body click → desc flip
//   ④ filter chip × → setFilterValue(undefined) 経路で行復元
//   ⑤ クリア → 全行復帰 + bar 消滅
//   ⑥ 条件ゼロ時 render なし (null)
//   ⑦ hidden 列の条件可視: sort / filter 両 kind で
//      「列 hide → header 消滅 + chip 残存 → chip × → 行/sort 復元」
//   (a) ゾーン振り分け(sort 左 / filter 右)+ 区切り表示 3 態(左空/右空/両空)
//   (b) sort chip プレフィックス無し label
//   (c) tags 2 option 選択 → chip 2 個(色 class + label + option 単位 aria-label)→ 片方 × → value から該当 option のみ消え chip 1 個
//   (d) 全 option × → filterValue undefined(bar 消滅)
//   (e) 欠損 option fallback(selected optionId not in options → chip with optionId label + working ×)
//   (f) 「クリア」文言 + 全解除
//   (g) chip × click で CardTagAddPopover が開かない(stopPropagation)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { ClientCard, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { getClientDb } from '@/lib/client-db'
import { ControlledExamCardTable } from './exam-card-table-test-harness'
import { deriveConditions } from './exam-card-table-condition-bar'

const EXAM_ID = 'test-exam-condition-bar'
const USER_ID = 'test-user-condition-bar'

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
// ① deriveConditions (純関数 unit test)
// ===========================================================================

describe('deriveConditions', () => {
  it('sort 条件を先に、filter 条件を後に、それぞれ配列順で返す', () => {
    const conditions = deriveConditions(
      [
        { id: 'question', desc: false },
        { id: 'lastReview', desc: true },
      ],
      [{ id: 'lastCorrect', value: 'correct' }],
    )
    expect(conditions).toHaveLength(3)
    expect(conditions[0]).toEqual({ kind: 'sort', columnId: 'question', desc: false })
    expect(conditions[1]).toEqual({ kind: 'sort', columnId: 'lastReview', desc: true })
    expect(conditions[2]).toEqual({ kind: 'filter', columnId: 'lastCorrect', value: 'correct' })
  })

  it('条件なし → 空配列', () => {
    expect(deriveConditions([], [])).toHaveLength(0)
  })
})

// ===========================================================================
// ⑥ 条件ゼロ時 render なし
// ===========================================================================

describe('ConditionBar: 条件ゼロ', () => {
  it('sort も filter もない状態では bar は render されない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })

    // クリア ボタンも chip も存在しない
    expect(screen.queryByText('クリア')).not.toBeInTheDocument()
    expect(screen.queryByTestId(/^condition-chip-/)).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ② sort chip × → 当該のみ削除
// ===========================================================================

describe('ConditionBar: sort chip ×', () => {
  it('2 件ソート中に片方の × をクリック → その1件だけ削除される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // タイトル 昇順 sort を追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    // メニューが閉じるのを待ってから次のメニューを開く
    await waitFor(() => expect(screen.queryByText('昇順')).not.toBeInTheDocument())

    // 最終回答日時 昇順 sort を追加
    fireEvent.click(screen.getByLabelText('最終回答日時 の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    // 2 つの sort chip が出る
    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-sort-lastReview')).toBeInTheDocument()
    })

    // タイトル sort の × をクリック
    const questionChip = screen.getByTestId('condition-chip-sort-title')
    fireEvent.click(within(questionChip).getByRole('button', { name: /ソート解除/ }))

    // タイトル chip が消え、最終回答日時 chip は残る
    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-sort-title')).not.toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-sort-lastReview')).toBeInTheDocument()
    })
  })
})

// ===========================================================================
// ③ sort chip body click → desc flip (S2b-3: プレフィックスなし版)
// ===========================================================================

describe('ConditionBar: sort chip body click → flip desc', () => {
  it('昇順 sort chip をクリックすると降順になる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // タイトル 昇順 sort を追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    // ↑ (asc) の chip が出る
    await waitFor(() => {
      const chip = screen.getByTestId('condition-chip-sort-title')
      expect(chip).toHaveTextContent('↑')
    })

    // chip body button (最初の button = flip) をクリックして flip
    // S2b-3: 「並び替え:」プレフィックス削除後は getAllByRole('button')[0] で body を取得
    const chip = screen.getByTestId('condition-chip-sort-title')
    const [bodyBtn] = within(chip).getAllByRole('button')
    fireEvent.click(bodyBtn)

    // ↓ (desc) になる
    await waitFor(() => {
      const chipAfter = screen.getByTestId('condition-chip-sort-title')
      expect(chipAfter).toHaveTextContent('↓')
    })
  })
})

// ===========================================================================
// ④ filter chip × → setFilterValue(undefined) → 行復元
// ===========================================================================

describe('ConditionBar: filter chip ×', () => {
  it('filter chip × クリック → setFilterValue(undefined) → 全行復元', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 直近正誤 header menu で「直近正解」に絞る (S1-5: 固定バー撤去後は header 経由)
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })
    // header menu を閉じる
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // filter chip が出現する
    const filterChip = await screen.findByTestId('condition-chip-filter-lastCorrect')
    expect(filterChip).toBeInTheDocument()

    // × をクリック → setFilterValue(undefined)
    fireEvent.click(within(filterChip).getByRole('button', { name: /フィルタを解除/ }))

    // 全行復元 + chip 消滅
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })
    expect(screen.queryByTestId('condition-chip-filter-lastCorrect')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑤ クリア → 全行復帰 + bar 消滅 (S2b-3: 文言「クリア」)
// ===========================================================================

describe('ConditionBar: クリア', () => {
  it('sort + filter がある状態で クリア → 全行復帰 + bar 消滅', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // sort 追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))
    await waitFor(() => expect(screen.queryByText('昇順')).not.toBeInTheDocument())

    // filter 追加 (1 行だけに絞る) — 直近正誤 header menu 経由
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument()
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // クリア
    fireEvent.click(screen.getByText('クリア'))

    // 全行復帰 + bar 消滅
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
      expect(screen.queryByText('クリア')).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^condition-chip-/)).not.toBeInTheDocument()
    })
  })
})

// ===========================================================================
// Fix 3: filter chip value-summary label assertions
// locks getFilterSummary output for streak branch
// ===========================================================================

describe('ConditionBar: filter chip value-summary labels', () => {
  it('streak filter {op:lte, value:2} → chip に「連続正解数: ≤ 2」が含まれる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1, { current_streak: 0 }), makeCard(2, { current_streak: 5 })])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 連続正解数 header menu で streak ≤ 2 をセット (S1-5: 固定バー撤去後は header 経由)
    fireEvent.click(screen.getByLabelText('連続正解数 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('連続正解数 しきい値'), {
      target: { value: '2' },
    })

    // ConditionBar に streak filter chip が出現し、ラベルが「連続正解数: ≤ 2」を含む
    const chip = await screen.findByTestId('condition-chip-filter-currentStreak')
    expect(chip).toHaveTextContent('連続正解数: ≤ 2')
  })

  // S2b-3: tags は個別 chip 化 — {カテゴリ名}: {option 名} ラベルで検証
  it('tags filter (1 option 選択) → chip 1 個が「{cat}: {opt}」ラベルで出現', async () => {
    const db = getClientDb()
    const category: ClientTagCategory = {
      id: 'cat-label',
      user_id: USER_ID,
      name: 'Difficulty',
      select_type: 'multi',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const option: ClientTagOption = {
      id: 'opt-label',
      user_id: USER_ID,
      category_id: 'cat-label',
      name: 'Hard',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await db.tag_categories.put(category)
    await db.tag_options.put(option)
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    await db.card_tags.put({
      card_id: 'card-1',
      option_id: 'opt-label',
      user_id: USER_ID,
      created_at: new Date().toISOString(),
    })

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // tags header popover で option を 1 件選択 (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))

    // S2b-3: 個別 chip = testid condition-chip-filter-tags-{optionId}、label = {cat}: {opt}
    const chip = await screen.findByTestId('condition-chip-filter-tags-opt-label')
    expect(chip).toHaveTextContent('Difficulty: Hard')
  })
})

// ===========================================================================
// ⑦ hidden 列の条件可視 (sort / filter 両 kind)
// ===========================================================================

describe('ConditionBar: hidden 列の条件可視', () => {
  it('sort 列 hide → header 消滅 + sort chip 残存 → chip × → sort 解除', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // タイトル 列に sort を追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))
    await waitFor(() => expect(screen.queryByText('昇順')).not.toBeInTheDocument())

    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
    })

    // 列トグルを開いて タイトル を非表示にする
    fireEvent.click(screen.getByLabelText('列の表示・非表示'))
    await waitFor(() => expect(screen.getByLabelText('列表示: タイトル')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('列表示: タイトル'))
    // popover を閉じる
    fireEvent.keyDown(document, { key: 'Escape' })

    // タイトル ヘッダー (menu trigger) が消える
    await waitFor(() => {
      expect(screen.queryByLabelText('タイトル の列メニュー')).not.toBeInTheDocument()
    })

    // 条件バーの sort chip は残存する (hidden でも条件は可視)
    expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()

    // chip × クリック → sort 解除 + bar 消滅
    const chip = screen.getByTestId('condition-chip-sort-title')
    fireEvent.click(within(chip).getByRole('button', { name: /ソート解除/ }))

    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-sort-title')).not.toBeInTheDocument()
      expect(screen.queryByText('クリア')).not.toBeInTheDocument()
    })
  })

  it('filter 列 hide → header 消滅 + filter chip 残存 → chip × → 全行復元', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 直近正誤 フィルタを「直近正解」に設定 → 1 行に絞る (S1-5: header menu 経由)
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument()
    })
    // header menu を閉じてから列トグルを操作
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 列トグルを開いて 直近正誤 を非表示にする
    fireEvent.click(screen.getByLabelText('列の表示・非表示'))
    await waitFor(() => expect(screen.getByLabelText('列表示: 直近正誤')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('列表示: 直近正誤'))
    fireEvent.keyDown(document, { key: 'Escape' })

    // 直近正誤 ヘッダー (menu trigger) が消える
    await waitFor(() => {
      expect(screen.queryByLabelText('直近正誤 の列メニュー')).not.toBeInTheDocument()
    })

    // filter chip は残存 + まだ絞り込み中
    expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)

    // chip × クリック → 全行復元
    const chip = screen.getByTestId('condition-chip-filter-lastCorrect')
    fireEvent.click(within(chip).getByRole('button', { name: /フィルタを解除/ }))

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })
    expect(screen.queryByTestId('condition-chip-filter-lastCorrect')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// (a) S2b-3: 2 ゾーン + separator 3 態
// ===========================================================================

describe('ConditionBar S2b-3: 2 ゾーン + separator', () => {
  it('sort のみ → zone-separator なし', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // sort を追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    await waitFor(() => expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument())

    // separator は存在しない(sort のみ)
    expect(screen.queryByTestId('zone-separator')).not.toBeInTheDocument()
  })

  it('filter のみ → zone-separator なし', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // filter を追加
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // separator は存在しない(filter のみ)
    expect(screen.queryByTestId('zone-separator')).not.toBeInTheDocument()
  })

  it('sort + filter 両方 → separator あり、sort chip が左・filter chip が右', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // sort 追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))
    await waitFor(() => expect(screen.queryByText('昇順')).not.toBeInTheDocument())

    // filter 追加
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'), {
      target: { value: 'correct' },
    })
    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument()
      expect(screen.getByTestId('zone-separator')).toBeInTheDocument()
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // DOM 順序: sort chip → separator → filter chip
    const sortChip = screen.getByTestId('condition-chip-sort-title')
    const separator = screen.getByTestId('zone-separator')
    const filterChip = screen.getByTestId('condition-chip-filter-lastCorrect')

    // separator が sortChip の後に来る
    expect(sortChip.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // filterChip が separator の後に来る
    expect(separator.compareDocumentPosition(filterChip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// ===========================================================================
// (b) S2b-3: sort chip プレフィックス無し label
// ===========================================================================

describe('ConditionBar S2b-3: sort chip プレフィックス無し', () => {
  it('sort chip に「並び替え:」プレフィックスが含まれない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // タイトル 昇順 sort を追加
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    await waitFor(() => {
      const chip = screen.getByTestId('condition-chip-sort-title')
      // プレフィックスなし: 「タイトル ↑」のみ含む
      expect(chip).not.toHaveTextContent('並び替え:')
      expect(chip).toHaveTextContent('タイトル ↑')
    })
  })
})

// ===========================================================================
// (c)(d)(g) S2b-3: tags 個別 chip
// ===========================================================================

describe('ConditionBar S2b-3: tags 個別 chip', () => {
  // 共通セットアップ: 1 カテゴリ (multi) + 2 option (red / null color)
  async function setupTwoOptions() {
    const db = getClientDb()
    const category: ClientTagCategory = {
      id: 'cat-multi',
      user_id: USER_ID,
      name: 'Level',
      select_type: 'multi',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const optA: ClientTagOption = {
      id: 'opt-a',
      user_id: USER_ID,
      category_id: 'cat-multi',
      name: 'Easy',
      color: 'red',
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const optB: ClientTagOption = {
      id: 'opt-b',
      user_id: USER_ID,
      category_id: 'cat-multi',
      name: 'Hard',
      color: null,
      sort_key: '0002',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await db.tag_categories.put(category)
    await db.tag_options.bulkPut([optA, optB])
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    return { db, category, optA, optB }
  }

  it('2 option 選択 → chip 2 個 (色 class・label・option 単位 aria-label)', async () => {
    await setupTwoOptions()

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // tags header popover で 2 option を選択 (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Level')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Level'))
    await waitFor(() => expect(screen.getByText('Easy')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Easy'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))
    // popover を閉じる
    fireEvent.keyDown(document, { key: 'Escape' })

    // chip 2 個が出現
    const chipA = await screen.findByTestId('condition-chip-filter-tags-opt-a')
    const chipB = await screen.findByTestId('condition-chip-filter-tags-opt-b')

    // label = {カテゴリ名}: {option 名}
    expect(chipA).toHaveTextContent('Level: Easy')
    expect(chipB).toHaveTextContent('Level: Hard')

    // 色 class: optA は red → colorToClass('red') = 'bg-red-200 text-red-800 border-red-300'
    expect(chipA.className).toContain('bg-red-200')
    // optB は null → colorToClass(null) = COLOR_NULL_CLASS = 'bg-slate-200 ...'
    expect(chipB.className).toContain('bg-slate-200')

    // × ボタンの aria-label: option 単位
    const xBtnA = within(chipA).getByRole('button', { name: /フィルタを解除/ })
    expect(xBtnA).toHaveAttribute('aria-label', 'フィルタを解除: Level: Easy')
    const xBtnB = within(chipB).getByRole('button', { name: /フィルタを解除/ })
    expect(xBtnB).toHaveAttribute('aria-label', 'フィルタを解除: Level: Hard')
  })

  it('片方の × → その option のみ除去・もう 1 chip は残存', async () => {
    await setupTwoOptions()

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 2 option を選択 (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Level')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Level'))
    await waitFor(() => expect(screen.getByText('Easy')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Easy'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-filter-tags-opt-a')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-tags-opt-b')).toBeInTheDocument()
    })

    // opt-a の × をクリック
    const chipA = screen.getByTestId('condition-chip-filter-tags-opt-a')
    fireEvent.click(within(chipA).getByRole('button', { name: /フィルタを解除/ }))

    // opt-a chip が消え、opt-b chip は残る
    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-filter-tags-opt-a')).not.toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-tags-opt-b')).toBeInTheDocument()
    })
  })

  it('全 option × → filterValue undefined (bar 消滅)', async () => {
    const db = getClientDb()
    const category: ClientTagCategory = {
      id: 'cat-single',
      user_id: USER_ID,
      name: 'Status',
      select_type: 'multi',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const opt: ClientTagOption = {
      id: 'opt-single',
      user_id: USER_ID,
      category_id: 'cat-single',
      name: 'Active',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await db.tag_categories.put(category)
    await db.tag_options.put(opt)
    await db.cards.bulkPut([makeCard(1)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 1 option を選択 (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Status')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Status'))
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Active'))
    fireEvent.keyDown(document, { key: 'Escape' })

    const chip = await screen.findByTestId('condition-chip-filter-tags-opt-single')
    expect(chip).toBeInTheDocument()

    // × をクリック → filter 解除
    fireEvent.click(within(chip).getByRole('button', { name: /フィルタを解除/ }))

    // bar 消滅 (filterValue = undefined → conditions.length = 0 → null)
    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-filter-tags-opt-single')).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^condition-chip-/)).not.toBeInTheDocument()
      expect(screen.queryByText('クリア')).not.toBeInTheDocument()
    })
  })

  it('欠損 option → optionId label 無彩色・× 機能', async () => {
    const db = getClientDb()
    const category: ClientTagCategory = {
      id: 'cat-gone',
      user_id: USER_ID,
      name: 'Gone',
      select_type: 'multi',
      color: null,
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const opt: ClientTagOption = {
      id: 'opt-gone',
      user_id: USER_ID,
      category_id: 'cat-gone',
      name: 'WillBeDeleted',
      color: 'red', // was colored, but will be deleted → fallback 無彩色
      sort_key: '0001',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await db.tag_categories.put(category)
    await db.tag_options.put(opt)
    await db.cards.bulkPut([makeCard(1)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // option を選択 (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Gone'))
    await waitFor(() => expect(screen.getByText('WillBeDeleted')).toBeInTheDocument())
    fireEvent.click(screen.getByText('WillBeDeleted'))
    fireEvent.keyDown(document, { key: 'Escape' })

    // chip が出現することを確認
    await screen.findByTestId('condition-chip-filter-tags-opt-gone')

    // opt-gone を Dexie から削除 (category は残す)
    await db.tag_options.delete('opt-gone')

    // live query 更新後: chip は optionId をラベルとして表示 (欠損 fallback)
    // category 'Gone' は残存 → catName = 'Gone'、option なし → optName = 'opt-gone'
    await waitFor(() => {
      const chip = screen.getByTestId('condition-chip-filter-tags-opt-gone')
      expect(chip).toHaveTextContent('Gone: opt-gone')
      // 色は 無彩色 (colorToClass(undefined) = COLOR_NULL_CLASS → bg-slate-200)
      expect(chip.className).toContain('bg-slate-200')
    })

    // × は機能する → filter 解除
    const chip = screen.getByTestId('condition-chip-filter-tags-opt-gone')
    fireEvent.click(within(chip).getByRole('button', { name: /フィルタを解除/ }))

    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-filter-tags-opt-gone')).not.toBeInTheDocument()
      expect(screen.queryByText('クリア')).not.toBeInTheDocument()
    })
  })

  it('chip × click で CardTagAddPopover が開かない (stopPropagation)', async () => {
    await setupTwoOptions()

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 2 option を選択してから chip 状態にする (H-1: outer ColumnHeaderMenu → inner CardTagAddPopover)
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'タグで絞り込み' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'タグで絞り込み' }))
    await waitFor(() => expect(screen.getByText('Level')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Level'))
    await waitFor(() => expect(screen.getByText('Easy')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Easy'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))
    // Esc 1 回目: inner CardTagAddPopover の option stage → category stage (search input 残)
    // Esc 2 回目: inner CardTagAddPopover の category stage → close inner popover
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })

    // ヘッダー popover が完全に閉じ search input が消えるのを待つ
    await waitFor(() => {
      expect(screen.queryByLabelText('category を検索 / 新規作成')).not.toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-filter-tags-opt-a')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-tags-opt-b')).toBeInTheDocument()
    })

    // opt-a の × をクリック
    const chipA = screen.getByTestId('condition-chip-filter-tags-opt-a')
    fireEvent.click(within(chipA).getByRole('button', { name: /フィルタを解除/ }))

    // × click が chip body (CardTagAddPopover trigger) を開かないこと (stopPropagation 効果)
    // → category 検索 input が出ていないことを確認
    expect(screen.queryByLabelText('category を検索 / 新規作成')).not.toBeInTheDocument()

    // opt-b chip は残存 (opt-a のみ除去)
    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-filter-tags-opt-a')).not.toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-tags-opt-b')).toBeInTheDocument()
    })
  })
})

// ===========================================================================
// (f) S2b-3: クリア文言 + clear-all
// ===========================================================================

describe('ConditionBar S2b-3: クリア文言', () => {
  it('条件がある時「クリア」ボタンが存在し、クリックで全条件解除', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // sort を追加してボタン出現確認
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    // 「クリア」ボタンが出現 (「すべてクリア」でないこと)
    await waitFor(() => {
      expect(screen.getByText('クリア')).toBeInTheDocument()
      expect(screen.queryByText('すべてクリア')).not.toBeInTheDocument()
    })

    // クリア → bar 消滅
    fireEvent.click(screen.getByText('クリア'))

    await waitFor(() => {
      expect(screen.queryByText('クリア')).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^condition-chip-/)).not.toBeInTheDocument()
    })
  })
})
