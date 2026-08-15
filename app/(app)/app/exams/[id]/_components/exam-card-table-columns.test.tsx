// @vitest-environment jsdom
// exam-card-table-columns unit test (Grid-2 T1)。
// 指標 3 列 cell の描画テスト:
//   - lastCorrect: true → 正 / false → 誤 / null → 「—」
//   - currentStreak: 整数が表示される
//   - lastReview: null → 「未回答」 / 非 null → JST 日時文字列
//   - ExamCardRow.card が full ClientCard を保持し、指標 field にアクセスできる (型 + ランタイム)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table'
import { renderHook } from '@testing-library/react'
import type { ClientCard, ClientCardImage } from '@/lib/client-db'
import { getClientDb } from '@/lib/client-db'
import type { TextFilterValue } from '@/lib/cards/card-filter-predicates'

// ---------------------------------------------------------------------------
// Edit-2 T3: mocks for InlineTextField / CompactOptionsCell write paths。
// enqueueEntityMutation / runGuardedEntityMutationFlush を spy mock に差し替える。
// getClientDb (fake-indexeddb) と runOptimisticUpdate は実実装のまま動かす。
// ---------------------------------------------------------------------------

const { mockEnqueue, mockFlush, mockGetAssetObjectURL, mockAttachImageToCard } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => ({}) as never),
  mockFlush: vi.fn(async () => 'no-pending' as const),
  // Sprint T T6: サムネ配線 test 用に objectURL を返す(既存テストは images:[] ゆえ未呼出)。
  mockGetAssetObjectURL: vi.fn(async () => 'blob:mock-object-url' as string | null),
  // Sprint T add(2026-07-17): add affordance の attach 経路検証用。
  mockAttachImageToCard: vi.fn(async () => ({ ok: true, assetId: 'asset-x' }) as never),
}))

vi.mock('@/lib/sync/entity-mutations', () => ({
  enqueueEntityMutation: mockEnqueue,
}))
vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))
// card-editor-fields.tsx → card-image-gallery.tsx が '../_actions/asset-actions' (server
// action) を import する。 実 module は lib/storage/r2.ts の R2_* env fail-fast を経由し、
// vitest.setup.ts は R2_* を供給しないため未 mock だと module load 時に throw する
// (画像フェーズ A Task 10、 './exam-card-table-columns' → inline-card-list.tsx 経由の
// transitive import)。 本 test は画像 gallery の挙動を検証しないため最小 stub。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: mockGetAssetObjectURL,
}))
vi.mock('@/lib/media/upload', () => ({
  attachImageToCard: mockAttachImageToCard,
  removeImageFromCard: vi.fn(async () => {}),
}))

import { examCardTableColumns, type ExamCardRow, type ExamCardTableMeta } from './exam-card-table-columns'

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
    question_label: '0001',
    base_order: 1024,
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

// Sprint B Important-1: question / options cell は owner を meta.userId から取るよう
// 変更され、`if (!meta) return null` を持つ (exam-card-table-columns.tsx)。meta を渡さない
// renderCell 呼び出しは cell が丸ごと描画されなくなるため、内容を検証するテストは meta を渡す。
const META: Partial<ExamCardTableMeta> = { userId: 'user-owner' }

// ---------------------------------------------------------------------------
// helpers: render specific column cell
// ---------------------------------------------------------------------------

/** 指定 column id の cell を render して container を返す。
 * Sprint T T6: 一部 cell(question/explanation_text/memo/options)が table.options.meta を
 * 読むようになったため、TanStack の cell 契約どおり table を必ず渡す(meta 省略時は undefined)。 */
