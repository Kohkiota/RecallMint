// @vitest-environment jsdom
// ExamCardTable de-risk smoke (Grid-1 T5)。
// 3 smoke 条件:
//   smoke ①: rowSelection toggle — checkbox click で checked / unchecked が追従する
//   smoke ②: data 差し替え再描画 — Dexie に row 追加で <tr> 数が追従する
//   smoke ③: tag cell props 経路再描画 — card_tags 追加で data-tag-count が追従する
//
// 環境: vitest + jsdom + @testing-library/react + fake-indexeddb (vitest.setup.ts global)。
// useLiveQuery は Dexie への put/add でリアクティブに再評価される (fake-indexeddb 使用)。
//
// Fix-1 T2 追記: bulk createOptionAndAssign 配線 (action-bar 限定、 TagCell 不変)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { getClientDb, type ClientCard, type ClientTagCategory, type ClientTagOption } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// Fix-1 T2: createOption mock (hoisted so vi.mock can reference it)
// ---------------------------------------------------------------------------

const { mockCreateOption, mockBulkTag } = vi.hoisted(() => ({
  mockCreateOption: vi.fn(async () => 'new-opt-fixed'),
  mockBulkTag: vi.fn(async () => ({ ok: true, succeeded: [] as string[], failed: [] as string[] })),
}))

// Mock createOption from card-tags-section; keep all other exports real.
vi.mock('./card-tags-section', async (importActual) => {
  const actual = await importActual<typeof import('./card-tags-section')>()
  return { ...actual, createOption: mockCreateOption }
})

// Mock useBulkCardTags to return a stable spy that we can assert on.
// Existing smoke tests don't trigger bulk ops, so they are unaffected.
vi.mock('../_hooks/use-bulk-card-tags', async (importActual) => {
  const actual = await importActual<typeof import('../_hooks/use-bulk-card-tags')>()
  return {
    ...actual,
    useBulkCardTags: () => mockBulkTag,
  }
})

import { ControlledExamCardTable } from './exam-card-table-test-harness'
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
  await db.sync_meta.clear()
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

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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

    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // 1 row が描画されるのを待つ (table が完全 mount された状態)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })

    // th が style width を持つことを確認。
    // Fix-3 T1 適用後: CSS 変数参照形式 calc(var(--header-{id}-size) * 1px) に変わった。
    const allTh = container.querySelectorAll('th')
    expect(allTh.length).toBeGreaterThan(0)
    for (const th of allTh) {
      const widthStyle = (th as HTMLElement).style.width
      // Fix-3 T1: CSS 変数参照形式で設定されている
      expect(widthStyle, `th "${th.textContent?.trim()}" に style.width が必要`).toMatch(/calc\(var\(--header-[^)]+\) \* 1px\)/)
    }

    // resize handle が少なくとも 1 つ存在することを確認 (question 列など resizable 列に付与)。
    // cursor-col-resize クラスで handle を特定する。
    const handles = container.querySelectorAll('.cursor-col-resize')
    expect(handles.length, 'resize handle が 1 つ以上存在する').toBeGreaterThan(0)
  })
})

// ===========================================================================
// Fix-1 T2: bulk createOptionAndAssign 配線検証
// ===========================================================================

const FIX1_CATEGORY: ClientTagCategory = {
  id: 'cat-fix1',
  user_id: USER_ID,
  name: 'Difficulty',
  select_type: 'multi',
  color: null,
  sort_key: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

describe('Fix-1 T2: bulk createOptionAndAssign 配線 (action-bar 経由)', () => {
  it('action-bar 付与 popover で option 新規作成すると createOption → bulkTag(new id, add) が呼ばれる', async () => {
    mockCreateOption.mockClear()
    mockBulkTag.mockClear()

    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    await db.tag_categories.put(FIX1_CATEGORY)

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 2 行選択して action bar を表示
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 2/ }))
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // action bar 内の「タグ付与」popover を開く
    const bar = screen.getByTestId('exam-card-table-action-bar')
    fireEvent.click(within(bar).getByText('タグ付与'))

    // stage1: カテゴリ選択 → Difficulty を選択
    const catInput = await screen.findByLabelText('category を検索 / 新規作成')
    fireEvent.change(catInput, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))

    // stage2: option 新規作成 → input に名前を入力して「新規作成: NewOpt」を click
    const optInput = await screen.findByLabelText('option を検索 / 新規作成')
    fireEvent.change(optInput, { target: { value: 'NewOpt' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '新規作成: NewOpt' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: NewOpt' }))

    // createOption が categoryId='cat-fix1', name='NewOpt' で呼ばれた
    await waitFor(() => {
      expect(mockCreateOption).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Array),
        'cat-fix1',
        'NewOpt',
      )
    })

    // bulkTag が newId='new-opt-fixed', op='add' で呼ばれた
    await waitFor(() => {
      expect(mockBulkTag).toHaveBeenCalledWith(
        expect.any(Array),
        'cat-fix1',
        'new-opt-fixed',
        'add',
      )
    })
  })
})

// ===========================================================================
// smoke ⑥ (Edit-2 T3): question 列が InlineTextField で描画される
// ===========================================================================

describe('ExamCardTable smoke ⑥ (Edit-2 T3): question column renders InlineTextField', () => {
  it('1 row seed → question cell に aria-label="問題文 編集" の InlineTextField が描画される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // row が描画されるのを待つ
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    // InlineTextField は display mode で role="button" + aria-label を持つ div を描画する
    const questionField = screen.getByRole('button', { name: '問題文 編集' })
    expect(questionField).toBeInTheDocument()
  })
})

