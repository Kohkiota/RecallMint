// @vitest-environment jsdom
// exam-card-table-columns unit test (Grid-2 T1)。
// 指標 3 列 cell の描画テスト:
//   - lastCorrect: true → 正 / false → 誤 / null → 「—」
//   - currentStreak: 整数が表示される
//   - lastReview: null → 「未回答」 / 非 null → JST 日時文字列
//   - ExamCardRow.card が full ClientCard を保持し、指標 field にアクセスできる (型 + ランタイム)

import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { render } from '@testing-library/react'
import type { ClientCard } from '@/lib/client-db'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

/** ClientCard の完全形 fixture (指標 field 含む) */
function makeClientCard(overrides: Partial<ClientCard> = {}): ClientCard {
  return {
    id: 'col-test-card-1',
    user_id: 'u-test',
    exam_id: 'e-test',
    title: 'Test Card Title',
    sort_key: '0001',
    question_text: 'What is 2 + 2?',
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

/** ExamCardRow fixture */
function makeRow(cardOverrides: Partial<ClientCard> = {}): ExamCardRow {
  return {
    card: makeClientCard(cardOverrides),
    tags: [],
  }
}

// ---------------------------------------------------------------------------
// helpers: render specific column cell
// ---------------------------------------------------------------------------

/** 指定 column id の cell を render して container を返す */
function renderCell(columnId: string, row: ExamCardRow): HTMLElement {
  const col = examCardTableColumns.find((c) => c.id === columnId)
  if (!col) throw new Error(`Column "${columnId}" not found`)
  if (!col.cell) throw new Error(`Column "${columnId}" has no cell renderer`)

  // TanStack Table の cell renderer を直接 invoke するのは複雑なため、
  // row.original をそのまま渡すシンプルな wrapper component で描画する。
  const cellFn = col.cell as (ctx: { row: { original: ExamCardRow } }) => React.ReactNode

  function Wrapper() {
    return <div data-testid="cell-wrapper">{cellFn({ row: { original: row } })}</div>
  }

  const { container } = render(<Wrapper />)
  return container.querySelector('[data-testid="cell-wrapper"]') as HTMLElement
}

// ---------------------------------------------------------------------------
// case 1: lastCorrect — true / false / null
// ---------------------------------------------------------------------------

describe('Column: lastCorrect', () => {
  it('last_correct=true → 「正」または ○ が表示される', () => {
    const el = renderCell('lastCorrect', makeRow({ last_correct: true }))
    expect(el.textContent).toMatch(/正|○/)
  })

  it('last_correct=false → 「誤」または × が表示される', () => {
    const el = renderCell('lastCorrect', makeRow({ last_correct: false }))
    expect(el.textContent).toMatch(/誤|×/)
  })

  it('last_correct=null → 「—」が表示される', () => {
    const el = renderCell('lastCorrect', makeRow({ last_correct: null }))
    expect(el.textContent).toMatch(/[—\-]/)
  })

  it('last_correct=undefined → 「—」が表示される', () => {
    const card = makeClientCard()
    delete (card as Partial<ClientCard>).last_correct
    const el = renderCell('lastCorrect', { card, tags: [] })
    expect(el.textContent).toMatch(/[—\-]/)
  })
})

// ---------------------------------------------------------------------------
// case 2: currentStreak — 整数表示
// ---------------------------------------------------------------------------

describe('Column: currentStreak', () => {
  it('current_streak=5 → "5" が表示される', () => {
    const el = renderCell('currentStreak', makeRow({ current_streak: 5 }))
    expect(el.textContent).toContain('5')
  })

  it('current_streak=0 (未回答) → "0" が表示される', () => {
    const el = renderCell('currentStreak', makeRow({ current_streak: 0 }))
    expect(el.textContent).toContain('0')
  })
})

// ---------------------------------------------------------------------------
// case 3: lastReview — null → 「未回答」 / 非 null → JST 日時文字列
// ---------------------------------------------------------------------------

describe('Column: lastReview', () => {
  it('last_review=null → 「未回答」が表示される', () => {
    const el = renderCell('lastReview', makeRow({ last_review: null }))
    expect(el.textContent).toContain('未回答')
  })

  it('last_review=undefined → 「未回答」が表示される', () => {
    const card = makeClientCard()
    delete (card as Partial<ClientCard>).last_review
    const el = renderCell('lastReview', { card, tags: [] })
    expect(el.textContent).toContain('未回答')
  })

  it('last_review が ISO 文字列のとき JST 日時が表示される (「未回答」でない)', () => {
    // UTC 2024-06-01T00:00:00Z → JST 2024-06-01 09:00
    const el = renderCell('lastReview', makeRow({ last_review: '2024-06-01T00:00:00.000Z' }))
    expect(el.textContent).not.toContain('未回答')
    // 年月日が含まれることを確認
    expect(el.textContent).toMatch(/2024/)
  })
})

// ---------------------------------------------------------------------------
// case 4 (T3): 全列が数値 size を持つ
// ---------------------------------------------------------------------------

describe('T3: column sizing', () => {
  it('全 column def が number 型の size を持つ', () => {
    for (const col of examCardTableColumns) {
      expect(
        typeof col.size,
        `column "${col.id}" には数値 size が必要`,
      ).toBe('number')
    }
  })

  it('各列の size が仕様値と一致する', () => {
    const sizeMap: Record<string, number> = {
      select: 44,
      title: 240,
      sort_key: 100,
      question: 320,
      options: 240,
      tags: 200,
      explanation_text: 220,
      memo: 220,
      lastCorrect: 96,
      currentStreak: 96,
      lastReview: 160,
    }
    for (const col of examCardTableColumns) {
      if (col.id && col.id in sizeMap) {
        expect(col.size, `column "${col.id}" の size`).toBe(sizeMap[col.id])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// case 6 (T5): 最終列順 + sticky pin 移設 + 4 編集列の存在
// ---------------------------------------------------------------------------

describe('T5: final column order, sticky pin, and editable columns', () => {
  it('column id 配列が最終仕様順と一致する', () => {
    const ids = examCardTableColumns.map((c) => c.id)
    expect(ids).toEqual([
      'select',
      'title',
      'sort_key',
      'question',
      'options',
      'tags',
      'explanation_text',
      'memo',
      'lastCorrect',
      'currentStreak',
      'lastReview',
    ])
  })

  it('title 列に meta.sticky === true が付与されている', () => {
    const titleCol = examCardTableColumns.find((c) => c.id === 'title')
    expect(titleCol).toBeDefined()
    expect((titleCol?.meta as { sticky?: boolean } | undefined)?.sticky).toBe(true)
  })

  it('question 列に meta.sticky が付与されていない (pin 除去済)', () => {
    const questionCol = examCardTableColumns.find((c) => c.id === 'question')
    expect(questionCol).toBeDefined()
    const stickyValue = (questionCol?.meta as { sticky?: boolean } | undefined)?.sticky
    expect(stickyValue).not.toBe(true)
  })

  it('title / sort_key / explanation_text / memo の 4 編集列が存在する', () => {
    const editableIds = ['title', 'sort_key', 'explanation_text', 'memo']
    for (const id of editableIds) {
      const col = examCardTableColumns.find((c) => c.id === id)
      expect(col, `column "${id}" が存在する`).toBeDefined()
      expect(col?.cell, `column "${id}" に cell renderer が存在する`).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// case 5: ExamCardRow.card が full ClientCard を保持し指標 field にアクセスできる
// ---------------------------------------------------------------------------

describe('ExamCardRow.card is full ClientCard', () => {
  it('row.card.last_correct / current_streak / last_review にアクセスできる', () => {
    const row = makeRow({
      last_correct: true,
      current_streak: 3,
      last_review: '2024-06-01T00:00:00.000Z',
    })

    // 型レベルは TypeScript が保証。ランタイムで field が存在することを確認。
    expect(row.card.last_correct).toBe(true)
    expect(row.card.current_streak).toBe(3)
    expect(row.card.last_review).toBe('2024-06-01T00:00:00.000Z')
    // question_text も snake_case でアクセス可能
    expect(row.card.question_text).toBe('What is 2 + 2?')
  })

  it('各指標列が ExamCardRow から正しい値を cell に描画する (統合)', () => {
    // UTC 2024-06-15T12:00:00Z → JST 2024-06-15 21:00 (年が 2024 であることを確認用)
    const row = makeRow({
      last_correct: false,
      current_streak: 7,
      last_review: '2024-06-15T12:00:00.000Z',
    })

    const lastCorrectEl = renderCell('lastCorrect', row)
    const streakEl = renderCell('currentStreak', row)
    const lastReviewEl = renderCell('lastReview', row)

    expect(lastCorrectEl.textContent).toMatch(/誤|×/)
    expect(streakEl.textContent).toContain('7')
    expect(lastReviewEl.textContent).not.toContain('未回答')
    expect(lastReviewEl.textContent).toMatch(/2024/)
  })
})
