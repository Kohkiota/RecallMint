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

import * as React from 'react'
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

// ---------------------------------------------------------------------------
// row-ux Task 5 (c): ExamCardTableAddFooter capture wrapper。
// exam-card-table-dnd.test.tsx の DndContext capture wrapper (line 43-73) と同型 —
// props を ref へ保存しつつ実 component をそのまま描画する (pass-through)。
// button は positionLocked 中は native disabled で click 不能 (=addCard 呼出を起点にした
// 観測は構造的に不可能。詳細は task-5-report.md) だが、 親 (ExamCardTable) が算出した
// baseOrders/count の値そのものは props 境界で捕捉できる。 このファイル内の他の render
// (既存 (a)(b) 含む全 describe) も本 wrapper 経由になるが実 component を描画するため
// 挙動は不変。
// ---------------------------------------------------------------------------

type CapturedFooterProps = { baseOrders: number[]; count: number }

const { capturedFooterPropsRef } = vi.hoisted(() => ({
  capturedFooterPropsRef: { current: null as null | CapturedFooterProps },
}))

vi.mock('./exam-card-table-add-footer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exam-card-table-add-footer')>()
  return {
    ...actual,
    ExamCardTableAddFooter: (props: Parameters<typeof actual.ExamCardTableAddFooter>[0]) => {
      capturedFooterPropsRef.current = { baseOrders: props.baseOrders, count: props.count }
      return React.createElement(actual.ExamCardTableAddFooter, props)
    },
  }
})

// Mock createOption from @/lib/tags/tag-crud; keep all other exports real.
vi.mock('@/lib/tags/tag-crud', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tags/tag-crud')>()
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
import { ExamCardTable } from './exam-card-table'
import { ADD_CARD_LOCKED_REASON } from './exam-card-table-add-footer'

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
  }
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  capturedFooterPropsRef.current = null
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
// Edit-3 T1: th/td padding density (py-2 → py-1 → py-2)
//
// row-ux UI fix A-1 review F1: 内側 edit div の padding を 0 にした分、縦方向は td/th 側で
// 補償する (py-1→py-2)。旧実効縦余白 (編集セルは md+ で 6〜8px) を下回らないための復元。
// ===========================================================================