function renderCell(
  columnId: string,
  row: ExamCardRow,
  meta?: Partial<ExamCardTableMeta>,
): HTMLElement {
  const col = examCardTableColumns.find((c) => c.id === columnId)
  if (!col) throw new Error(`Column "${columnId}" not found`)
  if (!col.cell) throw new Error(`Column "${columnId}" has no cell renderer`)

  // TanStack Table の cell renderer を直接 invoke するのは複雑なため、
  // row.original と table.options.meta を渡すシンプルな wrapper component で描画する。
  const cellFn = col.cell as (ctx: {
    row: { original: ExamCardRow }
    table: { options: { meta: unknown } }
  }) => React.ReactNode

  function Wrapper() {
    return (
      <div data-testid="cell-wrapper">
        {cellFn({ row: { original: row }, table: { options: { meta } } })}
      </div>
    )
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
      select: 52, // row-ux UI fix A-2: グリップ(24px)+ gap(4px)+ checkbox(16px)+ px-1(td 側 8px)= 52px。最小幅まで詰めた(旧 72 は +20px の余裕込み)
      title: 80, // Edit-3 T4: ~80px 起点 (14px×4 + padding 24px)
      question_label: 100,
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
      'question_label',
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

  it('title 列に meta.sticky が付与されていない (Fix-3 T2 sticky 撤去済)', () => {
    const titleCol = examCardTableColumns.find((c) => c.id === 'title')
    expect(titleCol).toBeDefined()
    expect((titleCol?.meta as { sticky?: boolean } | undefined)?.sticky).toBeUndefined()
  })

  it('question 列に meta.sticky が付与されていない (pin 除去済)', () => {
    const questionCol = examCardTableColumns.find((c) => c.id === 'question')
    expect(questionCol).toBeDefined()
    const stickyValue = (questionCol?.meta as { sticky?: boolean } | undefined)?.sticky
    expect(stickyValue).not.toBe(true)
  })

  it('title / sort_key / explanation_text / memo の 4 編集列が存在する', () => {
    const editableIds = ['title', 'question_label', 'explanation_text', 'memo']
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
  // S3-1: 問題文ソート撤去 — enableSorting:false / sortingFn 除去 / accessorFn は表示用に残置。
  it('column attributes: size=320, header="問題文", enableSorting=false, sortingFn absent, accessorFn present', () => {
    const col = examCardTableColumns.find((c) => c.id === 'question')
    expect(col).toBeDefined()
    expect(col?.size).toBe(320)
    expect(col?.header).toBe('問題文')
    expect(col?.enableSorting).toBe(false)
    expect(col?.sortingFn).toBeUndefined()
    // accessorFn は表示用 (question_text) のために残置している。
    expect(typeof (col as Record<string, unknown> | undefined)?.['accessorFn']).toBe('function')
  })

  it('cell renders InlineTextField with aria-label="問題文 編集" in display mode', () => {
    const el = renderCell('question', makeRow({ question_text: 'テスト問題文テキスト' }), META)
    // InlineTextField の display mode は role="button" + aria-label を持つ div を描画する
    const btn = el.querySelector('[role="button"][aria-label="問題文 編集"]')
    expect(btn).not.toBeNull()
  })

  it('line-clamp-2 div は存在しない (全文表示・行高可変 = 他 editable text 列と一貫)', () => {
    const el = renderCell('question', makeRow({ question_text: '問題文テキスト' }), META)
    expect(el.querySelector('.line-clamp-2')).toBeNull()
  })

  it('cell は initialValue として question_text を表示する', () => {
    const el = renderCell('question', makeRow({ question_text: '2 + 2 = ?' }), META)
    expect(el.textContent).toContain('2 + 2 = ?')
  })

  it('screen.getByRole("button") で aria-label が取得できる', () => {
    renderCell('question', makeRow({ question_text: 'テスト' }), META)
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
    renderCell('question', makeRow({ question_text: 'テスト問題文' }), META)
    const displayDiv = screen.getByRole('button', { name: '問題文 編集' })
    expect(displayDiv.className.split(' ')).toContain('text-sm')
  })

  it('explanation_text cell の display div に text-sm クラスが付与される', () => {
    renderCell('explanation_text', makeRow({ explanation_text: '解説テキスト' }), META)
    const displayDiv = screen.getByRole('button', { name: '解説 編集' })
    expect(displayDiv.className.split(' ')).toContain('text-sm')
  })

  it('memo cell の display div に text-sm クラスが付与される', () => {
    renderCell('memo', makeRow({ memo: 'メモテキスト' }), META)
    const displayDiv = screen.getByRole('button', { name: 'メモ 編集' })
    expect(displayDiv.className.split(' ')).toContain('text-sm')
  })

  it('title cell の display div には text-sm が付与されない (対象外列の回帰)', () => {
    renderCell('title', makeRow({ title: 'タイトル' }), META)
    const displayDiv = screen.getByRole('button', { name: 'タイトル 編集' })
    expect(displayDiv.className.split(' ')).not.toContain('text-sm')
  })

  it('sort_key cell の display div には text-sm が付与されない (対象外列の回帰)', () => {
    renderCell('question_label', makeRow({ question_label: '0001' }), META)
    const displayDiv = screen.getByRole('button', { name: '番号 編集' })
    expect(displayDiv.className.split(' ')).not.toContain('text-sm')
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T2: question / explanation_text / memo の displayClassName に md:min-h-6 が追加され
// twMerge で md:min-h-8 を上書きする。inner box(display div)に効くことを assert。
// ---------------------------------------------------------------------------

describe('Edit-3 T2: question / explanation_text / memo の display div に md:min-h-6 が付く', () => {
  it('question display div に md:min-h-6 が付き md:min-h-8 がない (twMerge 上書き)', () => {
    renderCell('question', makeRow({ question_text: 'テスト' }), META)
    const displayDiv = screen.getByRole('button', { name: '問題文 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('explanation_text display div に md:min-h-6 が付き md:min-h-8 がない', () => {
    renderCell('explanation_text', makeRow({ explanation_text: '解説' }), META)
    const displayDiv = screen.getByRole('button', { name: '解説 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('memo display div に md:min-h-6 が付き md:min-h-8 がない', () => {
    renderCell('memo', makeRow({ memo: 'メモ' }), META)
    const displayDiv = screen.getByRole('button', { name: 'メモ 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes).toContain('md:min-h-6')
    expect(classes).not.toContain('md:min-h-8')
  })

  it('title display div には md:min-h-6 が付かない (対象外列の回帰)', () => {
    renderCell('title', makeRow({ title: 'タイトル' }), META)
    const displayDiv = screen.getByRole('button', { name: 'タイトル 編集' })
    const classes = displayDiv.className.split(' ')
    // row-ux UI fix A-1: title は CELL_EDIT_FLUSH_PADDING (p-0 md:py-0) を displayClassName
    // として受け取るが、min-h グループには触れないため md:min-h-8 (既定) が残る。
    expect(classes).not.toContain('md:min-h-6')
    expect(classes).toContain('md:min-h-8')
  })
})

// ---------------------------------------------------------------------------
// row-ux UI fix A-1: 編集セル (InlineTextField) の内側 display div padding を 0 にし、
// td 側 (px-1 py-1) へ余白を一本化する。SHARED_BOX_CHROME の p-2 / md:py-1 が displayClassName
// (CELL_EDIT_FLUSH_PADDING = 'p-0 md:py-0') で打ち消されていることを class 文字列レベルで pin する
// (jsdom は実レイアウトを計算できないため)。5 列 (title/question_label/question/
// explanation_text/memo) すべてで同じ実効 padding (0) になることを個別に検証する。
// ---------------------------------------------------------------------------

describe('row-ux UI fix A-1: 編集セルの内側 padding が 0 (td 側へ一本化)', () => {
  it('title display div に p-0 / md:py-0 が付き、p-2 / md:py-1 が残らない', () => {
    renderCell('title', makeRow({ title: 'タイトル' }), META)
    const displayDiv = screen.getByRole('button', { name: 'タイトル 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes, 'title: p-0 を持つ').toContain('p-0')
    expect(classes, 'title: md:py-0 を持つ').toContain('md:py-0')
    expect(classes, 'title: p-2 が残っていない').not.toContain('p-2')
    expect(classes, 'title: md:py-1 が残っていない').not.toContain('md:py-1')
  })

  it('question_label display div に p-0 / md:py-0 が付き、p-2 / md:py-1 が残らない', () => {
    renderCell('question_label', makeRow({ question_label: '0001' }), META)
    const displayDiv = screen.getByRole('button', { name: '番号 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes, 'question_label: p-0 を持つ').toContain('p-0')
    expect(classes, 'question_label: md:py-0 を持つ').toContain('md:py-0')
    expect(classes, 'question_label: p-2 が残っていない').not.toContain('p-2')
    expect(classes, 'question_label: md:py-1 が残っていない').not.toContain('md:py-1')
  })

  it('question display div に p-0 / md:py-0 が付き、p-2 / md:py-1 / md:py-0.5 が残らない', () => {
    renderCell('question', makeRow({ question_text: '問題文' }), META)
    const displayDiv = screen.getByRole('button', { name: '問題文 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes, 'question: p-0 を持つ').toContain('p-0')
    expect(classes, 'question: md:py-0 を持つ').toContain('md:py-0')
    expect(classes, 'question: p-2 が残っていない').not.toContain('p-2')
    expect(classes, 'question: md:py-1 が残っていない').not.toContain('md:py-1')
    expect(classes, 'question: md:py-0.5 が残っていない (旧値)').not.toContain('md:py-0.5')
  })

  it('explanation_text display div に p-0 / md:py-0 が付き、p-2 / md:py-1 / md:py-0.5 が残らない', () => {
    renderCell('explanation_text', makeRow({ explanation_text: '解説' }), META)
    const displayDiv = screen.getByRole('button', { name: '解説 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes, 'explanation_text: p-0 を持つ').toContain('p-0')
    expect(classes, 'explanation_text: md:py-0 を持つ').toContain('md:py-0')
    expect(classes, 'explanation_text: p-2 が残っていない').not.toContain('p-2')
    expect(classes, 'explanation_text: md:py-1 が残っていない').not.toContain('md:py-1')
    expect(classes, 'explanation_text: md:py-0.5 が残っていない (旧値)').not.toContain('md:py-0.5')
  })

  it('memo display div に p-0 / md:py-0 が付き、p-2 / md:py-1 / md:py-0.5 が残らない', () => {
    renderCell('memo', makeRow({ memo: 'メモ' }), META)
    const displayDiv = screen.getByRole('button', { name: 'メモ 編集' })
    const classes = displayDiv.className.split(' ')
    expect(classes, 'memo: p-0 を持つ').toContain('p-0')
    expect(classes, 'memo: md:py-0 を持つ').toContain('md:py-0')
    expect(classes, 'memo: p-2 が残っていない').not.toContain('p-2')
    expect(classes, 'memo: md:py-1 が残っていない').not.toContain('md:py-1')
    expect(classes, 'memo: md:py-0.5 が残っていない (旧値)').not.toContain('md:py-0.5')
  })

  it('edit mode (textarea) にも同じ padding 上書きが効く (display/edit の箱寸法一致は崩さない)', () => {
    renderCell('title', makeRow({ title: 'タイトル' }), META)
    fireEvent.click(screen.getByRole('button', { name: 'タイトル 編集' }))
    const input = screen.getByRole('textbox', { name: 'タイトル 編集' })
    const classes = input.className.split(' ')
    expect(classes, 'edit input: p-0 を持つ').toContain('p-0')
    expect(classes, 'edit input: md:py-0 を持つ').toContain('md:py-0')
    expect(classes, 'edit input: p-2 が残っていない').not.toContain('p-2')
    // 箱寸法 (min-h) は不変 — SHARED_BOX_CHROME の min-h-11 / md:min-h-8 が残る。
    expect(classes, 'edit input: min-h-11 は不変').toContain('min-h-11')
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
      META,
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
      META,
    )
    const deleteBtns = el.querySelectorAll('[aria-label="選択肢を削除"]')
    expect(deleteBtns.length).toBe(2)
  })

  it('screen.getByRole("button", { name: "\\+ 選択肢を追加" }) がアクセスできる', () => {
    renderCell('options', makeRow({ options: [] }), META)
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
    const questionLabelCol = examCardTableColumns.find((c) => c.id === 'question_label')
    expect(questionLabelCol).toBeDefined()
    // enableHiding=false が設定されると getCanHide()===false になり toggle UI から除外される。
    // 再表示できなくなるため設定しない。
    expect((questionLabelCol as unknown as Record<string, unknown>)?.['enableHiding']).not.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edit-3 T3: select 列と title 列の sticky meta 撤去 (Fix-3 T2 以降)
// ---------------------------------------------------------------------------

describe('Edit-3 T3: select 列と title 列の sticky meta 撤去 (Fix-3 T2 sticky 撤去済)', () => {
  it('select 列に meta.sticky と meta.stickyLeft が付与されていない (撤去ガード)', () => {
    const selectCol = examCardTableColumns.find((c) => c.id === 'select')
    expect(selectCol).toBeDefined()
    const meta = selectCol?.meta as { sticky?: boolean; stickyLeft?: number } | undefined
    expect(meta?.sticky).toBeUndefined()
    expect(meta?.stickyLeft).toBeUndefined()
  })

  it('title 列に meta.sticky と meta.stickyLeft が付与されていない (撤去ガード)', () => {
    const titleCol = examCardTableColumns.find((c) => c.id === 'title')
    expect(titleCol).toBeDefined()
    const meta = titleCol?.meta as { sticky?: boolean; stickyLeft?: number } | undefined
    expect(meta?.sticky).toBeUndefined()
    expect(meta?.stickyLeft).toBeUndefined()
  })

  it('非 sticky 列(question)に meta.sticky が付与されていない', () => {
    const questionCol = examCardTableColumns.find((c) => c.id === 'question')
    expect(questionCol).toBeDefined()
    const meta = questionCol?.meta as { sticky?: boolean; stickyLeft?: number } | undefined
    expect(meta?.sticky).not.toBe(true)
    expect(meta?.stickyLeft).toBeUndefined()
  })
})

// ===========================================================================
// S4-1: テキストフィルタ (makeTextFilterFn + 5 列 filterFn)
// ===========================================================================

// ---------------------------------------------------------------------------
// harness helpers
// ---------------------------------------------------------------------------

/** useReactTable を renderHook で呼び出し、指定 columnFilters で filtered row ids を返す。 */
function getFilteredIds(data: ExamCardRow[], columnFilters: ColumnFiltersState): string[] {
  const { result } = renderHook(() =>
    useReactTable<ExamCardRow>({
      data,
      columns: examCardTableColumns,
      getCoreRowModel: getCoreRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      state: { columnFilters },
      onColumnFiltersChange: () => {},
    }),
  )
  return result.current.getFilteredRowModel().rows.map((r) => r.original.card.id)
}

/** sort + filter 併用で filtered+sorted row ids を返す。 */
function getFilteredSortedIds(
  data: ExamCardRow[],
  columnFilters: ColumnFiltersState,
  sorting: SortingState,
): string[] {
  const { result } = renderHook(() =>
    useReactTable<ExamCardRow>({
      data,
      columns: examCardTableColumns,
      getCoreRowModel: getCoreRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      getSortedRowModel: getSortedRowModel(),
      state: { columnFilters, sorting },
      onColumnFiltersChange: () => {},
      onSortingChange: () => {},
    }),
  )
  // getSortedRowModel は getFilteredRowModel の後に適用される
  return result.current.getSortedRowModel().rows.map((r) => r.original.card.id)
}

// ---------------------------------------------------------------------------
// case S4-1 (c): 5 列それぞれ contains フィルタで絞れる
// ---------------------------------------------------------------------------

describe('S4-1: title 列 — contains フィルタ', () => {
  const data = [
    makeRow({ id: 'card-foo', title: 'Foo Title' }),
    makeRow({ id: 'card-bar', title: 'Bar Title' }),
    makeRow({ id: 'card-baz', title: 'BAZ TITLE' }),
  ]

  it('{op:contains, value:"foo"} で Foo Title のみ pass', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'foo' }
    const ids = getFilteredIds(data, [{ id: 'title', value: filter }])
    expect(ids).toContain('card-foo')
    expect(ids).not.toContain('card-bar')
    expect(ids).not.toContain('card-baz')
  })

  it('{op:contains, value:"TITLE"} で全件 pass (大文字小文字非区別)', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'TITLE' }
    const ids = getFilteredIds(data, [{ id: 'title', value: filter }])
    expect(ids).toHaveLength(3)
  })
})

describe('S4-1: sort_key 列 — contains フィルタ', () => {
  const data = [
    makeRow({ id: 'card-abc', question_label: 'ABC-001' }),
    makeRow({ id: 'card-xyz', question_label: 'XYZ-002' }),
    makeRow({ id: 'card-null', question_label: null }),
  ]

  it('{op:contains, value:"abc"} で ABC-001 のみ pass (大文字小文字非区別)', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'abc' }
    const ids = getFilteredIds(data, [{ id: 'question_label', value: filter }])
    expect(ids).toContain('card-abc')
    expect(ids).not.toContain('card-xyz')
    expect(ids).not.toContain('card-null')
  })
})

describe('S4-1: question 列 — contains フィルタ', () => {
  const data = [
    makeRow({ id: 'card-q1', question_text: 'What is React?' }),
    makeRow({ id: 'card-q2', question_text: 'Explain TypeScript.' }),
  ]

  it('{op:contains, value:"react"} で What is React? のみ pass', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'react' }
    const ids = getFilteredIds(data, [{ id: 'question', value: filter }])
    expect(ids).toContain('card-q1')
    expect(ids).not.toContain('card-q2')
  })
})

describe('S4-1: explanation_text 列 — contains フィルタ', () => {
  const data = [
    makeRow({ id: 'card-e1', explanation_text: 'Because of hooks.' }),
    makeRow({ id: 'card-e2', explanation_text: 'Due to types.' }),
    makeRow({ id: 'card-null', explanation_text: null }),
  ]

  it('{op:contains, value:"hooks"} で Because of hooks. のみ pass', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'hooks' }
    const ids = getFilteredIds(data, [{ id: 'explanation_text', value: filter }])
    expect(ids).toContain('card-e1')
    expect(ids).not.toContain('card-e2')
    expect(ids).not.toContain('card-null')
  })
})

describe('S4-1: memo 列 — contains フィルタ', () => {
  const data = [
    makeRow({ id: 'card-m1', memo: 'Important note here.' }),
    makeRow({ id: 'card-m2', memo: 'Other memo.' }),
    makeRow({ id: 'card-null', memo: null }),
  ]

  it('{op:contains, value:"note"} で Important note here. のみ pass', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'note' }
    const ids = getFilteredIds(data, [{ id: 'memo', value: filter }])
    expect(ids).toContain('card-m1')
    expect(ids).not.toContain('card-m2')
    expect(ids).not.toContain('card-null')
  })
})

// ---------------------------------------------------------------------------
// case S4-1 (c): nullable 3 列で {op:'empty'} が null セル行を返す
// ---------------------------------------------------------------------------

describe('S4-1: nullable 3 列 (sort_key / explanation_text / memo) — empty op', () => {
  it('question_label: {op:empty} で null セル行のみ pass', () => {
    const data = [
      makeRow({ id: 'card-val', question_label: '0001' }),
      makeRow({ id: 'card-null', question_label: null }),
    ]
    const filter: TextFilterValue = { op: 'empty', value: '' }
    const ids = getFilteredIds(data, [{ id: 'question_label', value: filter }])
    expect(ids).toContain('card-null')
    expect(ids).not.toContain('card-val')
  })

  it('explanation_text: {op:empty} で null セル行のみ pass', () => {
    const data = [
      makeRow({ id: 'card-val', explanation_text: 'Some text' }),
      makeRow({ id: 'card-null', explanation_text: null }),
    ]
    const filter: TextFilterValue = { op: 'empty', value: '' }
    const ids = getFilteredIds(data, [{ id: 'explanation_text', value: filter }])
    expect(ids).toContain('card-null')
    expect(ids).not.toContain('card-val')
  })

  it('memo: {op:empty} で null セル行のみ pass', () => {
    const data = [
      makeRow({ id: 'card-val', memo: 'Some memo' }),
      makeRow({ id: 'card-null', memo: null }),
    ]
    const filter: TextFilterValue = { op: 'empty', value: '' }
    const ids = getFilteredIds(data, [{ id: 'memo', value: filter }])
    expect(ids).toContain('card-null')
    expect(ids).not.toContain('card-val')
  })
})

// ---------------------------------------------------------------------------
// case S4-1 (d): enableSorting 値が S3 時点と不変
// ---------------------------------------------------------------------------

describe('S4-1 (d): enableSorting 値が S3 時点と不変 (filterFn 追加後も変わらない)', () => {
  const sortableIds = ['title', 'question_label']
  const nonSortableIds = ['question', 'explanation_text', 'memo']

  for (const colId of sortableIds) {
    it(`${colId} 列: enableSorting === true`, () => {
      const col = examCardTableColumns.find((c) => c.id === colId)
      expect(col?.enableSorting).toBe(true)
    })
  }

  for (const colId of nonSortableIds) {
    it(`${colId} 列: enableSorting === false`, () => {
      const col = examCardTableColumns.find((c) => c.id === colId)
      expect(col?.enableSorting).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// case S4-1 (c): sort × filter 独立 — 1 case 固定
// ---------------------------------------------------------------------------

describe('S4-1: sort × filter 独立 (title sort + title filter を同時適用)', () => {
  // 3 行: Apple (sort_key=0003), Banana (sort_key=0001), Cherry (sort_key=0002)
  // filter: title contains 'a' → Apple ('a') / Banana ('a') pass、Cherry fail
  // sort: sort_key asc → pre-sort 順 Banana(0001), Cherry(0002), Apple(0003) → filter 後 Banana,Apple
  const data = [
    makeRow({ id: 'card-apple', title: 'Apple', question_label: '0003', created_at: '2024-01-01T00:00:00.000Z' }),
    makeRow({ id: 'card-banana', title: 'Banana', question_label: '0001', created_at: '2024-01-02T00:00:00.000Z' }),
    makeRow({ id: 'card-cherry', title: 'Cherry', question_label: '0002', created_at: '2024-01-03T00:00:00.000Z' }),
  ]

  it('title contains "a" でフィルタ → Apple と Banana が残り Cherry が除外される', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'a' }
    const ids = getFilteredSortedIds(
      data,
      [{ id: 'title', value: filter }],
      [],
    )
    expect(ids).toContain('card-apple')
    expect(ids).toContain('card-banana')
    expect(ids).not.toContain('card-cherry')
  })

  it('title filter + sort_key asc ソートを同時適用 → filter と sort が独立に機能', () => {
    const filter: TextFilterValue = { op: 'contains', value: 'a' }
    const ids = getFilteredSortedIds(
      data,
      [{ id: 'title', value: filter }],
      [{ id: 'question_label', desc: false }],
    )
    // Apple(0003) と Banana(0001) が残り、sort_key asc で Banana→Apple の順
    expect(ids).toEqual(['card-banana', 'card-apple'])
  })
})

// ===========================================================================
// title cell — 行操作 UI は select 列に集約済(側 peek 起動は grip menu の「開く」)。
// title 列は button 除去後の構造不変のみ検証する(構造検証は既存 renderCell ヘルパーで足りる —
// title cell は row.original のみ参照し TanStack row メソッドを呼ばないため)。
// ===========================================================================

describe('Column: title — 行操作 UI 移設後の構造不変', () => {
  it('① title cell は編集 button 以外を描画しない(行操作 UI は select 列に集約)', () => {
    renderCell('title', makeRow(), { ...META, openCard: vi.fn() })
    // InlineTextField の display button のみ = 行操作 UI(旧「カードを開く」/ グリップ)が
    // 混ざっていないことを件数で pin する。
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName('タイトル 編集')
  })

  it('② タイトル display div クリックで textbox が現れる (title cell の編集動線は不変)', () => {
    renderCell('title', makeRow(), { ...META, openCard: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'タイトル 編集' }))
    expect(screen.getByRole('textbox', { name: 'タイトル 編集' })).toBeInTheDocument()
  })

  it('③ title 列の accessorFn / size / sortingFn / filterFn が不変', () => {
    const titleCol = examCardTableColumns.find((c) => c.id === 'title')
    expect(titleCol).toBeDefined()
    expect(titleCol?.size).toBe(80)
    expect(titleCol?.enableSorting).toBe(true)
    expect(typeof (titleCol as Record<string, unknown> | undefined)?.['accessorFn']).toBe('function')
    expect(typeof titleCol?.sortingFn).toBe('function')
    expect(typeof titleCol?.filterFn).toBe('function')
  })

  it('④ title 列 hidden (columnVisibility=false) で crash しない', () => {
    expect(() => {
      renderHook(() =>
        useReactTable<ExamCardRow>({
          data: [makeRow()],
          columns: examCardTableColumns,
          getCoreRowModel: getCoreRowModel(),
          state: { columnVisibility: { title: false } },
          onColumnVisibilityChange: () => {},
        }),
      )
    }).not.toThrow()
  })
})

// ===========================================================================
// select cell: 二役グリップ + checkbox の 2 要素(row-ux §2 / §6)
//
// 「カードを開く」常設 button と ⋯ 行メニューはグリップの menu に統合済。
// 表示は常時表示の低コントラスト — hover で「出現」させる書き方(基底 opacity-0)は
// hover 不能端末(iPad 横向き等)で永久不可視になるため使わない(spec §12 の NO-GO 記録)。
// ===========================================================================

const ROW_MENU_META: Partial<ExamCardTableMeta> = {
  userId: 'user-owner',
  rowMenu: {
    currentExamId: 'e-test',
    positionLocked: false,
    pending: false,
    onPullInto: vi.fn(async () => null),
  },
}

/**
 * select cell を fake table context (meta 注入可) で render するヘルパー。
 * select cell(checkbox 部分)は row.getIsSelected() / row.getToggleSelectedHandler() という
 * 実 TanStack Row メソッドを呼ぶため、汎用 renderCell (row.original のみのフェイク row) では
 * stub 不足で crash する。 本 helper は selection 用の最小 stub を追加する
 * (isSelected は常に false 固定 — 本テストで検証したいのは cell の構成と menu 動線であり
 * selection state 自体ではない。selection state 自体は exam-card-table.test.tsx の統合テストが担保)。
 */
function renderSelectCellWithMeta(
  row: ExamCardRow,
  meta?: Partial<ExamCardTableMeta>,
): HTMLElement {
  const col = examCardTableColumns.find((c) => c.id === 'select')
  if (!col) throw new Error('Column "select" not found')
  if (!col.cell) throw new Error('Column "select" has no cell renderer')

  const cellFn = col.cell as unknown as (ctx: {
    row: {
      original: ExamCardRow
      getIsSelected: () => boolean
      getToggleSelectedHandler: () => () => void
    }
    table: { options: { meta: unknown } }
  }) => React.ReactNode

  const fakeRow = {
    original: row,
    getIsSelected: () => false,
    getToggleSelectedHandler: () => () => {},
  }

  function Wrapper() {
    return (
      <div data-testid="cell-wrapper">
        {cellFn({ row: fakeRow, table: { options: { meta } } })}
      </div>
    )
  }

  const { container } = render(<Wrapper />)
  return container.querySelector('[data-testid="cell-wrapper"]') as HTMLElement
}

describe('Column: select — 二役グリップ + checkbox の 2 要素', () => {
  const gripName = `行の操作: ${makeClientCard().title}`

  it('① select cell はグリップと checkbox だけを持つ(この DOM 順)', () => {
    const el = renderSelectCellWithMeta(makeRow(), { ...ROW_MENU_META, openCard: vi.fn() })
    expect(screen.getByRole('button', { name: gripName })).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeInTheDocument()

    const layout = el.querySelector('div') as HTMLElement
    expect(Array.from(layout.children).map((c) => c.tagName)).toEqual(['BUTTON', 'INPUT'])
  })

  it('② layout wrapper が flex + gap レイアウトを持つ', () => {
    const el = renderSelectCellWithMeta(makeRow(), { ...ROW_MENU_META, openCard: vi.fn() })
    const layout = el.querySelector('div') as HTMLElement
    expect(layout.className).toContain('flex')
    expect(layout.className).toMatch(/gap-\d/)
  })

  it('③ グリップ click で menu が開き「開く」「ここに取り込む」が出る', async () => {
    renderSelectCellWithMeta(makeRow(), { ...ROW_MENU_META, openCard: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: gripName }))

    const menu = await screen.findByTestId('exam-card-row-menu')
    expect(
      within(menu)
        .getAllByRole('button')
        .map((el) => el.textContent),
    ).toEqual(['開く', 'ここに取り込む'])
  })

  it('④ menu の「開く」click で meta.openCard(card.id) が呼ばれる', async () => {
    const openCard = vi.fn()
    const row = makeRow({ id: 'card-peek-test' })
    renderSelectCellWithMeta(row, { ...ROW_MENU_META, openCard })

    fireEvent.click(screen.getByRole('button', { name: `行の操作: ${row.card.title}` }))
    fireEvent.click(await screen.findByRole('button', { name: '開く' }))

    expect(openCard).toHaveBeenCalledTimes(1)
    expect(openCard).toHaveBeenCalledWith('card-peek-test')
  })

  it('⑤ meta 不在でグリップが描画されず crash しない(checkbox のみ描画)', () => {
    renderSelectCellWithMeta(makeRow())
    expect(screen.queryByRole('button', { name: /行の操作:/ })).toBeNull()
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('⑤-b meta 有だが rowMenu 未配線のときグリップが描画されない', () => {
    renderSelectCellWithMeta(makeRow(), { userId: 'user-owner', openCard: vi.fn() })
    expect(screen.queryByRole('button', { name: /行の操作:/ })).toBeNull()
  })

  it('⑥ openCard 未配線のとき menu に「開く」項目が出ない(「ここに取り込む」は出る)', async () => {
    renderSelectCellWithMeta(makeRow(), ROW_MENU_META)
    fireEvent.click(screen.getByRole('button', { name: gripName }))

    const menu = await screen.findByTestId('exam-card-row-menu')
    expect(
      within(menu)
        .getAllByRole('button')
        .map((el) => el.textContent),
    ).toEqual(['ここに取り込む'])
  })

  it('⑦ グリップ / checkbox に「出現」型の非表示 class が付かない(常時表示・分岐なし)', () => {
    // 禁止: 基底 opacity-0 / md: 幅ブレークポイントを hover 能力の代理にする分岐。
    // 常時表示を「非表示 class の不在」として operationalize する(spec §12 NO-GO の pin)。
    renderSelectCellWithMeta(makeRow(), { ...ROW_MENU_META, openCard: vi.fn() })
    for (const el of [
      screen.getByRole('button', { name: gripName }),
      screen.getByRole('checkbox'),
    ]) {
      expect(el.className).not.toContain('opacity-0 ')
      expect(el.className).not.toMatch(/opacity-0$/)
      expect(el.className).not.toContain('hidden')
      expect(el.className).not.toContain('group-has')
      expect(el.className).not.toContain('md:')
    }
  })

  it('⑧ 低コントラスト基底 + 選択済みは常時通常表示(checkbox の class 契約)', () => {
    renderSelectCellWithMeta(makeRow(), { ...ROW_MENU_META, openCard: vi.fn() })
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.className).toContain('opacity-50')
    expect(checkbox.className).toContain('group-hover:opacity-100')
    expect(checkbox.className).toContain('focus-visible:opacity-100')
    expect(checkbox.className).toContain('checked:opacity-100')

    // ⑧-b(最終 review F3): グリップ側は checkbox と非対称に未 pin だった
    // (exam-card-row-menu.tsx の class 文字列全体を `text-foreground` に置換しても
    // green のまま)。 濃度の数値そのもの(現状 `/50`)は spec §6 が 40-60 の調整域を
    // 許すため厳密固定せず、「基底が muted 系であること」+「group-hover で(opacity 接尾辞
    // のない = 通常濃度の)muted-foreground に強調されること」の 2 点で pin する。
    const grip = screen.getByRole('button', { name: gripName })
    const gripClasses = grip.className.split(/\s+/)
    expect(gripClasses.some((c) => /^text-muted-foreground\/(4\d|5\d|60)$/.test(c))).toBe(
      true,
    )
    expect(gripClasses).toContain('group-hover:text-muted-foreground')
  })
})

// ---------------------------------------------------------------------------
// row-ux UI fix A-3: select 列 header (全選択 checkbox) を行側 checkbox と同じ x 位置に揃える。
// 行側は [グリップ(size-6) → gap-1 → checkbox] の順で並ぶため、header 側も
// [spacer(size-6) → gap-1 → checkbox] にして x を一致させる。spacer は非 focusable + aria-hidden。
// ---------------------------------------------------------------------------

/** select 列の header renderer を fake table context で render するヘルパー。 */
function renderSelectHeader(): HTMLElement {
  const col = examCardTableColumns.find((c) => c.id === 'select')
  if (!col) throw new Error('Column "select" not found')
  if (!col.header) throw new Error('Column "select" has no header renderer')

  const headerFn = col.header as unknown as (ctx: {
    table: {
      getIsAllRowsSelected: () => boolean
      getIsSomeRowsSelected: () => boolean
      getToggleAllRowsSelectedHandler: () => () => void
    }
  }) => React.ReactNode

  const fakeTable = {
    getIsAllRowsSelected: () => false,
    getIsSomeRowsSelected: () => false,
    getToggleAllRowsSelectedHandler: () => () => {},
  }

  function Wrapper() {
    return <div data-testid="header-wrapper">{headerFn({ table: fakeTable })}</div>
  }

  const { container } = render(<Wrapper />)
  return container.querySelector('[data-testid="header-wrapper"]') as HTMLElement
}

describe('row-ux UI fix A-3: select header の checkbox が行側 checkbox と同じ x 位置に揃う', () => {
  it('spacer(SPAN) → checkbox(INPUT) の順で並ぶ(行側の grip → checkbox と同型)', () => {
    const wrapper = renderSelectHeader()
    const checkbox = screen.getByRole('checkbox', { name: '全選択' })
    const layout = wrapper.querySelector('div') as HTMLElement
    expect(Array.from(layout.children).map((c) => c.tagName)).toEqual(['SPAN', 'INPUT'])
    expect(layout.children[1]).toBe(checkbox)
    expect(layout.className, 'layout wrapper は flex + gap').toContain('flex')
    expect(layout.className).toMatch(/gap-\d/)
  })

  it('spacer は aria-hidden="true" かつ tabindex を持たない (SR に読ませず tab 順を増やさない)', () => {
    const wrapper = renderSelectHeader()
    const layout = wrapper.querySelector('div') as HTMLElement
    const spacer = layout.children[0] as HTMLElement
    expect(spacer.tagName, 'spacer は button/input/a のような focusable 要素ではない').toBe('SPAN')
    expect(spacer.getAttribute('aria-hidden')).toBe('true')
    expect(spacer.hasAttribute('tabindex'), 'tabindex 未指定 = 既定で非 focusable').toBe(false)
  })

  it('spacer の幅クラス (size-6) が行側グリップ (size-6) と一致する', () => {
    const wrapper = renderSelectHeader()
    const layout = wrapper.querySelector('div') as HTMLElement
    const spacer = layout.children[0] as HTMLElement
    expect(spacer.className.split(' '), 'spacer は size-6 を持つ (グリップと同幅で x が揃う)').toContain(
      'size-6',
    )
  })
})

// ---------------------------------------------------------------------------
// row-ux UI fix A-2 review F2: select 列 52px の算術 (grip24 + gap4 + checkbox16 + td-px8) の
// 「checkbox16」がブラウザ既定依存の推定値のままだったため、既存前例
// (exam-card-table-options-edit-cell.tsx の h-4 w-4)に倣い実寸を明示して保証にする。
// ---------------------------------------------------------------------------

describe('row-ux UI fix A-2 review F2: checkbox 実寸固定 (h-4 w-4)', () => {
  it('header の全選択 checkbox が h-4 / w-4 を持つ', () => {
    renderSelectHeader()
    const checkbox = screen.getByRole('checkbox', { name: '全選択' })
    const classes = checkbox.className.split(' ')
    expect(classes, 'header checkbox: h-4 を持つ').toContain('h-4')
    expect(classes, 'header checkbox: w-4 を持つ').toContain('w-4')
  })

  it('行の checkbox が h-4 / w-4 を持つ', () => {
    renderSelectCellWithMeta(makeRow(), { ...ROW_MENU_META, openCard: vi.fn() })
    const checkbox = screen.getByRole('checkbox')
    const classes = checkbox.className.split(' ')
    expect(classes, '行 checkbox: h-4 を持つ').toContain('h-4')
    expect(classes, '行 checkbox: w-4 を持つ').toContain('w-4')
  })
})

// Sprint T T6 + add(2026-07-17 OT): テーブルビュー 画像 gallery 配線(question /
// explanation_text / memo 列)= thumbnail + compact add affordance。userId は meta 経由。
describe('Sprint T T6: テーブルビュー 画像 gallery 配線(thumbnail + add)', () => {
  // META は module scope (renderCell helper の直後) で共有定義済み。
  const img = (target: string): ClientCardImage => ({
    key: '11111111-1111-4111-8111-111111111111',
    target,
    alt: `${target}の画像`,
  })

  it('① 問題文/解説/メモ列: 画像ありでサムネ(img)が描画される', async () => {
    renderCell('question', makeRow({ images: [img('question_text')] }), META)
    expect(await screen.findByAltText('question_textの画像')).toBeInTheDocument()
    cleanup()
    renderCell('explanation_text', makeRow({ images: [img('explanation_text')] }), META)
    expect(await screen.findByAltText('explanation_textの画像')).toBeInTheDocument()
    cleanup()
    renderCell('memo', makeRow({ images: [img('memo')] }), META)
    expect(await screen.findByAltText('memoの画像')).toBeInTheDocument()
  })

  it('② 画像なし → サムネ(img)は出ないが add affordance は出る', () => {
    const el = renderCell('question', makeRow({ question_text: 'x', images: [] }), META)
    expect(el.querySelector('img')).toBeNull()
    // add affordance(compact icon・aria-label=attachAriaLabel)は空欄でも出る。
    expect(screen.getByRole('button', { name: '問題文に画像を追加' })).toBeInTheDocument()
  })

  it('③ 3 列すべてに add affordance が出る(card view と同扱い)', () => {
    renderCell('question', makeRow({ images: [] }), META)
    expect(screen.getByRole('button', { name: '問題文に画像を追加' })).toBeInTheDocument()
    cleanup()
    renderCell('explanation_text', makeRow({ images: [] }), META)
    expect(screen.getByRole('button', { name: '解説に画像を追加' })).toBeInTheDocument()
    cleanup()
    renderCell('memo', makeRow({ images: [] }), META)
    expect(screen.getByRole('button', { name: 'メモに画像を追加' })).toBeInTheDocument()
  })

  it('④ add 押下(file 選択)→ 既存 attachImageToCard 経路が呼ばれる(独自経路なし)', async () => {
    const el = renderCell('question', makeRow({ id: '99999999-9999-4999-8999-999999999999', images: [] }), META)
    const input = el.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() =>
      expect(mockAttachImageToCard).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'question_text',
          cardId: '99999999-9999-4999-8999-999999999999',
          userId: 'user-owner',
        }),
        expect.anything(),
      ),
    )
  })

  it('⑤ サムネは編集可能(readOnly でない → 削除 affordance あり = 既存 remove 経路)', async () => {
    renderCell('question', makeRow({ images: [img('question_text')] }), META)
    expect(
      await screen.findByRole('button', { name: '画像を削除' }),
    ).toBeInTheDocument()
  })

  it('⑥ meta 不在(userId なし)→ gallery 描画されず crash しない(add も出ない)', () => {
    const el = renderCell('question', makeRow({ images: [img('question_text')] }))
    expect(el.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: '問題文に画像を追加' })).toBeNull()
  })
})