// ===========================================================================
// Edit-3 T1: th/td padding density (py-2 → py-1)
// ===========================================================================

describe('Edit-3 T1: th/td padding density', () => {
  it('th が py-1 クラスを持ち py-2 を持たない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })
    const allTh = container.querySelectorAll('th')
    expect(allTh.length).toBeGreaterThan(0)
    for (const th of allTh) {
      expect(
        th.className,
        `th "${th.textContent?.trim()}" は py-1 を持つ`,
      ).toContain('py-1')
      expect(
        th.className,
        `th "${th.textContent?.trim()}" は py-2 を持たない`,
      ).not.toContain('py-2')
    }
  })

  it('td が py-1 クラスを持ち py-2 を持たない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })
    const allTd = container.querySelectorAll('td')
    expect(allTd.length).toBeGreaterThan(0)
    for (const td of allTd) {
      expect(td.className, 'td は py-1 を持つ').toContain('py-1')
      expect(td.className, 'td は py-2 を持たない').not.toContain('py-2')
    }
  })

  it('th が px-1 クラスを持ち px-3 を持たない (Edit-3 Fix-2: 左右 padding 詰め)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })
    const allTh = container.querySelectorAll('th')
    expect(allTh.length).toBeGreaterThan(0)
    for (const th of allTh) {
      expect(
        th.className,
        `th "${th.textContent?.trim()}" は px-1 を持つ`,
      ).toContain('px-1')
      expect(
        th.className,
        `th "${th.textContent?.trim()}" は px-3 を持たない`,
      ).not.toContain('px-3')
    }
  })

  it('td が px-1 クラスを持ち px-3 を持たない (Edit-3 Fix-2: 左右 padding 詰め)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })
    const allTd = container.querySelectorAll('td')
    expect(allTd.length).toBeGreaterThan(0)
    for (const td of allTd) {
      expect(td.className, 'td は px-1 を持つ').toContain('px-1')
      expect(td.className, 'td は px-3 を持たない').not.toContain('px-3')
    }
  })
})

// ===========================================================================
// Fix-3 T2: sticky 2列撤去 — select / title に sticky class / left が付与されないこと
// (OT 方針: Notion 準拠で左端固定しない)。旧 smoke ⑦ (Edit-3 T3 sticky) を撤去し、
// 撤去の非回帰 guard に置き換える。列順: select(0) / title(1) / sort_key(hidden) / question ...
// ===========================================================================

