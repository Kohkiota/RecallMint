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
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
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

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
// Edit-3 Fix-1: columnVisibility round-trip
// sort_key を表示に toggle した状態の saved record (hiddenColumns:[]) が
// リロード後も尊重されること。
// fix 前: length>0 guard が setColumnVisibility をスキップ → 初期 { sort_key: false } 復帰 → FAIL
// fix 後: saved が存在すれば常に setColumnVisibility({}) → sort_key 表示を維持 → PASS
// ===========================================================================

describe('Edit-3 Fix-1: columnVisibility round-trip — saved hiddenColumns:[] → sort_key 表示維持', () => {
  it('[fix前fail→fix後pass] hiddenColumns:[] の saved record → reload 後も sort_key が表示のまま', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    // sort_key を表示にした状態の saved record (hiddenColumns 空) を sync_meta に seed。
    // これは「ユーザーが sort_key を toggle して表示にし、persist が hiddenColumns:[] を書いた」状況に相当。
    await db.sync_meta.put({
      key: 'exam_view_prefs',
      value: JSON.stringify({ version: 2, view: 'table', hiddenColumns: [] }),
    })

    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // row が描画されるのを待つ
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // mount load effect が非同期で saved record を読み setColumnVisibility({}) を呼ぶのを待つ。
    // fix前: hiddenColumns.length>0 guard でスキップ → 初期 { sort_key: false } 維持 → "ソートキー" が DOM に存在しない → FAIL
    // fix後: saved 有りなので setColumnVisibility({}) → sort_key 表示 → "ソートキー" が DOM に現れる → PASS
    await waitFor(() => {
      const allTh = container.querySelectorAll('th')
      const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
      expect(headerTexts, 'sort_key (ソートキー) が saved record の hiddenColumns:[] を尊重して表示されている').toContain('ソートキー')
    })
  })

  it('saved record が存在しない新規ユーザー → sort_key は既定 hidden のまま', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    // sync_meta は空 (beforeEach で clear 済み) = 新規ユーザー

    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // saved 無しなら load effect は setState せず初期 { sort_key: false } が維持される
    const allTh = container.querySelectorAll('th')
    const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
    expect(headerTexts, 'saved record なし → sort_key 既定 hidden').not.toContain('ソートキー')
  })
})

// ===========================================================================
// smoke ⑧ (Edit-3 T4): sort_key default hidden + toggle UI + re-show
// ===========================================================================

describe('ExamCardTable smoke ⑧ (Edit-3 T4): sort_key default hidden', () => {
  it('sort_key ヘッダが初期状態で DOM に存在しない (columnVisibility 初期値 { sort_key: false })', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
    // sort_key の header 文字列「ソートキー」が DOM に存在しない
    expect(headerTexts).not.toContain('ソートキー')
  })

  it('列 toggle popover に sort_key (ソートキー) が列挙され checkbox が unchecked (hidden 状態)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // popover を開いて sort_key を toggle (check)
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))
    const sortKeyCheckbox = await screen.findByRole('checkbox', { name: '列表示: ソートキー' })
    fireEvent.click(sortKeyCheckbox)

    // ソートキー header が DOM に出現する
    await waitFor(() => {
      const allTh = container.querySelectorAll('th')
      const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
      expect(headerTexts).toContain('ソートキー')
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const handles = container.querySelectorAll('.cursor-col-resize')
    expect(handles.length, 'resize handle が 1 つ以上存在する').toBeGreaterThan(0)
  })

  it('非 resize 時(通常描画)に全行が描画される — memo 出し分けが通常 TableBody を使う', async () => {
    const N = 5
    // N が小さくても TableBody 分岐の確認には十分(300行凍結の実測は Profiler task)
    const db = getClientDb()
    await db.cards.bulkPut(Array.from({ length: N }, (_, i) => makeCard(i + 1)))
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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

describe('M1: 既定 view で列トグルが右寄せ (ml-auto)', () => {
  it('条件ゼロ (ConditionBar 非表示) でも列トグル button が ml-auto を持つ', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // (a) 既定 view = 条件ゼロ → ConditionBar は null (条件 chip / すべてクリア 不在)
    expect(screen.queryByText('すべてクリア')).toBeNull()
    expect(screen.queryByTestId(/^condition-chip-/)).toBeNull()

    // (b) 列トグル button が ml-auto で末尾寄せ (sibling 非依存の右寄せ)
    const toggle = screen.getByRole('button', { name: '列の表示・非表示' })
    expect(toggle.className.split(' ')).toContain('ml-auto')
  })
})

// ===========================================================================
// Fix-3 T2: 行仮想化 — 大 N で DOM 行数が N 未満に頭打ちする (窓が有界)
//
// 注意 (jsdom 制約): jsdom は layout 0 (getBoundingClientRect=0) のため
//   measureElement が 0 高を返し、virtualizer の可視窓は実ブラウザ (~20-30 行) と
//   一致しない。本テストは「全 N を mount しない = 仮想化が有界窓で効いている」ことのみを
//   非空振りで担保する (N=200 → 実測 106 行 < 200)。実機の ~20-30 窓・CPU スパイク解消は
//   OT の実機 smoke に委ねる (report 記載)。
// ===========================================================================

describe('Fix-3 T2: 行仮想化 — 大 N で DOM 行数が有界 (全 N を mount しない)', () => {
  it('N=200 seed → 描画される row-testid は 0 < count < 200 (仮想化が有界窓で効く)', async () => {
    const N = 200
    const db = getClientDb()
    await db.cards.bulkPut(Array.from({ length: N }, (_, i) => makeCard(i + 1)))

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)

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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
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
