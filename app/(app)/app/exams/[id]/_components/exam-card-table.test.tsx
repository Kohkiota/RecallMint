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
// Fix-1 T2 追記: bulk createOptionAndAssign 配線 + 回帰 (action-bar 限定、 filter-bar/TagCell 不変)。

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
})

describe('Fix-1 T2: 回帰 — filter-bar / TagCell の tagEditCallbacks は不変', () => {
  // 回帰条件: bulkTagEditCallbacks が filter-bar や TagCell に誤って渡された場合、
  // filter-bar の tag popover で option 新規作成をトリガすると createOption (= mockCreateOption) が
  // 呼ばれてしまう。本テストはその leak を行動レベルで検出する。
  //
  // 検証戦略: filter-bar の「タグで絞り込み」popover から新規 option 作成パスを実行する。
  //   - tagEditCallbacks.createOptionAndAssign = no-op placeholder → mockCreateOption 非呼出
  //   - もし bulkTagEditCallbacks が filter-bar に誤配線された場合 → mockCreateOption が呼ばれ失敗
  //
  // action-bar が bulkCreateOptionAndAssign を呼ぶことは上の T2 テストで証明済み。
  // 本テストは「filter-bar 側が独立した no-op 経路を通ること」の isolation のみを確認する。
  it('filter-bar の createOptionAndAssign は no-op — bulkTagEditCallbacks の leak を検出する isolation テスト', async () => {
    mockCreateOption.mockClear()
    mockBulkTag.mockClear()

    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1)])
    await db.tag_categories.put(FIX1_CATEGORY)

    render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // filter-bar の「タグで絞り込み」popover を開く (action-bar は未表示 = 行未選択)
    const filterBar = screen.getByTestId('exam-card-table-filter-bar')
    fireEvent.click(within(filterBar).getByText('タグで絞り込み'))

    // stage1: カテゴリ選択 → Difficulty を選択して option stage へ
    const catInput = await screen.findByLabelText('category を検索 / 新規作成')
    fireEvent.change(catInput, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('Difficulty')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Difficulty'))

    // stage2: option 新規作成 → 「新規作成: FilterOpt」を click
    const optInput = await screen.findByLabelText('option を検索 / 新規作成')
    fireEvent.change(optInput, { target: { value: 'FilterOpt' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '新規作成: FilterOpt' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: '新規作成: FilterOpt' }))

    // filter-bar のパスでは tagEditCallbacks.createOptionAndAssign = no-op placeholder のため
    // mockCreateOption (= module-level createOption) は呼ばれない。
    // リグレッション: bulkTagEditCallbacks が filter-bar に誤配線された場合ここで 1+ 回呼ばれ失敗する。
    await waitFor(() => {
      expect(mockCreateOption).not.toHaveBeenCalled()
    })
  })
})

// ===========================================================================
// smoke ⑦ (Edit-3 T3): sticky 2列 — select + title の left offset
// 列順: select(0) / title(1) / sort_key(2) / question(3) / ...
// ===========================================================================

describe('ExamCardTable smoke ⑦ (Edit-3 T3): sticky 2列 left offset', () => {
  it('th: ① select に sticky+left:0px ② title に sticky+left:44px ③ question に left 付与なし ④ sticky th に width 維持', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    const selectTh = allTh[0] as HTMLElement  // select 列
    const titleTh = allTh[1] as HTMLElement   // title 列
    const questionTh = allTh[3] as HTMLElement // question 列(非 sticky)

    // ① select th: sticky class + left:0
    expect(selectTh.className).toContain('sticky')
    expect(selectTh.style.left).toBe('0px')

    // ② title th: sticky class + left:44
    expect(titleTh.className).toContain('sticky')
    expect(titleTh.style.left).toBe('44px')

    // ③ 非 sticky 列に left 付与なし
    expect(questionTh.className).not.toContain('sticky')
    expect(questionTh.style.left).toBe('')

    // ④ sticky セルの style に既存 width が維持されている
    expect(selectTh.style.width).toMatch(/^\d+(\.\d+)?px$/)
    expect(titleTh.style.width).toMatch(/^\d+(\.\d+)?px$/)
  })

  it('td: ① select に sticky+left:0px ② title に sticky+left:44px ③ question に left 付与なし ④ sticky td に width 維持', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const row = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    const cells = row.querySelectorAll('td')
    const selectTd = cells[0] as HTMLElement  // select 列
    const titleTd = cells[1] as HTMLElement   // title 列
    const questionTd = cells[3] as HTMLElement // question 列(非 sticky)

    // ① select td: sticky class + left:0
    expect(selectTd.className).toContain('sticky')
    expect(selectTd.style.left).toBe('0px')

    // ② title td: sticky class + left:44
    expect(titleTd.className).toContain('sticky')
    expect(titleTd.style.left).toBe('44px')

    // ③ 非 sticky 列に left 付与なし
    expect(questionTd.className).not.toContain('sticky')
    expect(questionTd.style.left).toBe('')

    // ④ sticky セルの style に既存 width が維持されている
    expect(selectTd.style.width).toMatch(/^\d+(\.\d+)?px$/)
    expect(titleTd.style.width).toMatch(/^\d+(\.\d+)?px$/)
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