describe('Fix-3 T2: sticky 2列撤去 — sticky class / left が付与されない', () => {
  it('th: select / title に sticky class も left も付与されず、 width CSS 変数のみ維持される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    // 全 th に sticky class / left が残っていないこと
    for (const th of allTh) {
      const el = th as HTMLElement
      expect(el.className, `th "${el.textContent?.trim()}" は sticky class を持たない`).not.toContain('sticky')
      expect(el.style.left, `th "${el.textContent?.trim()}" は left を持たない`).toBe('')
    }

    // select / title の width CSS 変数は維持
    const selectTh = allTh[0] as HTMLElement
    const titleTh = allTh[1] as HTMLElement
    expect(selectTh.style.width).toMatch(/calc\(var\(--header-/)
    expect(titleTh.style.width).toMatch(/calc\(var\(--header-/)
  })

  it('td: select / title に sticky class も left も付与されず、 width CSS 変数のみ維持される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const row = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    const cells = row.querySelectorAll('td')
    // 全 td に sticky class / left が残っていないこと
    for (const td of cells) {
      const el = td as HTMLElement
      expect(el.className, 'td は sticky class を持たない').not.toContain('sticky')
      expect(el.style.left, 'td は left を持たない').toBe('')
    }

    // select / title の width CSS 変数は維持
    const selectTd = cells[0] as HTMLElement
    const titleTd = cells[1] as HTMLElement
    expect(selectTd.style.width).toMatch(/calc\(var\(--col-/)
    expect(titleTd.style.width).toMatch(/calc\(var\(--col-/)
  })
})

// ===========================================================================
// S2-5: ExamCardTable controlled columnVisibility contract
// state 所有 + 永続 (sync_meta) は exam-detail-view へ集約済 (exam-detail-view.test で検証)。
// ここは ExamCardTable が受け取った columnVisibility prop に従って列を隠す/表示する
// controlled 契約のみを固定する。
//
// harness は初期 { sort_key: false } を与えるため、 sort_key は既定 hidden。
// initialColumnVisibility={} (= saved hiddenColumns:[] 相当) を渡すと sort_key が表示される
// = 旧 mount-load round-trip の振る舞い等価 (所有者だけが detail-view に移動)。
// ===========================================================================

describe('S2-5: ExamCardTable controlled columnVisibility 契約', () => {
  it('columnVisibility={sort_key:false} (harness 既定) → sort_key ヘッダが hidden', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const headerTexts = Array.from(container.querySelectorAll('th')).map((th) =>
      (th as HTMLElement).textContent?.trim(),
    )
    expect(headerTexts, '既定 { sort_key: false } → sort_key hidden').not.toContain('ソートキー')
  })

  it('columnVisibility={} (saved hiddenColumns:[] 相当) → sort_key ヘッダが表示される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    const { container } = render(
      <ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} initialColumnVisibility={{}} />,
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const headerTexts = Array.from(container.querySelectorAll('th')).map((th) =>
      (th as HTMLElement).textContent?.trim(),
    )
    // sort_key は S3-1 で enableSorting:true になりヘッダに glyph が付く ('ソートキー▾' 等)。
    // 部分一致で存在確認する (正確な glyph 文字を pin しない)。
    expect(
      headerTexts.some((t) => t?.includes('ソートキー')),
      'hiddenColumns:[] 相当 → sort_key が表示される',
    ).toBe(true)
  })

  it('columnVisibility={memo:false} → メモ列 header / cell が描画されない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnVisibility={{ memo: false }}
      />,
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    expect(screen.queryByRole('columnheader', { name: /メモ/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('メモ 編集')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// smoke ⑧ (Edit-3 T4): sort_key default hidden + toggle UI + re-show
// ===========================================================================

describe('ExamCardTable smoke ⑧ (Edit-3 T4): sort_key default hidden', () => {
  it('sort_key ヘッダが初期状態で DOM に存在しない (columnVisibility 初期値 { sort_key: false })', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
    // sort_key の header 文字列「ソートキー」が DOM に存在しない
    expect(headerTexts).not.toContain('ソートキー')
  })

  it('列 toggle popover に sort_key (ソートキー) が列挙され checkbox が unchecked (hidden 状態)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 「列の表示・非表示」ボタンをクリックして popover を開く
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))

    // sort_key に対応する checkbox が unchecked で列挙される
    await waitFor(() => {
      const sortKeyCheckbox = screen.getByRole('checkbox', { name: '列表示: ソートキー' })
      expect(sortKeyCheckbox).toBeInTheDocument()
      expect(sortKeyCheckbox).not.toBeChecked()
    })
  })

  it('toggle で sort_key を表示にすると ソートキー ヘッダが DOM に現れる (getCanHide() true)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // popover を開いて sort_key を toggle (check)
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))
    const sortKeyCheckbox = await screen.findByRole('checkbox', { name: '列表示: ソートキー' })
    fireEvent.click(sortKeyCheckbox)

    // ソートキー header が DOM に出現する
    // sort_key は S3-1 で enableSorting:true になりヘッダに glyph が付く ('ソートキー▾' 等)。
    await waitFor(() => {
      const allTh = container.querySelectorAll('th')
      const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
      expect(headerTexts.some((t) => t?.includes('ソートキー'))).toBe(true)
    })
  })
})

// ===========================================================================
// Fix-3 T1: CSS 変数配布 + MemoizedTableBody 構造テスト
// ===========================================================================

describe('Fix-3 T1: CSS 変数で列幅を配布 — <table> に CSS 変数 / th・td が var() 参照', () => {
  it('<table> に --col-{id}-size CSS 変数が付与されている', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const tableEl = container.querySelector('table') as HTMLElement
    // title 列は初期表示される列なので --col-title-size が付与されているはず
    const colTitleSize = tableEl.style.getPropertyValue('--col-title-size')
    expect(colTitleSize, '<table> に --col-title-size CSS 変数が付与されている').not.toBe('')
    // 値は正の数値 (px 単位なし)
    expect(parseFloat(colTitleSize)).toBeGreaterThan(0)

    // --header-title-size も付与されている
    const headerTitleSize = tableEl.style.getPropertyValue('--header-title-size')
    expect(headerTitleSize, '<table> に --header-title-size CSS 変数が付与されている').not.toBe('')
    expect(parseFloat(headerTitleSize)).toBeGreaterThan(0)
  })

  it('th の style.width が CSS 変数参照形式 calc(var(--header-{id}-size) * 1px)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    expect(allTh.length).toBeGreaterThan(0)
    for (const th of allTh) {
      expect((th as HTMLElement).style.width, `th "${(th as HTMLElement).textContent?.trim()}" は calc(var(--header-...)) 形式`).toMatch(
        /calc\(var\(--header-[^)]+\) \* 1px\)/,
      )
    }
  })

  it('td の style.width が CSS 変数参照形式 calc(var(--col-{id}-size) * 1px)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTd = container.querySelectorAll('td')
    expect(allTd.length).toBeGreaterThan(0)
    for (const td of allTd) {
      expect((td as HTMLElement).style.width, 'td は calc(var(--col-...)) 形式').toMatch(
        /calc\(var\(--col-[^)]+\) \* 1px\)/,
      )
    }
  })

  it('sticky 撤去後 (Fix-3 T2): select / title の th・td に left が付与されない', async () => {
    // Fix-3 T2 で sticky 2列を撤去したため left は付与されない (旧 0px/44px guard を撤去の非回帰に置換)。
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // th
    const allTh = container.querySelectorAll('th')
    const selectTh = allTh[0] as HTMLElement
    const titleTh = allTh[1] as HTMLElement
    expect(selectTh.style.left).toBe('')
    expect(titleTh.style.left).toBe('')

    // td
    const row = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    const cells = row.querySelectorAll('td')
    const selectTd = cells[0] as HTMLElement
    const titleTd = cells[1] as HTMLElement
    expect(selectTd.style.left).toBe('')
    expect(titleTd.style.left).toBe('')
  })

  it('resize handle が存在する (columnResizeMode guard)', async () => {
    // resize 中のみ MemoizedTableBody を使うが handle が消えていないことを確認
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const handles = container.querySelectorAll('.cursor-col-resize')
    expect(handles.length, 'resize handle が 1 つ以上存在する').toBeGreaterThan(0)
  })

  it('非 resize 時(通常描画)に全行が描画される — memo 出し分けが通常 TableBody を使う', async () => {
    const N = 5
    // N が小さくても TableBody 分岐の確認には十分(300行凍結の実測は Profiler task)
    const db = getClientDb()
    await db.cards.bulkPut(Array.from({ length: N }, (_, i) => makeCard(i + 1)))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // isResizingColumn = false(初期値) → TableBody が使われ全行が描画される
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(N)
    })
  })

  it('[Fix-3 T1 回帰] sort_key toggle 後に <table> が --col-sort_key-size CSS 変数を持つ', async () => {
    // fix 前: columnSizeVars の deps に columnVisibility が含まれないため、sort_key を
    //   toggle で表示しても memo が再計算されず --col-sort_key-size が付与されない (FAIL)。
    // fix 後: columnVisibility を deps に追加したため memo が再計算され --col-sort_key-size が
    //   emit される (PASS)。
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 初期状態: sort_key は hidden → --col-sort_key-size は <table> に付与されていない
    const tableEl = container.querySelector('table') as HTMLElement
    expect(tableEl.style.getPropertyValue('--col-sort_key-size')).toBe('')

    // popover を開いて sort_key を toggle (hidden → visible)
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))
    const sortKeyCheckbox = await screen.findByRole('checkbox', { name: '列表示: ソートキー' })
    fireEvent.click(sortKeyCheckbox)

    // sort_key が visible になった後、columnSizeVars が再計算されて --col-sort_key-size が <table> に付与される
    await waitFor(() => {
      const cssVar = tableEl.style.getPropertyValue('--col-sort_key-size')
      expect(cssVar, '<table> に --col-sort_key-size が付与されている').not.toBe('')
      expect(parseFloat(cssVar), '--col-sort_key-size が正の数値').toBeGreaterThan(0)
    })
  })
})