describe('Edit-3 T1: th/td padding density', () => {
  it('th が py-2 クラスを持ち py-1 を持たない (review F1: 内側 padding 0 化の縦方向補償)', async () => {
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
        `th "${th.textContent?.trim()}" は py-2 を持つ`,
      ).toContain('py-2')
      expect(
        th.className,
        `th "${th.textContent?.trim()}" は py-1 を持たない`,
      ).not.toContain('py-1')
    }
  })

  it('td が py-2 クラスを持ち py-1 を持たない (review F1: 内側 padding 0 化の縦方向補償)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })
    // tbody 限定 (row-ux Task 5: tfoot の「+ カードを追加」summary td は colSpan で全列を
    // 跨ぐ別物のため対象外 — この test の意図は per-column body td の密度)。
    const allTd = container.querySelectorAll('tbody td')
    expect(allTd.length).toBeGreaterThan(0)
    for (const td of allTd) {
      expect(td.className, 'td は py-2 を持つ').toContain('py-2')
      expect(td.className, 'td は py-1 を持たない').not.toContain('py-1')
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
    // tbody 限定 (row-ux Task 5: tfoot summary td は対象外、上の py-1/py-2 test と同理由)。
    const allTd = container.querySelectorAll('tbody td')
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
// 撤去の非回帰 guard に置き換える。列順: select(0) / title(1) / question_label(hidden) / question ...
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
// harness は初期 { question_label: false } を与えるため、 question_label は既定 hidden。
// initialColumnVisibility={} (= saved hiddenColumns:[] 相当) を渡すと question_label が表示される
// = 旧 mount-load round-trip の振る舞い等価 (所有者だけが detail-view に移動)。
// ===========================================================================

describe('S2-5: ExamCardTable controlled columnVisibility 契約', () => {
  it('columnVisibility={question_label:false} (harness 既定) → question_label ヘッダが hidden', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const headerTexts = Array.from(container.querySelectorAll('th')).map((th) =>
      (th as HTMLElement).textContent?.trim(),
    )
    expect(headerTexts, '既定 { question_label: false } → question_label hidden').not.toContain('番号')
  })

  it('columnVisibility={} (saved hiddenColumns:[] 相当) → question_label ヘッダが表示される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))

    const { container } = render(
      <ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} initialColumnVisibility={{}} />,
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const headerTexts = Array.from(container.querySelectorAll('th')).map((th) =>
      (th as HTMLElement).textContent?.trim(),
    )
    // question_label は S3-1 で enableSorting:true になりヘッダに glyph が付く ('番号▾' 等)。
    // 部分一致で存在確認する (正確な glyph 文字を pin しない)。
    expect(
      headerTexts.some((t) => t?.includes('番号')),
      'hiddenColumns:[] 相当 → question_label が表示される',
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
// smoke ⑧ (Edit-3 T4): question_label default hidden + toggle UI + re-show
// ===========================================================================

describe('ExamCardTable smoke ⑧ (Edit-3 T4): question_label default hidden', () => {
  it('question_label ヘッダが初期状態で DOM に存在しない (columnVisibility 初期値 { question_label: false })', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const allTh = container.querySelectorAll('th')
    const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
    // question_label の header 文字列「番号」が DOM に存在しない
    expect(headerTexts).not.toContain('番号')
  })

  it('列 toggle popover に question_label (番号) が列挙され checkbox が unchecked (hidden 状態)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 「列の表示・非表示」ボタンをクリックして popover を開く
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))

    // question_label に対応する checkbox が unchecked で列挙される
    await waitFor(() => {
      const questionLabelCheckbox = screen.getByRole('checkbox', { name: '列表示: 番号' })
      expect(questionLabelCheckbox).toBeInTheDocument()
      expect(questionLabelCheckbox).not.toBeChecked()
    })
  })

  it('toggle で question_label を表示にすると 番号 ヘッダが DOM に現れる (getCanHide() true)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // popover を開いて question_label を toggle (check)
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))
    const questionLabelCheckbox = await screen.findByRole('checkbox', { name: '列表示: 番号' })
    fireEvent.click(questionLabelCheckbox)

    // 番号 header が DOM に出現する
    // question_label は S3-1 で enableSorting:true になりヘッダに glyph が付く ('番号▾' 等)。
    await waitFor(() => {
      const allTh = container.querySelectorAll('th')
      const headerTexts = Array.from(allTh).map((th) => (th as HTMLElement).textContent?.trim())
      expect(headerTexts.some((t) => t?.includes('番号'))).toBe(true)
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

    // tbody 限定 (row-ux Task 5: tfoot summary td は colSpan で全列を跨ぐため
    // per-column 幅 CSS 変数を参照しない — この test の意図は per-column body td の幅配布)。
    const allTd = container.querySelectorAll('tbody td')
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

  it('[Fix-3 T1 回帰] question_label toggle 後に <table> が --col-question_label-size CSS 変数を持つ', async () => {
    // fix 前: columnSizeVars の deps に columnVisibility が含まれないため、question_label を
    //   toggle で表示しても memo が再計算されず --col-question_label-size が付与されない (FAIL)。
    // fix 後: columnVisibility を deps に追加したため memo が再計算され --col-question_label-size が
    //   emit される (PASS)。
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 初期状態: question_label は hidden → --col-question_label-size は <table> に付与されていない
    const tableEl = container.querySelector('table') as HTMLElement
    expect(tableEl.style.getPropertyValue('--col-question_label-size')).toBe('')

    // popover を開いて question_label を toggle (hidden → visible)
    fireEvent.click(screen.getByRole('button', { name: '列の表示・非表示' }))
    const questionLabelCheckbox = await screen.findByRole('checkbox', { name: '列表示: 番号' })
    fireEvent.click(questionLabelCheckbox)

    // question_label が visible になった後、columnSizeVars が再計算されて --col-question_label-size が <table> に付与される
    await waitFor(() => {
      const cssVar = tableEl.style.getPropertyValue('--col-question_label-size')
      expect(cssVar, '<table> に --col-question_label-size が付与されている').not.toBe('')
      expect(parseFloat(cssVar), '--col-question_label-size が正の数値').toBeGreaterThan(0)
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
  it('header select th が text-center / align-middle / cursor-pointer を持ち text-left を持たない (全選択チェックボックスの th)', async () => {
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
    // B: th 全域クリック化のカーソル表現。
    expect(classes).toContain('cursor-pointer')
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

  it('body select td が text-center / cursor-pointer を持ち、全 td が align-top を持つ (行選択チェックボックスの td + 全列上揃え)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 行選択 checkbox を aria-label で特定し、その親 td を取得
    const bodyCheckbox = screen.getByRole('checkbox', { name: /行選択/ })
    const selectTd = bodyCheckbox.closest('td') as HTMLElement
    expect(selectTd, 'select td が存在する').not.toBeNull()
    expect(selectTd.className.split(' ')).toContain('text-center')
    // B: td 全域クリック化のカーソル表現。
    expect(selectTd.className.split(' ')).toContain('cursor-pointer')

    // 回帰: 同じ行の非 select td は text-center / cursor-pointer を持たない。
    // C: 全 td (select 含む) が align-top を持つ (全列一律上揃え)。
    // cells[0] = select 列 (columns.test T3 で列順先頭が保証済)。
    const row = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    const cells = row.querySelectorAll('td')
    expect(selectTd.className.split(' '), 'select td も align-top').toContain('align-top')
    for (let i = 1; i < cells.length; i++) {
      const td = cells[i] as HTMLElement
      expect(td.className.split(' '), `td[${i}] は align-top を持つ`).toContain('align-top')
      expect(td.className.split(' '), `td[${i}] は text-center を持たない`).not.toContain('text-center')
      expect(td.className.split(' '), `td[${i}] は cursor-pointer を持たない`).not.toContain('cursor-pointer')
    }
  })
})

// ===========================================================================
// B: checkbox セル全域クリックで選択トグル (checkbox 本体以外の余白も当たり判定)
// ===========================================================================

describe('B: checkbox セル全域クリック', () => {
  it('select td (checkbox 外の余白) click で行選択がトグルする', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const checkbox = screen.getByRole('checkbox', { name: /行選択.*Card 1/ })
    const selectTd = checkbox.closest('td') as HTMLElement
    expect(checkbox).not.toBeChecked()

    // td 自身を click (checkbox 本体ではなくセル余白のクリックを模す)。
    fireEvent.click(selectTd)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).toBeChecked()
    })

    // 再度 td click で unchecked (トグル)。
    fireEvent.click(selectTd)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).not.toBeChecked()
    })
  })

  it('checkbox 本体 click は二重発火せず 1 回のトグル (stopPropagation が td onClick を遮断)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const checkbox = screen.getByRole('checkbox', { name: /行選択.*Card 1/ })
    expect(checkbox).not.toBeChecked()

    // checkbox 本体 click。onChange + td onClick が二重発火すると net no-op になるが、
    // stopPropagation で td onClick は発火しないため 1 回のトグル = checked になる。
    fireEvent.click(checkbox)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).toBeChecked()
    })
  })

  it('非 select セル (タイトル列 td) click では選択がトグルしない (hit area は select 列限定)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const checkbox = screen.getByRole('checkbox', { name: /行選択.*Card 1/ })
    expect(checkbox).not.toBeChecked()

    // 行の 2 番目の td (= title 列。cells[0] は select 列) を click。
    const row = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    const titleTd = row.querySelectorAll('td')[1] as HTMLElement
    fireEvent.click(titleTd)

    // onClick が select 列限定のため、非 select セル click では選択が変化しない。
    expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).not.toBeChecked()
  })

  it('全選択 th (checkbox 外の余白) click で全行が選択される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    const headerCheckbox = screen.getByRole('checkbox', { name: '全選択' })
    const selectTh = headerCheckbox.closest('th') as HTMLElement

    // th 余白 click で全選択。
    fireEvent.click(selectTh)
    await waitFor(() => {
      screen.getAllByRole('checkbox', { name: /行選択/ }).forEach((cb) => {
        expect(cb).toBeChecked()
      })
    })
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
        columnPinning={{ left: [], right: [] }}
        onColumnPinningChange={() => {}}
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
        columnPinning={{ left: [], right: [] }}
        onColumnPinningChange={() => {}}
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
        columnPinning={{ left: [], right: [] }}
        onColumnPinningChange={() => {}}
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

// ===========================================================================
// S5-2: column pinning 配線 (brief 完了条件 b / d)
//
// (b-1) menu を持つ 9 列(title/question_label/question/tags/explanation_text/memo/
//        lastCorrect/currentStreak/lastReview)全てに「固定表示」項目が出る。
// (b-2) tags で「固定表示」click → onColumnPinningChange が
//        {left: ['select','title','question_label','question','options','tags'], right: []} を受ける。
// (b-3) boundary=tags 状態で tags menu が「固定を解除」 → click で {left: [], right: []} を受ける。
// (b-4) boundary=tags 状態で title menu が「固定表示」 → click で {left: ['select','title'], right: []} を受ける。
// (d)  boundary null 時 → th に sticky/z-/border-r などの pinning 由来クラスが付かない。
// ===========================================================================

describe('S5-2 (b): column pinning menu 配線 — 9 列に固定項目', () => {
  it('menu を持つ 9 列すべてに「固定表示」項目が描画される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} initialColumnVisibility={{}} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // menu gate を持つ 9 列のラベルと対応するメニューボタン名
    const menuColumns = [
      'タイトル の列メニュー',
      '番号 の列メニュー',
      '問題文 の列メニュー',
      'タグ の列メニュー',
      '解説 の列メニュー',
      'メモ の列メニュー',
      '直近正誤 の列メニュー',
      '連続正解数 の列メニュー',
      '最終回答日時 の列メニュー',
    ]

    for (const menuBtnName of menuColumns) {
      // 他のメニューを閉じてから次を開く
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: menuBtnName }))
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
      // 各列のメニューに「固定表示」が存在する(boundary なし状態 → 全列 isBoundary=false)
      expect(
        screen.getByRole('button', { name: '固定表示' }),
        `${menuBtnName} のメニューに「固定表示」が存在する`,
      ).toBeInTheDocument()
    }
  })
})

