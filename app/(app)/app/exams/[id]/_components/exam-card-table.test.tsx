// @vitest-environment jsdom
// ExamCardTable de-risk smoke (Grid-1 T5)。
// 3 smoke 条件:
//   smoke ①: rowSelection toggle — checkbox click で checked / unchecked が追従する
//   smoke ②: data 差し替え再描画 — Dexie に row 追加で <tr> 数が追従する
//   smoke ③: tag cell props 経路再描画 — card_tags 追加で data-tag-count が追従する
//
// 環境: vitest + jsdom + @testing-library/react + fake-indexeddb (vitest.setup.ts global)。
// useLiveQuery は Dexie への put/add でリアクティブに再評価される (fake-indexeddb 使用)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { getClientDb, type ClientCard, type ClientTagCategory, type ClientTagOption } from '@/lib/client-db'
import { ExamCardTable } from './exam-card-table'

// ---------------------------------------------------------------------------
// test fixtures
// ---------------------------------------------------------------------------

const EXAM_ID = 'test-exam-smoke'
const USER_ID = 'test-user-smoke'

/** ClientCard の必須フィールドを最小限 seed するためのファクトリ */
function makeCard(n: number): ClientCard {
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
  }
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

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
// smoke ①: rowSelection toggle
// ===========================================================================

describe('ExamCardTable smoke ①: rowSelection toggle', () => {
  it('5 rows seed → checkbox click で checked / unchecked が追従する', async () => {
    // seed: 5 cards
    const db = getClientDb()
    await db.cards.bulkPut(Array.from({ length: 5 }, (_, i) => makeCard(i + 1)))

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // 5 rows が描画されるのを待つ
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(5)
    })

    // Card 1 の行の checkbox を見つける
    const checkbox = screen.getByRole('checkbox', { name: /行選択.*Card 1/ })
    expect(checkbox).not.toBeChecked()

    // click → checked
    fireEvent.click(checkbox)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).toBeChecked()
    })

    // 再 click → unchecked
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).not.toBeChecked()
    })
  })
})

// ===========================================================================
// smoke ②: data 差し替え再描画
// ===========================================================================

describe('ExamCardTable smoke ②: data 差し替え再描画', () => {
  it('3 rows seed → render → 2 rows 追加 put → <tr> が 5 に追従する', async () => {
    const db = getClientDb()

    // seed: 3 cards
    await db.cards.bulkPut(Array.from({ length: 3 }, (_, i) => makeCard(i + 1)))

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // 3 rows が描画されるのを待つ
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3)
    })

    // 2 cards 追加 put (合計 5)
    await db.cards.bulkPut([makeCard(4), makeCard(5)])

    // 5 rows に追従するのを待つ
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(5)
    })
  })
})

// ===========================================================================
// smoke ③: tag cell props 経路再描画
// ===========================================================================

describe('ExamCardTable smoke ③: tag cell props 経路再描画', () => {
  it('card 1 件 (tags 0) → card_tags + category + option 追加 → data-tag-count="1" に追従する', async () => {
    const db = getClientDb()

    // seed: 1 card (tags なし)
    const card = makeCard(1)
    await db.cards.put(card)

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // row が描画されるのを待つ
    await waitFor(() => {
      expect(screen.getByTestId(`row-${card.id}`)).toBeInTheDocument()
    })

    // tag-cell の data-tag-count が 0 であることを確認
    const tagCell = screen.getByTestId(`tag-cell-${card.id}`)
    expect(tagCell).toHaveAttribute('data-tag-count', '0')

    // category / option / card_tag を Dexie に追加
    const category: ClientTagCategory = {
      id: 'cat-1',
      user_id: USER_ID,
      name: 'Category 1',
      select_type: 'single',
      color: null,
      sort_key: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const option: ClientTagOption = {
      id: 'opt-1',
      user_id: USER_ID,
      category_id: 'cat-1',
      name: 'Option 1',
      color: null,
      sort_key: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await db.tag_categories.put(category)
    await db.tag_options.put(option)
    await db.card_tags.put({
      card_id: card.id,
      option_id: 'opt-1',
      user_id: USER_ID,
      created_at: new Date().toISOString(),
    })

    // data-tag-count が "1" に追従するのを待つ
    // これが追従しない場合 = TanStack 参照不安定 or 配線設計の問題 = STOP 報告対象
    await waitFor(() => {
      expect(screen.getByTestId(`tag-cell-${card.id}`)).toHaveAttribute('data-tag-count', '1')
    })
  })
})

// ===========================================================================
// smoke ④ (T5): title 列に InlineTextField が描画されること
// ===========================================================================

describe('ExamCardTable smoke ④ (T5): title column renders InlineTextField', () => {
  it('1 row seed → title cell に aria-label="タイトル 編集" の InlineTextField が描画される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // row が描画されるのを待つ
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    // InlineTextField は display mode で role="button" + aria-label を持つ div を描画する
    const titleField = screen.getByRole('button', { name: 'タイトル 編集' })
    expect(titleField).toBeInTheDocument()
  })
})

// ===========================================================================
// smoke ⑤ (T3): th に style width が付与されること + resize handle が存在すること
// ===========================================================================

describe('ExamCardTable smoke ⑤ (T3): column sizing + resize handle', () => {
  it('render 後 th が style.width を持ち、 resize handle が存在する', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])

    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // 1 row が描画されるのを待つ (table が完全 mount された状態)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })

    // th が style width を持つことを確認 (non-vacuous: 空文字でも 0 でもなく正の数値文字列)。
    const allTh = container.querySelectorAll('th')
    expect(allTh.length).toBeGreaterThan(0)
    for (const th of allTh) {
      const widthStyle = (th as HTMLElement).style.width
      // width が CSS px 値として設定されている (例: "320px")
      expect(widthStyle, `th "${th.textContent?.trim()}" に style.width が必要`).toMatch(/^\d+(\.\d+)?px$/)
      const widthPx = parseFloat(widthStyle)
      expect(widthPx, `th "${th.textContent?.trim()}" の width は正値`).toBeGreaterThan(0)
    }

    // resize handle が少なくとも 1 つ存在することを確認 (question 列など resizable 列に付与)。
    // cursor-col-resize クラスで handle を特定する。
    const handles = container.querySelectorAll('.cursor-col-resize')
    expect(handles.length, 'resize handle が 1 つ以上存在する').toBeGreaterThan(0)
  })
})