// ===========================================================================
// M1: 既定 view (条件ゼロ) で列トグルが右寄せされる (ml-auto 担保)
//
// regression: wrapper が justify-between のため、ConditionBar が null を返す既定 view
//   (初期 sorting=[]/filters=[]) では子が列トグル 1 個だけになり左寄せに崩れていた。
//   fix: 列トグル button に ml-auto を付与し sibling 有無に依存せず右端へ寄せる。
//   非空振り: ml-auto 未付与では fail (red)、付与後に pass (green)。
//   (jsdom は layout 計算不可のため、右寄せ意図は ml-auto class 有無で固定する)
// ===========================================================================

// S2-5: 旧 M1「列トグルが ExamCardTable 内で ml-auto 右寄せ」テストは撤去。
// 列ボタンは exam-detail-view の上部 chrome へ移設され、 配置 (view 切替との並び / card view
// 非表示) は exam-detail-view.test で検証する。 ExamCardTable は列ボタンを描画しない。

// ===========================================================================
// Fix-3 T2: 行仮想化 — 大 N で DOM 行数が N 未満に頭打ちする (窓が有界)
//
// 注意 (jsdom 制約): jsdom は layout を計算しない。S2-2 で element virtualizer 化した後は
//   scroll 元の size/行高を offsetWidth/offsetHeight で読む (window virtualizer の innerHeight
//   fallback がない)。vitest.setup.ts の offset* shim (=40) で container が有限高を持ち窓が
//   成立するが、その窓は実ブラウザ (~20-30 行) と一致しない (shim 下では ~overscan+1 行)。
//   本テストは「全 N を mount しない = 仮想化が有界窓で効いている」ことのみを非空振りで
//   担保する (N=200 → 窓 < 200)。実機の窓サイズ・scroll 追従・CPU スパイク解消は
//   S2 締めの stg 300-card smoke に委ねる (report 記載)。
// ===========================================================================

describe('Fix-3 T2: 行仮想化 — 大 N で DOM 行数が有界 (全 N を mount しない)', () => {
  it('N=200 seed → 描画される row-testid は 0 < count < 200 (仮想化が有界窓で効く)', async () => {
    const N = 200
    const db = getClientDb()
    await db.cards.bulkPut(Array.from({ length: N }, (_, i) => makeCard(i + 1)))

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // 少なくとも 1 行は描画される (mount 成立)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/).length).toBeGreaterThan(0)
    })

    // 全 N を mount していないこと = 仮想化が有界窓で機能している非空振り根拠。
    // (jsdom 0-height ゆえ正確な窓サイズは実機依存 — ここでは < N のみを担保)
    const rendered = screen.getAllByTestId(/^row-card-/).length
    expect(rendered, `仮想化で N=${N} 全 mount せず有界 (実測 ${rendered})`).toBeLessThan(N)
  })
})

// ===========================================================================
// Fix-3 cosmetic: select 列 中央揃え — header th・body td の class 検証
// ===========================================================================

describe('Fix-3 cosmetic: select 列 中央揃え', () => {
  it('header select th が text-center と align-middle を持ち text-left を持たない (全選択チェックボックスの th)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 全選択 checkbox を aria-label で特定し、その親 th を取得
    const headerCheckbox = screen.getByRole('checkbox', { name: '全選択' })
    const selectTh = headerCheckbox.closest('th') as HTMLElement
    expect(selectTh, 'select th が存在する').not.toBeNull()
    const classes = selectTh.className.split(' ')
    expect(classes).toContain('text-center')
    expect(classes).toContain('align-middle')
    expect(classes).not.toContain('text-left')

    // 回帰: コンテナ内の全 th から select 以外は text-left を持つ。
    // allTh[0] = select 列 (columns.test T3 で列順先頭が保証済)。index 1 以降を検証。
    const allTh = container.querySelectorAll('th')
    for (let i = 1; i < allTh.length; i++) {
      const th = allTh[i] as HTMLElement
      expect(th.className.split(' '), `th[${i}] "${th.textContent?.trim()}" は text-left を持つ`).toContain('text-left')
      expect(th.className.split(' '), `th[${i}] "${th.textContent?.trim()}" は text-center を持たない`).not.toContain('text-center')
    }
  })

  it('body select td が text-center を持つ (行選択チェックボックスの td)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 行選択 checkbox を aria-label で特定し、その親 td を取得
    const bodyCheckbox = screen.getByRole('checkbox', { name: /行選択/ })
    const selectTd = bodyCheckbox.closest('td') as HTMLElement
    expect(selectTd, 'select td が存在する').not.toBeNull()
    expect(selectTd.className.split(' ')).toContain('text-center')

    // 回帰: 同じ行の非 select td は text-center を持たない。
    // cells[0] = select 列 (columns.test T3 で列順先頭が保証済)。index 1 以降を検証。
    const row = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    const cells = row.querySelectorAll('td')
    for (let i = 1; i < cells.length; i++) {
      const td = cells[i] as HTMLElement
      expect(td.className.split(' '), `td[${i}] は text-center を持たない`).not.toContain('text-center')
    }
  })
})