describe('S5-2 (b): column pinning menu 配線 — tags 固定・解除・境界縮小', () => {
  it('(b-2) tags で「固定表示」click → onColumnPinningChange が 6 列 left を受ける', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const onPinningChange = vi.fn()

    render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        onColumnPinningChange={onPinningChange}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // tags メニューを開く
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '固定表示' })).toBeInTheDocument())

    // 「固定表示」click
    fireEvent.click(screen.getByRole('button', { name: '固定表示' }))

    // onColumnPinningChange が select~tags の 6 列を受ける
    expect(onPinningChange).toHaveBeenCalledWith({
      left: ['select', 'title', 'question_label', 'question', 'options', 'tags'],
      right: [],
    })
  })

  it('(b-3) boundary=tags 状態で tags menu「固定を解除」click → {left: [], right: []} を受ける', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const onPinningChange = vi.fn()

    render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnPinning={{ left: ['select', 'title', 'question_label', 'question', 'options', 'tags'], right: [] }}
        onColumnPinningChange={onPinningChange}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // tags メニューを開く
    fireEvent.click(screen.getByRole('button', { name: 'タグ の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '固定を解除' })).toBeInTheDocument())

    // 「固定を解除」click
    fireEvent.click(screen.getByRole('button', { name: '固定を解除' }))

    // onColumnPinningChange が全解除 (left=[]) を受ける
    expect(onPinningChange).toHaveBeenCalledWith({ left: [], right: [] })
  })

  it('(b-4) boundary=tags 状態で title menu「固定表示」click → {left: [select,title], right: []} を受ける(境界縮小)', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const onPinningChange = vi.fn()

    render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnPinning={{ left: ['select', 'title', 'question_label', 'question', 'options', 'tags'], right: [] }}
        onColumnPinningChange={onPinningChange}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // title メニューを開く
    fireEvent.click(screen.getByRole('button', { name: 'タイトル の列メニュー' }))
    // boundary=tags ゆえ title は固定済み非境界 → 「固定表示」(境界縮小移動)
    await waitFor(() => expect(screen.getByRole('button', { name: '固定表示' })).toBeInTheDocument())

    // 「固定表示」click
    fireEvent.click(screen.getByRole('button', { name: '固定表示' }))

    // onColumnPinningChange が select〜title の 2 列を受ける(境界縮小)
    expect(onPinningChange).toHaveBeenCalledWith({ left: ['select', 'title'], right: [] })
  })
})

