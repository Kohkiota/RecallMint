// @vitest-environment jsdom
// Fix-3 T1.1: remount リーク根治の回帰テスト
//
// T1: resize ドラッグ 1 サイクルで InlineTextField の mount/unmount 増分が 0
//     (型 swap 実装なら全 cell × 2 の churn が発生することを非 vacuous 性根拠として report に記述)
// T2: isResizing=true 中の連続 mouseMove で InlineTextField の render 増分が 0 (memo 凍結維持)
// T3: 非 resize 時に Dexie の cards を更新 → mocked InlineTextField の表示値が追従する
//     (comparator に data===data を混ぜると useReactTable の mutated instance で常に true →
//      永久 skip → 本テストが fail する形で落とし穴を検出する)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { getClientDb, type ClientCard } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// Hoisted counters — referenced inside vi.mock factories (factories are
// hoisted by vitest transform to run before module imports, so the counters
// must be created via vi.hoisted to be available in factory scope).
// ---------------------------------------------------------------------------

const ctrs = vi.hoisted(() => ({
  mount: 0,
  unmount: 0,
  render: 0,
}))

// ---------------------------------------------------------------------------
// Mocks required for ExamCardTable to render (same as exam-card-table.test.tsx)
// ---------------------------------------------------------------------------

const { mockCreateOption, mockBulkTag } = vi.hoisted(() => ({
  mockCreateOption: vi.fn(async () => 'new-opt-remount'),
  mockBulkTag: vi.fn(async () => ({
    ok: true,
    succeeded: [] as string[],
    failed: [] as string[],
  })),
}))

vi.mock('@/lib/tags/tag-crud', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tags/tag-crud')>()
  return { ...actual, createOption: mockCreateOption }
})

vi.mock('../_hooks/use-bulk-card-tags', async (importActual) => {
  const actual = await importActual<typeof import('../_hooks/use-bulk-card-tags')>()
  return { ...actual, useBulkCardTags: () => mockBulkTag }
})

// ---------------------------------------------------------------------------
// InlineTextField mock — instruments mounts, unmounts, renders.
// This mock is isolated to this file and does NOT affect exam-card-table.test.tsx
// which tests the real InlineTextField (role="button" assertions etc.).
// ---------------------------------------------------------------------------

vi.mock('./inline-text-field', async () => {
  const React = await import('react')

  function MockInlineTextField(props: {
    cardId: string
    field: string
    initialValue: string | null
    [k: string]: unknown
  }) {
    // Count every render call (including initial mount and re-renders)
    ctrs.render++

    // Count mount / unmount lifecycle events
    React.useEffect(() => {
      ctrs.mount++
      return () => {
        ctrs.unmount++
      }
    }, [])

    return React.createElement('span', {
      'data-testid': 'mocked-itf',
      'data-card-id': props.cardId,
      'data-field': props.field,
      'data-value': props.initialValue ?? '',
    })
  }
  MockInlineTextField.displayName = 'MockInlineTextField'

  return { InlineTextField: MockInlineTextField }
})

import { ControlledExamCardTable } from './exam-card-table-test-harness'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXAM_ID = 'remount-exam'
const USER_ID = 'remount-user'

function makeCard(n: number): ClientCard {
  return {
    id: `card-${n}`,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    title: `Card ${n}`,
    sort_key: String(n).padStart(4, '0'),
    question_text: `Question ${n}`,
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
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Reset all counters before each test
  ctrs.mount = 0
  ctrs.unmount = 0
  ctrs.render = 0

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
// T1: resize ドラッグ 1 サイクルで InlineTextField の mount/unmount 増分が 0
//
// Non-vacuous 確認:
//   - 初期レンダーで ctrs.mount > 0 を assert することで "カウンターが機能している"
//     ことを証明し、後続の delta===0 がテストの空振りでないことを示す。
//   - 旧実装 (型 swap: resize 中は <MemoizedTableBody>、非 resize 時は <TableBody>) では
//     isResizingColumn が変化するたびに React が "型変化" を検出して tbody subtree を
//     tear-down → remount する。5 行 × ~6 cells × InlineTextField per cell =
//     N * cells_per_row 回の mount/unmount が発生し、このテストは fail する。
//   - 修正後: 常に同じ型 <MemoizedTableBody> を render するため型変化 tear-down が
//     発生せず、delta = 0 で pass する。
// ===========================================================================

describe('Fix-3 T1.1 — T1: resize ドラッグ 1 サイクルで InlineTextField remount 0', () => {
  it('mount/unmount 増分が 0 (型 swap なら全 cell×2 churn が発生する形)', async () => {
    const N = 5
    const db = getClientDb()
    await db.cards.bulkPut(Array.from({ length: N }, (_, i) => makeCard(i + 1)))

    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // Wait for initial render to settle
    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(N)
    })

    // Non-vacuous guard: initial render caused mounts — proves the counter works.
    // If ctrs.mount === 0 here, the mock is broken and the later delta===0 would be vacuous.
    expect(ctrs.mount, '初期 mount が 0 は counter が壊れている').toBeGreaterThan(0)

    // Record state after initial render settles
    const mountBefore = ctrs.mount
    const unmountBefore = ctrs.unmount

    // Simulate one full resize drag cycle:
    //   false → true (mouseDown) → multiple moves → false (mouseUp)
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    expect(handle, 'resize handle が存在する').not.toBeNull()

    // mouseDown: starts resize, isResizingColumn → truthy → ExamCardTable re-renders
    fireEvent.mouseDown(handle, { clientX: 200 })
    // mouseMoves: TanStack's document-level listener updates columnSizingInfo.deltaOffset
    fireEvent.mouseMove(document, { clientX: 210 })
    fireEvent.mouseMove(document, { clientX: 215 })
    fireEvent.mouseMove(document, { clientX: 220 })
    // mouseUp: isResizingColumn → false → ExamCardTable re-renders again
    fireEvent.mouseUp(document, { clientX: 220 })

    // Let React flush all pending state updates and effects
    await act(async () => {})

    // Core assertion: no mount/unmount churn from the resize cycle.
    // Under old type-swap code this would be > 0 (all cells unmounted and remounted).
    expect(ctrs.mount - mountBefore, 'resize cycle で mount 増分 0').toBe(0)
    expect(ctrs.unmount - unmountBefore, 'resize cycle で unmount 増分 0').toBe(0)
  })
})