// ===========================================================================
// S2-2: app-shell 密封 + element virtualizer 差替
//
// jsdom は layout/scroll を計算しない (getBoundingClientRect=0) ため、 実スクロールの
// 正しさ (row window の追従・offset・scroll 保持) は unit で保証できない → stg 300-card
// smoke に委譲する。 ここで unit 固定するのは (a) 密封の構造 class (内部スクロール主体化)、
// (b) element virtualizer の spacer が件数境界 (0/1/少数) で壊れない (phantom spacer なし)、
// (c) fixed action-bar occlusion 回避が container 内部 padding へ移設されたこと。
// ===========================================================================

describe('S2-2: app-shell 密封 — 内部スクロール container の構造', () => {
  it('table container が flex-1 min-h-0 overflow-auto を持ち overflow-x-auto を持たない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const tableEl = container.querySelector('table') as HTMLElement
    const scrollContainer = tableEl.parentElement as HTMLElement
    const classes = scrollContainer.className.split(' ')
    expect(classes, 'container が内部スクロール主体 (overflow-auto)').toContain('overflow-auto')
    expect(classes, 'container が flex-1 で残余高を埋める').toContain('flex-1')
    expect(classes, 'container が min-h-0 で flex chain を切らさない').toContain('min-h-0')
    expect(classes, '旧 window スクロール前提の overflow-x-auto は撤去').not.toContain('overflow-x-auto')
  })

  it('ExamCardTable root が app-shell flex 列 (flex flex-col min-h-0 h-full)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const root = container.firstElementChild as HTMLElement
    const classes = root.className.split(' ')
    expect(classes, 'root が flex 列').toContain('flex')
    expect(classes, 'root が縦積み').toContain('flex-col')
    expect(classes, 'root が min-h-0 で flex chain を切らさない').toContain('min-h-0')
    expect(classes, 'root が親 flex-1 スロットを埋める').toContain('h-full')
  })
})

describe('S2-2: element virtualizer — 件数境界 (0 / 1 / 少数) で spacer が壊れない', () => {
  it('0 件: data 行も aria-hidden spacer 行も描画されない (phantom margin なし)', async () => {
    // seed なし = 0 cards。 hasItems ガードで paddingTop/Bottom=0 → spacer 非描画。
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    // table (thead) は data 未ロードでも即描画される (data=[] スタート)。
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull())
    await waitFor(() => {
      expect(screen.queryAllByTestId(/^row-card-/)).toHaveLength(0)
    })
    const spacers = container.querySelectorAll('tbody tr[aria-hidden]')
    expect(spacers.length, '0 件で spacer 行 (phantom margin) を描画しない').toBe(0)
  })

  it('1 件: 1 data 行 + spacer 高は非負 (element 座標で負 offset なし)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // spacer が出る場合でもその高さは非負 (旧: totalSize+scrollMargin の phantom 余白バグ回帰防止)。
    const spacerTds = container.querySelectorAll('tbody tr[aria-hidden] td')
    spacerTds.forEach((td) => {
      const h = parseFloat((td as HTMLElement).style.height || '0')
      expect(h, 'spacer 高は非負 (負値=座標系ズレ)').toBeGreaterThanOrEqual(0)
    })
  })

  it('少数 (3 件): 全 3 行が描画される (窓が全件を含む)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))
  })
})

describe('S2-2: fixed action-bar occlusion 回避が container 内部 padding へ移設', () => {
  it('行選択で scroll container が pb-32 を持ち、 選択前は持たない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement
    expect(scrollContainer.className.split(' '), '選択前は pb-32 なし').not.toContain('pb-32')

    fireEvent.click(screen.getByRole('checkbox', { name: /行選択/ }))
    await waitFor(() => {
      expect(
        scrollContainer.className.split(' '),
        '選択後は container 内部下部に pb-32 (fixed bar 非 occlusion)',
      ).toContain('pb-32')
    })
  })
})

// ===========================================================================
// S2-3: sticky thead + th 不透明背景
//
// jsdom は sticky を実描画しないため、class 存在で構造を固定する。
// 実挙動 (内部スクロール中の thead 固定・行非透過・Popover 非クリップ) は
// S2 締め stg smoke に委譲する。
// ===========================================================================