describe('S5-2 (d): boundary null 時 — pinning 由来のクラスが th に付かない', () => {
  it('columnPinning={left:[],right:[]} の状態で th に sticky/z-10/border-r などが付かない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    // デフォルト initialColumnPinning = { left: [], right: [] }
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // 全 th を取得し、S5-3 由来の sticky クラスが存在しないことを確認。
    // (boundary null では追加クラスはゼロが invariant)
    const allTh = Array.from(container.querySelectorAll('thead th'))
    expect(allTh.length).toBeGreaterThan(0)
    for (const th of allTh) {
      expect(th.className, `th[${th.textContent}] に sticky クラスなし`).not.toContain('sticky')
    }
  })
})

// ===========================================================================
// S5-3 (a): boundary=title — sticky 描画 + セパレータ + CSS 変数 emit
//
// select / title が left-pinned → th/td に sticky + left style。
// title が最右可視 pinned → th/td に border-r。
// question (非 pinned) → sticky / left / border-r なし。
// <table> style に --col-select-start=0 / --col-title-start=52(select size=52) が emit される。
// boundary null → start 変数 emit なし + sticky class ゼロ (S5-2 (d) の回帰を兼用)。
// ===========================================================================

describe('S5-3 (a): boundary=title — pinned th に sticky + left style + セパレータ', () => {
  it('select/title th に sticky + left style が付与され、 title に border-r が付き、 question には付かない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    // boundary=title: computePinnedLeft('title') = ['select', 'title']
    const { container } = render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnPinning={{ left: ['select', 'title'], right: [] }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // th 列順(default columnVisibility = { question_label: false }):
    //   allTh[0] = select, allTh[1] = title, allTh[2] = question
    const allTh = container.querySelectorAll('thead th')
    expect(allTh.length).toBeGreaterThan(2)

    const selectTh = allTh[0] as HTMLElement
    const titleTh = allTh[1] as HTMLElement
    const questionTh = allTh[2] as HTMLElement

    // select th: sticky + left CSS 変数参照
    expect(selectTh.className, 'select th に sticky').toContain('sticky')
    expect(selectTh.style.left, 'select th に left CSS 変数参照').toMatch(/calc\(var\(--col-select-start\) \* 1px\)/)

    // title th: sticky + left CSS 変数参照 + border-r (最右 pinned)
    expect(titleTh.className, 'title th に sticky').toContain('sticky')
    expect(titleTh.style.left, 'title th に left CSS 変数参照').toMatch(/calc\(var\(--col-title-start\) \* 1px\)/)
    expect(titleTh.className, 'title th (最右 pinned) に border-r').toContain('border-r')

    // question th: sticky なし・left なし・border-r なし
    expect(questionTh.className, 'question th に sticky なし').not.toContain('sticky')
    expect(questionTh.style.left, 'question th に left なし').toBe('')
    expect(questionTh.className, 'question th に border-r なし').not.toContain('border-r')
  })

  it('<table> style に --col-select-start=0 / --col-title-start=52 が emit される', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnPinning={{ left: ['select', 'title'], right: [] }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    const tableEl = container.querySelector('table') as HTMLElement

    // --col-select-start: select は最初の pinned 列なので offset=0
    const selectStart = tableEl.style.getPropertyValue('--col-select-start')
    expect(selectStart, '--col-select-start が emit されている').not.toBe('')
    expect(parseFloat(selectStart), '--col-select-start = 0 (select が先頭 pinned)').toBe(0)

    // --col-title-start: title は select (size=52) の直後 → offset=52
    const titleStart = tableEl.style.getPropertyValue('--col-title-start')
    expect(titleStart, '--col-title-start が emit されている').not.toBe('')
    expect(parseFloat(titleStart), '--col-title-start = 52 (select size 分 offset)').toBe(52)
  })

  it('boundary null → --col-select-start / --col-title-start が emit されず、th に sticky がない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    // デフォルト initialColumnPinning = { left: [], right: [] }
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    const tableEl = container.querySelector('table') as HTMLElement
    expect(tableEl.style.getPropertyValue('--col-select-start'), '--col-select-start が emit されない').toBe('')
    expect(tableEl.style.getPropertyValue('--col-title-start'), '--col-title-start が emit されない').toBe('')

    const allTh = container.querySelectorAll('thead th')
    for (const th of allTh) {
      expect((th as HTMLElement).className, 'th に sticky なし (boundary null)').not.toContain('sticky')
    }
  })
})

// ===========================================================================
// S5-3 (b): hidden boundary → separator が最右可視 pinned 列へ移動
//
// boundary=question_label で question_label が hidden の場合:
//   - visible pinned: select, title (question_label は hidden で getHeaderGroups から除外)
//   - title が最右可視 pinned → border-r
//   - question_label の start var は emit されない (visible ではないため)
// ===========================================================================

