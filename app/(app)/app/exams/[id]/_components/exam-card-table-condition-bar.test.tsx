// @vitest-environment jsdom
// ConditionBar tests (S1-2).
// 完了条件 ①–⑦ を網羅:
//   ① deriveConditions: 2 sort + 1 filter → 3 chips in array order (sort first)
//   ② sort chip × → 当該のみ削除
//   ③ sort chip body click → desc flip
//   ④ filter chip × → setFilterValue(undefined) 経路で行復元
//   ⑤ すべてクリア → 全行復帰 + bar 消滅
//   ⑥ 条件ゼロ時 render なし (null)
//   ⑦ hidden 列の条件可視: sort / filter 両 kind で
//      「列 hide → header 消滅 + chip 残存 → chip × → 行/sort 復元」

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { ClientCard, ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { getClientDb } from '@/lib/client-db'
import { ExamCardTable } from './exam-card-table'
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

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })

    // すべてクリア ボタンも chip も存在しない
    expect(screen.queryByText('すべてクリア')).not.toBeInTheDocument()
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

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 問題文 昇順 sort を追加
    fireEvent.click(screen.getByLabelText('問題文 の列メニュー'))
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
      expect(screen.getByTestId('condition-chip-sort-question')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-sort-lastReview')).toBeInTheDocument()
    })

    // 問題文 sort の × をクリック
    const questionChip = screen.getByTestId('condition-chip-sort-question')
    fireEvent.click(within(questionChip).getByRole('button', { name: /ソート解除/ }))

    // 問題文 chip が消え、最終回答日時 chip は残る
    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-sort-question')).not.toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-sort-lastReview')).toBeInTheDocument()
    })
  })
})

// ===========================================================================
// ③ sort chip body click → desc flip
// ===========================================================================

describe('ConditionBar: sort chip body click → flip desc', () => {
  it('昇順 sort chip をクリックすると降順になる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 問題文 昇順 sort を追加
    fireEvent.click(screen.getByLabelText('問題文 の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))

    // ↑ (asc) の chip が出る
    await waitFor(() => {
      const chip = screen.getByTestId('condition-chip-sort-question')
      expect(chip).toHaveTextContent('↑')
    })

    // chip body button をクリックして flip
    const chip = screen.getByTestId('condition-chip-sort-question')
    const bodyBtn = within(chip).getByRole('button', { name: /並び替え:/ })
    fireEvent.click(bodyBtn)

    // ↓ (desc) になる
    await waitFor(() => {
      const chipAfter = screen.getByTestId('condition-chip-sort-question')
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

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 固定フィルタバーで「直近正解」に絞る
    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), { target: { value: 'correct' } })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

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
// ⑤ すべてクリア → 全行復帰 + bar 消滅
// ===========================================================================

describe('ConditionBar: すべてクリア', () => {
  it('sort + filter がある状態で すべてクリア → 全行復帰 + bar 消滅', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // sort 追加
    fireEvent.click(screen.getByLabelText('問題文 の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))
    await waitFor(() => expect(screen.queryByText('昇順')).not.toBeInTheDocument())

    // filter 追加 (1 行だけに絞る)
    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), { target: { value: 'correct' } })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('condition-chip-sort-question')).toBeInTheDocument()
      expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument()
    })

    // すべてクリア
    fireEvent.click(screen.getByText('すべてクリア'))

    // 全行復帰 + bar 消滅
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
      expect(screen.queryByText('すべてクリア')).not.toBeInTheDocument()
      expect(screen.queryByTestId(/^condition-chip-/)).not.toBeInTheDocument()
    })
  })
})

// ===========================================================================
// Fix 3: filter chip value-summary label assertions
// locks getFilterSummary output for streak and tag branches
// ===========================================================================

describe('ConditionBar: filter chip value-summary labels', () => {
  it('streak filter {op:lte, value:2} → chip に「連続正解数: ≤ 2」が含まれる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1, { current_streak: 0 }), makeCard(2, { current_streak: 5 })])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // fixed bar で streak ≤ 2 をセット
    fireEvent.change(screen.getByLabelText('連続正解数 しきい値'), { target: { value: '2' } })

    // ConditionBar に streak filter chip が出現し、ラベルが「連続正解数: ≤ 2」を含む
    const chip = await screen.findByTestId('condition-chip-filter-currentStreak')
    expect(chip).toHaveTextContent('連続正解数: ≤ 2')
  })

  it('tags filter (1 option 選択) → chip に「タグ: 1 件」が含まれる', async () => {
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

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // fixed bar の tag popover で option を 1 件選択
    const bar = screen.getByTestId('exam-card-table-filter-bar')
    fireEvent.click(within(bar).getByText('タグで絞り込み'))
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))
    await waitFor(() => expect(screen.getByText('Hard')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Hard'))

    // ConditionBar に tags filter chip が出現し、ラベルが「タグ: 1 件」を含む
    // (count = Object.values({'cat-label': ['opt-label']}).flat().length = 1)
    const chip = await screen.findByTestId('condition-chip-filter-tags')
    expect(chip).toHaveTextContent('タグ: 1 件')
  })
})