describe('S2-3: sticky thead + th 不透明背景', () => {
  it('thead が sticky top-0 z-10 クラスを持つ', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const thead = container.querySelector('thead') as HTMLElement
    expect(thead, 'thead が存在する').not.toBeNull()
    const classes = thead.className.split(' ')
    expect(classes, 'thead が sticky を持つ').toContain('sticky')
    expect(classes, 'thead が top-0 を持つ').toContain('top-0')
    expect(classes, 'thead が z-10 を持つ').toContain('z-10')
  })

  it('全 th が bg-background クラスを持つ (不透明背景 — sticky 時に下の行が透けない)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    expect(allTh.length, '少なくとも 1 つの th が存在する').toBeGreaterThan(0)
    for (const th of allTh) {
      expect(
        (th as HTMLElement).className,
        `th "${(th as HTMLElement).textContent?.trim()}" は bg-background を持つ`,
      ).toContain('bg-background')
    }
  })

  it('th 自体には sticky class が付与されない (thead 単位 sticky / per-th ではない)', async () => {
    // S2-3 は thead 単位の sticky を採用 (per-th sticky は fallback)。
    // Fix-3 T2 (scroll-frozen 列撤去) との整合を維持するため、th 自体に sticky は付けない。
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    for (const th of allTh) {
      const el = th as HTMLElement
      expect(
        el.className,
        `th "${el.textContent?.trim()}" に sticky class が付与されない (thead 単位)`,
      ).not.toContain('sticky')
    }
  })
})

// ===========================================================================
// S2-4: 条件バー A-out(flex-none)確定 — D-4 不変条件
//
// D-4 不変条件:
//   1. 条件バー wrapper が flex-none(container の外・上)
//   2. container が flex-1 min-h-0 overflow-auto
//   3. chip 有無(可変高バー)で container/thead 構造が崩れない
//   4. JS 高さ制御(ResizeObserver / window resize listener)が再導入されていない
//
// chip 有/無の対比で非空振り(単に pass するだけでなく状態遷移を追う)。
// jsdom は layout 計算をしないため、class 存在 + inline style 不在で構造を固定する。
// 実 layout の崩れ確認(バー高変化でスクロールが壊れないか)は S2 締め stg smoke に委譲。
// ===========================================================================

describe('S2-4: 条件バー wrapper が flex-none を持つ(D-4 不変条件)', () => {
  it('条件ゼロ(ConditionBar null): 条件バー wrapper が flex-none を持つ', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 条件ゼロ → ConditionBar は null (chip / クリア 不在)
    expect(screen.queryByTestId(/^condition-chip-/)).toBeNull()
    expect(screen.queryByText('クリア')).toBeNull()

    // data-testid で条件バー wrapper を取得 (F4: positional traversal 廃止)
    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    expect(
      condBarWrapper.className.split(' '),
      '条件バー wrapper が flex-none を持つ(chip 無し)',
    ).toContain('flex-none')
  })

  it('sort 適用(chip 有り): 条件バー wrapper が flex-none を維持し container/thead が不変', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // タイトル 列メニュー → 昇順 を適用 → ConditionBar が sort chip を描画する
    fireEvent.click(screen.getByRole('button', { name: 'タイトル の列メニュー' }))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))
    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
    })

    // chip 有りでも 条件バー wrapper が flex-none を維持する
    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    expect(
      condBarWrapper.className.split(' '),
      'chip 有りでも flex-none を維持',
    ).toContain('flex-none')

    // container が flex-1 min-h-0 overflow-auto を維持する
    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement
    const scrollClasses = scrollContainer.className.split(' ')
    expect(scrollClasses, 'chip 有りでも container が flex-1').toContain('flex-1')
    expect(scrollClasses, 'chip 有りでも container が min-h-0').toContain('min-h-0')
    expect(scrollClasses, 'chip 有りでも container が overflow-auto').toContain('overflow-auto')

    // thead が sticky top-0 z-10 を維持する
    const thead = container.querySelector('thead') as HTMLElement
    const theadClasses = thead.className.split(' ')
    expect(theadClasses, 'chip 有りでも thead が sticky').toContain('sticky')
    expect(theadClasses, 'chip 有りでも thead が top-0').toContain('top-0')
    expect(theadClasses, 'chip 有りでも thead が z-10').toContain('z-10')
  })
})

describe('S2-4: 可変高バー安定性 — chip 有無の対比で構造が不変(D-4 非空振り)', () => {
  it('chip 無し → sort chip 有り → クリアで chip 無しに戻る、全状態で container/thead 構造が不変', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement
    const thead = container.querySelector('thead') as HTMLElement

    // --- chip 無し状態のアサーション ---
    expect(scrollContainer.className.split(' '), 'chip 無し: container flex-1').toContain('flex-1')
    expect(scrollContainer.className.split(' '), 'chip 無し: container min-h-0').toContain('min-h-0')
    expect(thead.className.split(' '), 'chip 無し: thead sticky').toContain('sticky')
    expect(thead.className.split(' '), 'chip 無し: thead top-0').toContain('top-0')
    expect(thead.className.split(' '), 'chip 無し: thead z-10').toContain('z-10')

    // --- sort 適用 → chip 有り状態に遷移 ---
    fireEvent.click(screen.getByRole('button', { name: 'タイトル の列メニュー' }))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))
    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
    })

    // --- chip 有り状態で同一アサーション(可変高でも構造安定) ---
    expect(scrollContainer.className.split(' '), 'chip 有り: container flex-1 不変').toContain('flex-1')
    expect(scrollContainer.className.split(' '), 'chip 有り: container min-h-0 不変').toContain('min-h-0')
    expect(thead.className.split(' '), 'chip 有り: thead sticky 不変').toContain('sticky')
    expect(thead.className.split(' '), 'chip 有り: thead top-0 不変').toContain('top-0')
    expect(thead.className.split(' '), 'chip 有り: thead z-10 不変').toContain('z-10')

    // chip 有り → クリアして chip 無しに戻す (S2b-3: 文言「クリア」)
    fireEvent.click(screen.getByText('クリア'))
    await waitFor(() => {
      expect(screen.queryByTestId(/^condition-chip-/)).toBeNull()
    })

    // --- chip 無しに戻った後も構造は不変 ---
    expect(scrollContainer.className.split(' '), 'クリア後: container flex-1 不変').toContain('flex-1')
    expect(scrollContainer.className.split(' '), 'クリア後: container min-h-0 不変').toContain('min-h-0')
    expect(thead.className.split(' '), 'クリア後: thead sticky 不変').toContain('sticky')
    expect(thead.className.split(' '), 'クリア後: thead top-0 不変').toContain('top-0')
    expect(thead.className.split(' '), 'クリア後: thead z-10 不変').toContain('z-10')
  })
})