describe('S5-3 (b): hidden boundary → separator が title (最右可視 pinned) へ移動', () => {
  it('boundary=question_label / question_label hidden → title th に border-r が付き、 --col-question_label-start は emit されない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    // boundary=question_label で question_label を hidden にする
    const { container } = render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnPinning={{ left: ['select', 'title', 'question_label'], right: [] }}
        initialColumnVisibility={{ question_label: false }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    const allTh = container.querySelectorAll('thead th')
    // question_label hidden → th order: select(0), title(1), question(2)
    const selectTh = allTh[0] as HTMLElement
    const titleTh = allTh[1] as HTMLElement

    // select: sticky + left, border-r なし (最右でない)
    expect(selectTh.className, 'select th に sticky').toContain('sticky')
    expect(selectTh.className, 'select th に border-r なし').not.toContain('border-r')

    // title: sticky + left + border-r (hidden question_label を飛ばして最右可視 pinned)
    expect(titleTh.className, 'title th に sticky').toContain('sticky')
    expect(titleTh.className, 'title th (最右可視 pinned) に border-r').toContain('border-r')

    // <table> に --col-question_label-start が emit されない (question_label は visible ではないため)
    const tableEl = container.querySelector('table') as HTMLElement
    expect(
      tableEl.style.getPropertyValue('--col-question_label-start'),
      '--col-question_label-start は emit されない (hidden column)',
    ).toBe('')

    // select/title の start vars は emit されている
    expect(tableEl.style.getPropertyValue('--col-select-start'), '--col-select-start は emit される').not.toBe('')
    expect(tableEl.style.getPropertyValue('--col-title-start'), '--col-title-start は emit される').not.toBe('')
  })
})

// ===========================================================================
// S5-3 (c): hover — pinned td の不透過 + group class
//
// pinned td に bg-background + group-hover class が付く。
// <tr> に group が付く(unconditional — pinning なし時も inert として付与)。
// ===========================================================================

// ===========================================================================
// T3: side peek 統合テスト ①〜⑩
//
// ExamCardSidePeek は radix Dialog non-modal で Portal 描画。
// open 時: getByRole('dialog') = DialogContent / getByRole('heading') = DialogTitle(sr-only h2)。
// '閉じる' button は ExamCardSidePeek 専用(列メニュー popover との区別に使う)。
//
// row-ux §2 / §5: 起動導線は「グリップ click → menu の『開く』click」の 2 click に変わった
// (旧「カードを開く」常設 button は撤去)。 期待挙動 (open/close/toggle/切替/prune) は不変。
// ===========================================================================

/** 行のグリップ (menu trigger)。 focus-steal 等で要素自体が要る場合に使う。 */
function rowGrip(rowTestId: string): HTMLElement {
  return within(screen.getByTestId(rowTestId)).getByRole('button', { name: /^行の操作:/ })
}

/**
 * 行の side peek を起動する (グリップ → menu の詳細トグル項目)。 UI fix B: 項目の
 * accessible name は開閉状態で「詳細を開く」/「詳細を閉じる」に切り替わるため、
 * どちらの状態でも引けるよう正規表現で引く (呼出側は open/close どちらの意図でも使う)。
 */
async function clickOpenCard(rowTestId: string) {
  fireEvent.click(rowGrip(rowTestId))
  fireEvent.click(await screen.findByRole('button', { name: /^詳細を(開く|閉じる)$/ }))
}

describe('T3 ①: title トリガー click で peek に該当 card 内容表示', () => {
  it('行のグリップ menu「開く」をクリックすると peek が開き card タイトルが表示される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 の select セルのグリップ → menu の「開く」
    await clickOpenCard('row-card-1')

    // ExamCardSidePeek が開き Dialog.Title (sr-only h2) に card タイトルが表示される
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument()
    })
  })
})

describe('T3 ②: 同一行 再 click で close(toggle)', () => {
  it('同一トリガーを再 click すると peek が閉じる', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // 1 回目: open
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument())

    // 2 回目: close (toggle — openCard は同一 id で閉じる契約)
    await clickOpenCard('row-card-1')
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Card 1' })).not.toBeInTheDocument()
    })
  })
})

describe('T3 ③: 別行 click で card 切替', () => {
  it('別の行のトリガーを click すると peek が card-2 に切り替わる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument())

    // card-2 のグリップ menu から開く
    await clickOpenCard('row-card-2')

    // peek が Card 2 に切り替わる
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 2' })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Card 1' })).not.toBeInTheDocument()
  })
})

describe('T3 ④: × で close', () => {
  it('「閉じる」ボタンをクリックすると peek が閉じる', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument())

    // × ボタンで閉じる
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '閉じる' })).not.toBeInTheDocument()
    })
  })
})

describe('T3 ⑤: data から該当 card 消滅で自動 close', () => {
  it('開いているカードが DB から削除されると peek が自動 close する(prune effect)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 の peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument())

    // card-1 を DB から削除(削除相当の useLiveQuery 再評価トリガー)
    await db.cards.delete('card-1')

    // prune effect が発火して peek が閉じる
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '閉じる' })).not.toBeInTheDocument()
    })
  })
})

describe('T3 ⑥: columnFilters で該当行が非表示になっても peek が開いたまま', () => {
  it('タイトルフィルタで card-1 が非表示になっても peek は閉じない(spec §3.6: data 全件参照)', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 の peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument())

    // タイトル列メニューを開いて "Card 2" フィルタを適用(card-1 を非表示に)
    fireEvent.click(screen.getByRole('button', { name: 'タイトル の列メニュー' }))
    const filterInput = await screen.findByLabelText('タイトル フィルタ値')
    fireEvent.change(filterInput, { target: { value: 'Card 2' } })

    // card-1 行はテーブルから消える
    await waitFor(() => expect(screen.queryByTestId('row-card-1')).not.toBeInTheDocument())

    // だが peek は開いたまま('閉じる' は ExamCardSidePeek のみが持つ)
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument()
  })
})