// ===========================================================================
// T2: isResizing=true 中の連続 mouseMove で InlineTextField の render 増分が 0
//
// memo 凍結維持の確認: comparator (_prev, next) => next.isResizing が true を返す間は
// TableBody が再レンダーされず、内部の InlineTextField も呼び出されない。
// ===========================================================================

describe('Fix-3 T1.1 — T2: isResizing=true 中の mouseMoves で cell 再レンダー 0', () => {
  it('mouseDown 後の連続 mouseMove で InlineTextField.render 増分が 0', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([makeCard(1), makeCard(2)])

    const { container } = render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    await waitFor(() => {
      expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(2)
    })

    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    expect(handle, 'resize handle が存在する').not.toBeNull()

    // Start resize: isResizingColumn becomes truthy, ExamCardTable re-renders,
    // memo comparator returns true → TableBody is frozen (not re-rendered)
    fireEvent.mouseDown(handle, { clientX: 200 })
    await act(async () => {})

    // Record render count AFTER mouseDown's React flush.
    // Subsequent mouseMoves must not cause TableBody (and InlineTextField) to re-render.
    const renderAfterMouseDown = ctrs.render

    // Multiple mouseMoves: each triggers ExamCardTable re-render via TanStack's
    // document.addEventListener('mousemove', ...) listener, but memo (isResizing=true)
    // should prevent TableBody from re-rendering → InlineTextField render count stays fixed.
    fireEvent.mouseMove(document, { clientX: 210 })
    fireEvent.mouseMove(document, { clientX: 215 })
    fireEvent.mouseMove(document, { clientX: 220 })
    await act(async () => {})

    expect(
      ctrs.render - renderAfterMouseDown,
      'isResizing=true 中の mouseMove で InlineTextField 再レンダー 0',
    ).toBe(0)

    // Cleanup: end resize
    fireEvent.mouseUp(document, { clientX: 220 })
    await act(async () => {})
  })
})

// ===========================================================================
// T3: 非 resize 時に Dexie の cards を更新 → cells が追従再描画される
//
// comparator (_prev, next) => next.isResizing は isResizing=false (通常時) に false を
// 返すため memo は re-render を許可する。もし comparator に
// prev.table.options.data === next.table.options.data を混ぜると、
// useReactTable が同一 mutated instance を返すため常に true → 永久 skip → この test が fail する。
// ===========================================================================

describe('Fix-3 T1.1 — T3: 非 resize 時の Dexie 更新が cells に追従再描画される', () => {
  it('card title 更新 → mocked InlineTextField の data-value が新 title に追従する', async () => {
    const db = getClientDb()
    const card = makeCard(1)
    await db.cards.put(card)

    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByTestId('row-card-1')).toBeInTheDocument()
    })

    // Helper: find the mocked InlineTextField for the title field of card 1
    const getTitleField = () =>
      Array.from(screen.queryAllByTestId('mocked-itf')).find(
        (el) =>
          el.getAttribute('data-field') === 'title' &&
          el.getAttribute('data-card-id') === card.id,
      ) ?? null

    // Verify initial title is rendered
    expect(getTitleField()?.getAttribute('data-value'), '初期 title が Card 1').toBe('Card 1')

    // Update card title in Dexie → triggers useLiveQuery → ExamCardTable re-renders
    await db.cards.update(card.id, { title: 'Updated Title' })

    // If the comparator wrongly uses data===data (always true → memo skips),
    // the cells would NOT re-render and this assertion would timeout.
    // With the correct comparator (_prev, next) => next.isResizing (= false when not resizing),
    // memo allows re-render → InlineTextField receives new initialValue → data-value updates.
    await waitFor(() => {
      expect(
        getTitleField()?.getAttribute('data-value'),
        'title 更新が mocked InlineTextField の data-value に追従する',
      ).toBe('Updated Title')
    })
  })
})