describe('S2-4: JS 高さ制御なし(D-4 flex ネイティブ)', () => {
  it('container に inline height style が付与されない(ResizeObserver / JS 高さ制御が再導入されていない)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement
    // JS 高さ制御があれば container に style.height が設定される。flex ネイティブではゼロ。
    expect(scrollContainer.style.height, 'container に inline height が設定されない').toBe('')

    // sort 適用でバー高が変わった後も inline height が付与されない
    fireEvent.click(screen.getByRole('button', { name: 'タイトル の列メニュー' }))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))
    await waitFor(() => {
      expect(screen.getByTestId('condition-chip-sort-title')).toBeInTheDocument()
    })
    expect(scrollContainer.style.height, 'sort(バー高変化)後も inline height なし').toBe('')
  })
})

// ===========================================================================
// S2b-1: 中間帯 collapse — 構造テスト(b)(c)
//
// jsdom は scroll/layout 計算不可のため:
//   - rAF を同期モック(beforeEach stub)
//   - scrollTop/scrollHeight/clientHeight を Object.defineProperty でスタブ
//   - fireEvent.scroll で scroll ハンドラを発火
//   - class 変化を waitFor で確認
//
// (b) collapsed → condBarWrapper に grid-rows-[0fr] / expand で grid-rows-[1fr] 復帰
// (c) onCollapsedChange 伝播(ExamCardTable を直接 render し spy で確認)
// ===========================================================================

describe('S2b-1 (b): condBarWrapper collapse / expand — scroll で class が切替', () => {
  // rAF を同期実行にして scroll → 状態更新を 1 イベントループで追う
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  // non-vacuous guard: rAF が同期実行されることを確認(テストが空振りでないことの証明)
  it('(前提) rAF stub が同期実行されること', () => {
    let called = false
    requestAnimationFrame(() => { called = true })
    expect(called, 'rAF stub は同期実行').toBe(true)
  })

  it('初期状態: condBarWrapper が grid-rows-[1fr] を持ち grid-rows-[0fr] を持たない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    expect(condBarWrapper.className, '初期は grid-rows-[1fr]').toContain('grid-rows-[1fr]')
    expect(condBarWrapper.className, '初期は grid-rows-[0fr] なし').not.toContain('grid-rows-[0fr]')
  })

  it('scrollTop > 24, guard 十分 → condBarWrapper が grid-rows-[0fr] に切替(collapse)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    // scroll container は table の親要素
    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // スタブ: scrollTop > 24, guard 十分(500 - 200 - 40 = 260 >= 8)
    // offsetHeight stub=40 → middleBandHeight = condBar(40) + chrome(0, chromeRef なし) = 40
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })

    fireEvent.scroll(scrollContainer)

    await waitFor(() => {
      expect(condBarWrapper.className, 'collapse で grid-rows-[0fr]').toContain('grid-rows-[0fr]')
      expect(condBarWrapper.className, 'collapse で grid-rows-[1fr] 消滅').not.toContain('grid-rows-[1fr]')
    })
  })

  it('collapse 後に scrollTop < 8 → condBarWrapper が grid-rows-[1fr] に戻る(expand)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // collapse
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(condBarWrapper.className).toContain('grid-rows-[0fr]'))

    // expand: scrollTop < 8
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 5, configurable: true })
    fireEvent.scroll(scrollContainer)

    await waitFor(() => {
      expect(condBarWrapper.className, 'expand で grid-rows-[1fr] 復帰').toContain('grid-rows-[1fr]')
      expect(condBarWrapper.className, 'expand で grid-rows-[0fr] 消滅').not.toContain('grid-rows-[0fr]')
    })
  })

  it('guard failure: 短コンテンツで scrollTop > 24 でも collapse しない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // scrollTop > 24 だが guard 失敗:
    // offsetHeight stub=40 → middleBandHeight=40 / 205 - 200 - 40 = -35 < 8
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 205, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })

    fireEvent.scroll(scrollContainer)
    await act(async () => {})

    // guard 不足 → collapsed=false 維持
    expect(condBarWrapper.className, 'guard 失敗で grid-rows-[0fr] にならない').not.toContain('grid-rows-[0fr]')
    expect(condBarWrapper.className, 'guard 失敗で grid-rows-[1fr] 維持').toContain('grid-rows-[1fr]')
  })

  it('hysteresis: 8 <= scrollTop <= 24 の zone では状態を変化させない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // zone 内のスクロール(8 <= scrollTop <= 24) → 変化なし
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 16, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })

    fireEvent.scroll(scrollContainer)
    await act(async () => {})

    // current=false のまま変化なし
    expect(condBarWrapper.className, 'hysteresis zone で grid-rows-[1fr] 維持').toContain('grid-rows-[1fr]')
  })
})