describe('T3 ⑦: rowSelection 操作が activeCardId に影響しない(直交)', () => {
  it('checkbox による行選択・解除は peek の open/close に影響しない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument())

    // 行選択 → peek は開いたまま
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).toBeChecked())
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument()

    // 行選択解除 → peek は開いたまま
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).not.toBeChecked())
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument()
  })
})

describe('T3 ⑦-b: peek 起動 2 click が行選択チェックボックスをトグルしない(逆方向・stopPropagation)', () => {
  it('グリップ click と menu 詳細トグル click のどちらも select td の onClick(行選択トグル)へ bubbling しない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    const checkbox = screen.getByRole('checkbox', { name: /行選択.*Card 1/ }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    // 伝播遮断は 2 箇所に分かれている (grip の onClick と menu 項目の onClick — menu は
    // portal でも React tree では select td の子)。 片方だけ pin すると保証が半分になるため
    // 2 click それぞれの直後に checkbox を見る。
    fireEvent.click(rowGrip('row-card-1'))
    await screen.findByTestId('exam-card-row-menu')
    expect(checkbox.checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '詳細を開く' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument())

    expect(checkbox.checked).toBe(false)
  })
})

describe('T3 ⑧: data の該当 card 更新が peek 表示に反映(live 追従)', () => {
  it('DB の card タイトルを更新すると peek の Dialog.Title が追従する', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))

    // card-1 の peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument())

    // DB のカードタイトルを更新
    await db.cards.update('card-1', { title: 'Updated Card 1', updated_at: new Date().toISOString() })

    // peek の Dialog.Title(sr-only h2) が追従する
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Updated Card 1' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('heading', { name: 'Card 1' })).not.toBeInTheDocument()
  })
})

describe('T3 ⑨: peek open 中に背面テーブルセル click → peek は開いたままかつセル inline 編集が起動', () => {
  it('onInteractOutside preventDefault により peek は閉じず、テーブルのセル click-to-edit が起動する', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 の peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument())

    // card-2 の title セル(display mode ボタン)を取得
    const row2 = screen.getByTestId('row-card-2')
    const editButton = within(row2).getByRole('button', { name: 'タイトル 編集' })

    // Radix DismissableLayer は pointerdown で onInteractOutside を発火させる(click ではない)。
    // pointerDown を先に送ることで onInteractOutside→preventDefault が実際に実行され、
    // テストが「preventDefault を外すと閉じる」ことを実証する本物のアサーションになる。
    fireEvent.pointerDown(editButton)

    // (a) onInteractOutside の preventDefault が peek を開いたまま保つ。
    // preventDefault を exam-card-side-peek.tsx から削除するとここで失敗する。
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument()

    // click でセルの click-to-edit(InlineTextField startEdit)を起動
    fireEvent.click(editButton)

    // (b) card-2 の title セルが edit mode に切替(textbox が出現)
    await waitFor(() => {
      expect(within(row2).getByRole('textbox')).toBeInTheDocument()
    })
  })
})

describe('T3 ⑩: card 切替時の option 編集 commit 保証', () => {
  it('option cell 編集中に別行トリガーをクリックすると focus-steal で blur→commit が走り、その後 card が切り替わる', async () => {
    const db = getClientDb()
    // card-1 に選択肢を 1 件持たせる
    const card1 = {
      ...makeCard(1),
      options: [{ id: 'A', text: 'OptionA', is_correct: false }],
    }
    await db.cards.put(card1)
    await db.cards.put(makeCard(2))
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 の peek を開く
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument())

    // peek 内の option 本文セル(display mode)をクリックして edit mode に切替
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '選択肢 本文 編集' }))

    // edit mode の textarea が出現するのを待つ
    // within(dialog) でスコープ: テーブルの options 列にも同 aria-label が存在するため
    // screen 全体で findByLabelText すると "multiple elements" エラーになる
    const optionInput = await within(dialog).findByLabelText('選択肢 本文 編集')
    expect(optionInput).toBeInTheDocument()

    // 値を変更
    fireEvent.change(optionInput, { target: { value: 'OptionA Modified' } })

    // card-2 のグリップを focus することで focus-steal → optionInput が blur → commit
    const card2Grip = rowGrip('row-card-2')
    act(() => { card2Grip.focus() })

    // blur → handleCellSave → db.cards.update が走り DB に値が保存される
    await waitFor(async () => {
      const updatedCard = await db.cards.get('card-1')
      expect(updatedCard?.options?.[0]?.text).toBe('OptionA Modified')
    })

    // card-2 のグリップ menu から開く → card 切替
    await clickOpenCard('row-card-2')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 2' })).toBeInTheDocument())
  })
})