// ===========================================================================
// Fix 2 TDD: streak filter clear via ConditionBar → op change must not reapply
// ===========================================================================

describe('FilterBar + ConditionBar coexistence: streak sync after external clear', () => {
  it('[TDD-RED→GREEN] ConditionBar で streak クリア後に演算子変更しても filter は再適用されない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { current_streak: 0 }),
      makeCard(2, { current_streak: 2 }),
      makeCard(3, { current_streak: 5 }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    // Step 1: fixed bar で streak ≤ 2 に絞る
    fireEvent.change(screen.getByLabelText('連続正解数 しきい値'), { target: { value: '2' } })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
      expect(screen.queryByTestId('row-card-3')).not.toBeInTheDocument()
    })

    // Step 2: ConditionBar の currentStreak filter chip × でクリア
    const filterChip = await screen.findByTestId('condition-chip-filter-currentStreak')
    fireEvent.click(within(filterChip).getByRole('button', { name: /フィルタを解除/ }))

    // 全行復元を確認
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3)
    })
    expect(screen.queryByTestId('condition-chip-filter-currentStreak')).not.toBeInTheDocument()

    // Step 3: fixed bar の op を 'gte' に変更 → filter は再適用されない
    fireEvent.change(screen.getByLabelText('連続正解数 演算子'), { target: { value: 'gte' } })

    // 全 3 行が維持される (stale streakInput '2' で再適用されてはいけない)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3)
    })
    expect(screen.queryByTestId('condition-chip-filter-currentStreak')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑦ hidden 列の条件可視 (sort / filter 両 kind)
// ===========================================================================

describe('ConditionBar: hidden 列の条件可視', () => {
  it('sort 列 hide → header 消滅 + sort chip 残存 → chip × → sort 解除', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 問題文 列に sort を追加
    fireEvent.click(screen.getByLabelText('問題文 の列メニュー'))
    await waitFor(() => expect(screen.getByText('昇順')).toBeInTheDocument())
    fireEvent.click(screen.getByText('昇順'))
    await waitFor(() => expect(screen.queryByText('昇順')).not.toBeInTheDocument())

    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-question')).toBeInTheDocument()
    })

    // 列トグルを開いて 問題文 を非表示にする
    fireEvent.click(screen.getByLabelText('列の表示・非表示'))
    await waitFor(() => expect(screen.getByLabelText('列表示: 問題文')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('列表示: 問題文'))
    // popover を閉じる
    fireEvent.keyDown(document, { key: 'Escape' })

    // 問題文 ヘッダー (menu trigger) が消える
    await waitFor(() => {
      expect(screen.queryByLabelText('問題文 の列メニュー')).not.toBeInTheDocument()
    })

    // 条件バーの sort chip は残存する (hidden でも条件は可視)
    expect(screen.getByTestId('condition-chip-sort-question')).toBeInTheDocument()

    // chip × クリック → sort 解除 + bar 消滅
    const chip = screen.getByTestId('condition-chip-sort-question')
    fireEvent.click(within(chip).getByRole('button', { name: /ソート解除/ }))

    await waitFor(() => {
      expect(screen.queryByTestId('condition-chip-sort-question')).not.toBeInTheDocument()
      expect(screen.queryByText('すべてクリア')).not.toBeInTheDocument()
    })
  })

  it('filter 列 hide → header 消滅 + filter chip 残存 → chip × → 全行復元', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1, { answered: true, last_correct: true }),
      makeCard(2, { answered: true, last_correct: false }),
    ])

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 直近正誤 フィルタを「直近正解」に設定 → 1 行に絞る
    fireEvent.change(screen.getByLabelText('回答状態フィルタ'), { target: { value: 'correct' } })
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('condition-chip-filter-lastCorrect')).toBeInTheDocument()
    })

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
