// @vitest-environment jsdom
// exam-card-table-columns unit test (Grid-2 T1)。
// 指標 3 列 cell の描画テスト:
//   - lastCorrect: true → 正 / false → 誤 / null → 「—」
//   - currentStreak: 整数が表示される
//   - lastReview: null → 「未回答」 / 非 null → JST 日時文字列
//   - ExamCardRow.card が full ClientCard を保持し、指標 field にアクセスできる (型 + ランタイム)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import type { ClientCard } from '@/lib/client-db'
import { getClientDb } from '@/lib/client-db'
import { examCardTableColumns, type ExamCardRow } from './exam-card-table-columns'

// ---------------------------------------------------------------------------
// Edit-2 T3: mocks for InlineTextField / CompactOptionsCell write paths。
// enqueueEntityMutation / runGuardedEntityMutationFlush を spy mock に差し替える。
// getClientDb (fake-indexeddb) と runOptimisticUpdate は実実装のまま動かす。
// ---------------------------------------------------------------------------

const { mockEnqueue, mockFlush } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

// ---------------------------------------------------------------------------
// Edit-2 T3: setup / teardown for new editable-cell tests。
// 既存テスト (lastCorrect / currentStreak / lastReview) は DB・モックを触らない
// ため影響なし。
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.useRealTimers()
  await getClientDb().cards.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

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
      title: 80, // Edit-3 T4: ~80px 起点 (14px×4 + padding 24px)
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

// ---------------------------------------------------------------------------
// Edit-2 T3: question column → InlineTextField multiline
// ---------------------------------------------------------------------------