describe('S2b-1 (b): condBarWrapper 構造 — collapse wrapper の内側構造', () => {
  it('condBarWrapper が flex-none を維持(既存 D-4 不変条件)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    expect(condBarWrapper.className, 'flex-none を維持').toContain('flex-none')
  })

  it('condBarWrapper 内側に min-h-0 overflow-hidden div が存在する(unmount なし保証)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    // 内側 div: min-h-0 overflow-hidden
    const innerDiv = condBarWrapper.firstElementChild as HTMLElement
    expect(innerDiv.className, '内側に min-h-0').toContain('min-h-0')
    expect(innerDiv.className, '内側に overflow-hidden').toContain('overflow-hidden')
  })

  it('collapse → condBarWrapper 内側 div が inert を持つ(F1 a11y)', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(performance.now()); return 0 })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    const innerDiv = condBarWrapper.firstElementChild as HTMLElement
    const scrollContainer = (container.querySelector('table') as HTMLElement).parentElement as HTMLElement

    // 展開状態: inert なし
    expect(innerDiv, '展開時は inert なし').not.toHaveAttribute('inert')

    // collapse
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)

    await waitFor(() => {
      expect(innerDiv, 'collapse → inert を持つ').toHaveAttribute('inert')
    })

    vi.unstubAllGlobals()
  })

  it('collapse → expand で condBarWrapper 内側 div の inert が消える(F1 a11y)', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(performance.now()); return 0 })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const condBarWrapper = container.querySelector('[data-testid="cond-bar-wrapper"]') as HTMLElement
    const innerDiv = condBarWrapper.firstElementChild as HTMLElement
    const scrollContainer = (container.querySelector('table') as HTMLElement).parentElement as HTMLElement

    // collapse
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(innerDiv).toHaveAttribute('inert'))

    // expand: scrollTop < 8
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 5, configurable: true })
    fireEvent.scroll(scrollContainer)

    await waitFor(() => {
      expect(innerDiv, 'expand → inert が消える').not.toHaveAttribute('inert')
    })

    vi.unstubAllGlobals()
  })
})

describe('S2b-1 (c): onCollapsedChange 伝播テスト', () => {
  // rAF を同期実行にする
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('scrollTop > 24 → onCollapsedChange(true) が呼ばれる', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const onCollapsedChange = vi.fn()

    const { container } = render(
      <ExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        columnVisibility={{}}
        onColumnVisibilityChange={() => {}}
        onCollapsedChange={onCollapsedChange}
      />,
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })

    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(onCollapsedChange).toHaveBeenCalledWith(true))
  })

  it('collapse 後 scrollTop < 8 → onCollapsedChange(false) が呼ばれる(expand)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const onCollapsedChange = vi.fn()

    const { container } = render(
      <ExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        columnVisibility={{}}
        onColumnVisibilityChange={() => {}}
        onCollapsedChange={onCollapsedChange}
      />,
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // collapse
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(onCollapsedChange).toHaveBeenCalledWith(true))

    onCollapsedChange.mockClear()

    // expand
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 5, configurable: true })
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(onCollapsedChange).toHaveBeenCalledWith(false))
  })

  it('collapsed が変化しない scroll では onCollapsedChange は呼ばれない(boolean 変化時のみ)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const onCollapsedChange = vi.fn()

    const { container } = render(
      <ExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        columnVisibility={{}}
        onColumnVisibilityChange={() => {}}
        onCollapsedChange={onCollapsedChange}
      />,
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // hysteresis zone — 変化なし
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 16, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })

    fireEvent.scroll(scrollContainer)
    await act(async () => {})

    expect(onCollapsedChange, 'hysteresis zone では呼ばれない').not.toHaveBeenCalled()
  })
})

// ===========================================================================
// S2b-2: ScrollTopButton — 表示条件 3 態 + click で scrollTo 呼出
//
// collapsed 信号は scroll イベントで駆動する (S2b-1 と同一パターン)。
// rAF を同期 stub にして scroll → 状態更新を 1 イベントループで完結させる。
// scrollTo は tableContainerRef.current(table の parentElement)への代入 spy で検証。
// ===========================================================================

describe('S2b-2: ScrollTopButton 表示条件 3 態', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('collapsed=false (初期状態): scroll-top-button が DOM に存在しない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 初期 collapsed=false → ボタン非表示 (unmount)
    expect(screen.queryByTestId('scroll-top-button')).not.toBeInTheDocument()
  })

  it('collapsed=true かつ選択なし: scroll-top-button が DOM に現れる', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // scrollTop > 24 かつ guard 十分 → collapsed=true に遷移
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)

    await waitFor(() => {
      expect(screen.getByTestId('scroll-top-button')).toBeInTheDocument()
    })
  })

  it('collapsed=true かつ行選択中: scroll-top-button が DOM に存在しない (action bar 競合回避)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // まず collapsed=true にする
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(screen.getByTestId('scroll-top-button')).toBeInTheDocument())

    // 行選択 → selectedIds.length > 0 → ボタン非表示
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    await waitFor(() => {
      expect(screen.queryByTestId('scroll-top-button')).not.toBeInTheDocument()
    })
  })
})

describe('S2b-2: ScrollTopButton click → scrollTo 呼出', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('click → tableContainerRef.current.scrollTo({ top: 0, behavior: "smooth" }) が呼ばれる', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const scrollContainer = (container.querySelector('table') as HTMLElement)
      .parentElement as HTMLElement

    // scrollTo をスパイとして注入(jsdom は scrollTo が no-op のためモックで検証)
    const scrollToSpy = vi.fn()
    scrollContainer.scrollTo = scrollToSpy as unknown as typeof scrollContainer.scrollTo

    // collapsed=true に遷移させてボタンを表示
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
    fireEvent.scroll(scrollContainer)
    await waitFor(() => expect(screen.getByTestId('scroll-top-button')).toBeInTheDocument())

    // ボタンをクリック
    fireEvent.click(screen.getByTestId('scroll-top-button'))

    // scrollTo が正しい引数で呼ばれた
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})