// UI fix B: meta.activeCardId (再導入) が行ごとの「開く」項目の aria-label/aria-pressed に
// 正しく届いていることを end-to-end で pin する (columns.test.tsx の単体 wiring test だけでは
// exam-card-table.tsx の meta 配線漏れを検出できない)。
describe('UI fix B: 行メニュー「開く」項目が meta.activeCardId 配線で行ごとの開閉状態を表す', () => {
  it('peek を開いた行は「詳細を閉じる」+ aria-pressed=true、他行は「詳細を開く」+ aria-pressed=false のまま', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // card-1 の peek を開く (openCard 経由で activeCardId = card-1 になる)。
    await clickOpenCard('row-card-1')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Card 1' })).toBeInTheDocument())

    // card-1 の行メニューを再度開き、詳細トグル項目が開状態を表すことを見る。
    fireEvent.click(rowGrip('row-card-1'))
    const item1 = await screen.findByRole('button', { name: '詳細を閉じる' })
    expect(item1).toHaveAttribute('aria-pressed', 'true')

    // card-2 は開いていないので閉状態のまま。
    fireEvent.click(rowGrip('row-card-2'))
    const item2 = await screen.findByRole('button', { name: '詳細を開く' })
    expect(item2).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('S5-3 (c): hover — pinned td の bg-background + group-hover + tr group', () => {
  it('boundary=title → tr に group / pinned td に bg-background + group-hover class、 非 pinned td にはなし', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    const { container } = render(
      <ControlledExamCardTable
        examId={EXAM_ID}
        userId={USER_ID}
        initialColumnPinning={{ left: ['select', 'title'], right: [] }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // data 行 tr の group class を確認
    const dataRow = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    expect(dataRow.className, 'data tr に group').toContain('group')

    // td: question_label hidden → select(0), title(1), question(2)
    const cells = dataRow.querySelectorAll('td')
    const selectTd = cells[0] as HTMLElement
    const titleTd = cells[1] as HTMLElement
    const questionTd = cells[2] as HTMLElement

    // select td: sticky + bg-background + group-hover class
    expect(selectTd.className, 'select td に sticky').toContain('sticky')
    expect(selectTd.className, 'select td に bg-background').toContain('bg-background')
    expect(selectTd.className, 'select td に group-hover class').toContain('group-hover:')

    // title td: sticky + bg-background + group-hover class
    expect(titleTd.className, 'title td に sticky').toContain('sticky')
    expect(titleTd.className, 'title td に bg-background').toContain('bg-background')
    expect(titleTd.className, 'title td に group-hover class').toContain('group-hover:')

    // question td: sticky なし・bg-background なし・group-hover なし
    expect(questionTd.className, 'question td に sticky なし').not.toContain('sticky')
    expect(questionTd.className, 'question td に bg-background なし').not.toContain('bg-background')
    expect(questionTd.className, 'question td に group-hover なし').not.toContain('group-hover:')
  })

  it('boundary null → tr に group が付く(unconditional)が、 td に sticky / bg-background / group-hover は付かない', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard(1))
    // デフォルト: no pinning
    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getByTestId('row-card-1')).toBeInTheDocument())

    // data 行 tr には unconditional の group が付く(inert — group-hover 子なし)
    const dataRow = container.querySelector('[data-testid="row-card-1"]') as HTMLElement
    expect(dataRow.className, 'data tr に group (unconditional)').toContain('group')

    // 全 td に sticky / bg-background / group-hover は付かない
    const cells = dataRow.querySelectorAll('td')
    for (const td of cells) {
      expect((td as HTMLElement).className, 'td に sticky なし (boundary null)').not.toContain('sticky')
      expect((td as HTMLElement).className, 'td に bg-background なし (boundary null)').not.toContain('bg-background')
      expect((td as HTMLElement).className, 'td に group-hover なし (boundary null)').not.toContain('group-hover:')
    }
  })
})

// ===========================================================================
// P3 Task0 ①: selection prune 不変条件 (HS-2) — selection ⊆ 可視集合
//
// impl: exam-card-table.tsx:490-516 の prune effect。 visibleIds =
//   getFilteredRowModel().rows.map(r=>r.id) の集合に rowSelection を絞り込む。
// 移設 (P3 後続 task) 前に「filter で隠れた行 / Dexie 削除で消えた行は selection から
// 落ちる」不変条件を pin する。 assert は action-bar-count (= 選択件数、 selectedIds.length)
// と可視行の checked 状態で行い、 selection ⊆ 可視 を担保する。
// ===========================================================================

describe('P3 Task0 ①: selection prune (HS-2) — selection ⊆ 可視集合', () => {
  it('(a) 列 filter で選択行が隠れると、 その行 id が selection から落ちる', async () => {
    const db = getClientDb()
    // question_text を distinct 化し、 片方だけに match する filter を掛けられるようにする。
    await db.cards.bulkPut([
      { ...makeCard(1), question_text: 'Alpha only' },
      { ...makeCard(2), question_text: 'Beta only' },
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    // 2 行とも選択 → action bar が 2件選択中
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 2/ }))
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // 問題文 列メニューから 'Alpha' で絞り込む (card-2 が非可視になる)。
    fireEvent.click(screen.getByRole('button', { name: '問題文 の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('問題文 フィルタ値'), {
      target: { value: 'Alpha' },
    })

    // 可視行は card-1 のみ + selection は card-1 のみに prune される (2 → 1)。
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('1件選択中')
    })
    // 残った可視行 (card-1) は checked のまま (selection ⊆ 可視 の等号側)。
    expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).toBeChecked()
  })

  it('(b) 選択行を Dexie から削除すると、 その行 id が selection から落ちる', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 2/ }))
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('2件選択中'),
    )

    // card-2 を mirror から削除 → useLiveQuery で行が消える → prune で selection から除外。
    await act(async () => {
      await db.cards.delete('card-2')
    })

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
      expect(screen.getByTestId('action-bar-count')).toHaveTextContent('1件選択中')
    })
    // 残存 card-1 は checked のまま (selection ⊆ 可視)。
    expect(screen.getByRole('checkbox', { name: /行選択.*Card 1/ })).toBeChecked()
  })
})