describe('Column: question (Edit-2 T3) — InlineTextField multiline', () => {
  it('column attributes: size=320, header="問題文", enableSorting=true, sortingFn present, accessorFn present', () => {
    const col = examCardTableColumns.find((c) => c.id === 'question')
    expect(col).toBeDefined()
    expect(col?.size).toBe(320)
    expect(col?.header).toBe('問題文')
    expect(col?.enableSorting).toBe(true)
    expect(typeof col?.sortingFn).toBe('function')
    // accessorFn は ColumnDef union の全 variant に存在しないため unknown キャストでアクセスする。
    expect(typeof (col as Record<string, unknown> | undefined)?.['accessorFn']).toBe('function')
  })

  it('cell renders InlineTextField with aria-label="問題文 編集" in display mode', () => {
    const el = renderCell('question', makeRow({ question_text: 'テスト問題文テキスト' }))
    // InlineTextField の display mode は role="button" + aria-label を持つ div を描画する
    const btn = el.querySelector('[role="button"][aria-label="問題文 編集"]')
    expect(btn).not.toBeNull()
  })

  it('line-clamp-2 div は存在しない (全文表示・行高可変 = 他 editable text 列と一貫)', () => {
    const el = renderCell('question', makeRow({ question_text: '問題文テキスト' }))
    expect(el.querySelector('.line-clamp-2')).toBeNull()
  })

  it('cell は initialValue として question_text を表示する', () => {
    const el = renderCell('question', makeRow({ question_text: '2 + 2 = ?' }))
    expect(el.textContent).toContain('2 + 2 = ?')
  })

  it('screen.getByRole("button") で aria-label が取得できる', () => {
    renderCell('question', makeRow({ question_text: 'テスト' }))
    // テスト内でレンダーされた button が screen からアクセスできる
    expect(screen.getByRole('button', { name: '問題文 編集' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T1: question / explanation_text / memo の InlineTextField displayClassName="text-sm"
// ---------------------------------------------------------------------------

describe('Edit-3 T1: question / explanation_text / memo に displayClassName="text-sm" が渡る', () => {
  // T1 Minor 2 fix: as HTMLElement cast → null safe + toContain(substring) → split+toContain(exact)
  it('question cell の display div に text-sm クラスが付与される', () => {
    renderCell('question', makeRow({ question_text: 'テスト問題文' }))
    const displayDiv = screen.getByRole('button', { name: '問題文 編集' })
    expect(displayDiv.className.split(' ')).toContain('text-sm')
  })

  it('explanation_text cell の display div に text-sm クラスが付与される', () => {
    renderCell('explanation_text', makeRow({ explanation_text: '解説テキスト' }))
    const displayDiv = screen.getByRole('button', { name: '解説 編集' })
    expect(displayDiv.className.split(' ')).toContain('text-sm')
  })

  it('memo cell の display div に text-sm クラスが付与される', () => {
    renderCell('memo', makeRow({ memo: 'メモテキスト' }))
    const displayDiv = screen.getByRole('button', { name: 'メモ 編集' })
    expect(displayDiv.className.split(' ')).toContain('text-sm')
  })

  it('title cell の display div には text-sm が付与されない (対象外列の回帰)', () => {
    renderCell('title', makeRow({ title: 'タイトル' }))
    const displayDiv = screen.getByRole('button', { name: 'タイトル 編集' })
    expect(displayDiv.className.split(' ')).not.toContain('text-sm')
  })

  it('sort_key cell の display div には text-sm が付与されない (対象外列の回帰)', () => {
    renderCell('sort_key', makeRow({ sort_key: '0001' }))
    const displayDiv = screen.getByRole('button', { name: 'ソートキー 編集' })
    expect(displayDiv.className.split(' ')).not.toContain('text-sm')
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T2: question / explanation_text / memo の displayClassName に md:min-h-6 が追加され
// twMerge で md:min-h-8 を上書きする。inner box(display div)に効くことを assert。
// ---------------------------------------------------------------------------

describe('Edit-3 T2: question / explanation_text / memo の display div に md:min-h-6 が付く', () => {
  it('question display div に md:min-h-6 が付き md:min-h-8 がない (twMerge 上書き)', () => {
    renderCell('question', makeRow({ question_text: 'テスト' }))
    const displayDiv = screen.getByRole('button', { name: '問題文 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('explanation_text display div に md:min-h-6 が付き md:min-h-8 がない', () => {
    renderCell('explanation_text', makeRow({ explanation_text: '解説' }))
    const displayDiv = screen.getByRole('button', { name: '解説 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('memo display div に md:min-h-6 が付き md:min-h-8 がない', () => {
    renderCell('memo', makeRow({ memo: 'メモ' }))
    const displayDiv = screen.getByRole('button', { name: 'メモ 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('title display div には md:min-h-6 が付かない (table で渡さない列の回帰)', () => {
    renderCell('title', makeRow({ title: 'タイトル' }))
    const displayDiv = screen.getByRole('button', { name: 'タイトル 編集' })
    const classes = displayDiv.className.split(' ')
    // title に displayClassName を渡さないので md:min-h-8 が残る
    expect(classes).not.toContain('md:min-h-6')
    expect(classes).toContain('md:min-h-8')
  })
})

// ---------------------------------------------------------------------------
// Edit-2 T3: options column → CompactOptionsCell
// ---------------------------------------------------------------------------

describe('Column: options (Edit-2 T3) — CompactOptionsCell', () => {
  it('column attributes: size=240, header="選択肢", enableSorting=false', () => {
    const col = examCardTableColumns.find((c) => c.id === 'options')
    expect(col).toBeDefined()
    expect(col?.size).toBe(240)
    expect(col?.header).toBe('選択肢')
    expect(col?.enableSorting).toBe(false)
  })

  it('cell renders CompactOptionsCell — "+ 選択肢を追加" button が存在する', () => {
    const el = renderCell(
      'options',
      makeRow({
        options: [
          { id: 'a', text: '選択肢A', is_correct: true },
          { id: 'b', text: '選択肢B', is_correct: false },
        ],
      }),
    )
    // CompactOptionsCell は常に "+ 選択肢を追加" add button を描画する
    const addBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('+ 選択肢を追加'),
    )
    expect(addBtn).toBeDefined()
  })

  it('cell renders option rows — 各 option に削除ボタンが描画される', () => {
    const el = renderCell(
      'options',
      makeRow({
        options: [
          { id: 'a', text: '選択肢A', is_correct: true },
          { id: 'b', text: '選択肢B', is_correct: false },
        ],
      }),
    )
    const deleteBtns = el.querySelectorAll('[aria-label="選択肢を削除"]')
    expect(deleteBtns.length).toBe(2)
  })

  it('screen.getByRole("button", { name: "\\+ 選択肢を追加" }) がアクセスできる', () => {
    renderCell('options', makeRow({ options: [] }))
    expect(screen.getByRole('button', { name: '+ 選択肢を追加' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T4: title size 80 + sort_key enableHiding 維持
// ---------------------------------------------------------------------------

describe('Edit-3 T4: title size 80 + sort_key getCanHide() 維持', () => {
  it('title column size が 80 (~80px 起点)', () => {
    const titleCol = examCardTableColumns.find((c) => c.id === 'title')
    expect(titleCol?.size).toBe(80)
  })

  it('sort_key column に enableHiding=false が設定されていない (getCanHide() === true を保証)', () => {
    const sortKeyCol = examCardTableColumns.find((c) => c.id === 'sort_key')
    expect(sortKeyCol).toBeDefined()
    // enableHiding=false が設定されると getCanHide()===false になり toggle UI から除外される。
    // 再表示できなくなるため設定しない。
    expect((sortKeyCol as unknown as Record<string, unknown>)?.['enableHiding']).not.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T3: select 列と title 列の sticky meta (stickyLeft)
// ---------------------------------------------------------------------------

describe('Edit-3 T3: select 列と title 列の sticky meta', () => {
  it('select 列に meta.sticky === true と meta.stickyLeft === 0 が付与されている', () => {
    const selectCol = examCardTableColumns.find((c) => c.id === 'select')
    expect(selectCol).toBeDefined()
    const meta = selectCol?.meta as { sticky?: boolean; stickyLeft?: number } | undefined
    expect(meta?.sticky).toBe(true)
    expect(meta?.stickyLeft).toBe(0)
  })

  it('title 列に meta.sticky === true と meta.stickyLeft === 44 が付与されている', () => {
    const titleCol = examCardTableColumns.find((c) => c.id === 'title')
    expect(titleCol).toBeDefined()
    const meta = titleCol?.meta as { sticky?: boolean; stickyLeft?: number } | undefined
    expect(meta?.sticky).toBe(true)
    expect(meta?.stickyLeft).toBe(44)
  })

  it('非 sticky 列(question)に meta.sticky が付与されていない', () => {
    const questionCol = examCardTableColumns.find((c) => c.id === 'question')
    expect(questionCol).toBeDefined()
    const meta = questionCol?.meta as { sticky?: boolean; stickyLeft?: number } | undefined
    expect(meta?.sticky).not.toBe(true)
    expect(meta?.stickyLeft).toBeUndefined()
  })
})