// ===========================================================================
// owner-scope pin (Sprint B): 別 user の card 行は描画されない
//
// なぜ必要か: exam-card-table-columns.tsx の cell は編集対象 mirror 行の `card.user_id` を
// outbox 行の owner / flush の owner-scope 選別に使う。 これが「認証主体と一致する」 と
// 言えるのは、 本 component の live query が `.filter((c) => c.user_id === userId)` で
// 他 user の行を落としているからに他ならない。 その前提は別 file にあり、 filter を外しても
// 何も落ちない状態だったので、 ここで pin する (共有ブラウザで前 user の cards 行が残った
// 状況を模し、 描画されないことを assert する)。
// ===========================================================================

describe('ExamCardTable owner-scope: 別 user の card 行を描画しない', () => {
  it('同 exam に別 user の card が mirror に残っていても行として現れない', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      makeCard(1),
      // 共有ブラウザに残った別 user の行 (sign-out で Dexie を purge しないため起こりうる)。
      { ...makeCard(2), id: 'card-foreign', user_id: 'other-user', title: 'Foreign Card' },
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1)
    })
    expect(screen.queryByTestId('row-card-foreign')).not.toBeInTheDocument()
    expect(screen.queryByText('Foreign Card')).not.toBeInTheDocument()
    // 描画された唯一の行は認証主体のもの = cell が読む card.user_id は必ず USER_ID。
    expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
  })
})

// ===========================================================================
// row-ux Task 5: footer「+ カードを追加」table 統合 (親 gate 算出の配線 pin)。
// footer 本体の gating 3 条件 (dataReady / positionLocked / movePending) の詳細な
// 出し分けロジックは exam-card-table-add-footer.test.tsx が prop 直渡しで pin する。
// ここでは「親 (ExamCardTable) が実際にその gate を正しく算出して配線しているか」のみを
// 実 liveData / 実 sort state で検証する。
// ===========================================================================

describe('row-ux Task 5: footer 「+ カードを追加」table 統合', () => {
  it('(a) liveData 解決前 (useLiveQuery undefined) の実 render で footer button が disabled', async () => {
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // render() は同期呼出。 useLiveQuery の querier (Dexie 非同期 query) はまだ 1 tick も
    // 進んでいないため、 この時点で liveData は必ず undefined = dataReady gate が効いている。
    const addButton = screen.getByRole('button', { name: '＋ カードを追加' })
    expect(addButton, 'liveData 未解決の実 render 直後は dataReady=false で disabled').toBeDisabled()

    // 後始末: liveData 解決 (0 件 → dataReady=true) まで進め、 pending promise を残さない。
    await waitFor(() => expect(addButton).toBeEnabled())
  })

  it('(b) sort 適用 (header menu 経由) で footer disabled、 解除で enabled', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2))

    const addButton = screen.getByRole('button', { name: '＋ カードを追加' })
    expect(addButton, 'sort 適用前は enabled').toBeEnabled()

    // 列メニューから昇順ソートを適用 (sorting.length > 0 → positionLocked)。
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))

    await waitFor(() =>
      expect(addButton, 'sort 適用中は positionLocked で disabled').toBeDisabled(),
    )
    expect(addButton).toHaveAttribute('title', ADD_CARD_LOCKED_REASON)

    // condition bar の sort chip から解除。
    fireEvent.click(screen.getByRole('button', { name: 'ソート解除: タイトル' }))

    await waitFor(() =>
      expect(addButton, 'sort 解除後は positionLocked が外れ enabled に戻る').toBeEnabled(),
    )
  })

  it('(c) column filter 適用中でも footer へ渡る baseOrders/count は基準順全件 (getRowModel().rows の部分集合ではない・kickoff決定8)', async () => {
    const db = getClientDb()
    // base_order を distinct にした 3 件 (makeCard 既定は全件 base_order=1024 で固定のため上書き)。
    await db.cards.bulkPut([
      { ...makeCard(1), base_order: 1024 },
      { ...makeCard(2), base_order: 2048 },
      { ...makeCard(3), base_order: 3072 },
    ])

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    // click 起点では positionLocked で button が disabled になり検証できない (report 参照) ため、
    // 「フィルタで getRowModel().rows が data の真部分集合になる状態」を作った上で
    // capture wrapper 経由で親から渡る props を直接検証する。
    fireEvent.click(screen.getByRole('button', { name: 'タイトル の列メニュー' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('タイトル フィルタ値'), {
      target: { value: 'Card 1' },
    })
    // 'Card 1' は 'Card 1' のみに部分一致 ('Card 2'/'Card 3' は含まない) → getRowModel().rows は
    // data (3件) の真部分集合 (1件) になる。
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // red 検証対象 (task-5-report.md 追記分): exam-card-table.tsx の footerBaseOrders / count の
    // 算出元を data (基準順全件) から table.getRowModel().rows (filter 後) に差し替えると、
    // ここで [1024]/count=1 になり fail する。 kickoff 決定 8 の「getRowModel().rows 禁止」の
    // 実効的 pin。
    expect(capturedFooterPropsRef.current?.baseOrders, '基準順全件 (フィルタ非依存)').toEqual([
      1024, 2048, 3072,
    ])
    expect(capturedFooterPropsRef.current?.count, '全件数 (フィルタ後の可視 1 件ではない)').toBe(3)
  })
})
