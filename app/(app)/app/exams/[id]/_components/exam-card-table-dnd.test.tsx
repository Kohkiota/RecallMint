// @vitest-environment jsdom
// exam-card-table-dnd — row DnD (dnd-kit) の table 配線 test (row-dnd sprint task-4 /
// spec §3.1/§3.5/§4/§5)。
//
// mock 構成は exam-card-table-move.test.tsx を踏襲する: useMoveCards は spy mock、
// mirror (exams/cards) は fake-indexeddb の実 read、render は ControlledExamCardTable。
// create-exam / runGuardedPull / wait-for-exam-mirror は本 test が触れる経路
// (切り出し) に無関係なので exam-card-table.test.tsx と同じく mock しない。
//
// @dnd-kit/core は partial mock 2 段 (importOriginal spread):
//   - DndContext: props を capture しつつ実 DndContext を内側に保持する wrapper。
//     children passthrough stub だと SortableRow 内の useSortable が実 context を
//     失い、handle の attributes/listeners が偽物になる (Codex 抜け 4)。
//   - DragOverlay: children passthrough stub。 捕捉した onDragStart を直接発火しても
//     実 DndContext 内部の active state は更新されないため、実 DragOverlay は
//     children を描画しない — overlay の「中身の描画契約」(activeDragCard ?
//     preview : null) を pin するのが目的なので、overlay 自身の表示機構は stub 化し
//     実挙動は smoke へ委譲する (2026-08-15 OT 承認)。
//
// 捕捉した onDragStart/onDragEnd/onDragCancel を合成 event `{ active: { id }, over:
// { id } | null }` で手動発火する (spec §8-4 の 13 ケース)。

import * as React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import type { DndContextProps, DragStartEvent, DragEndEvent, DragCancelEvent } from '@dnd-kit/core'

type CapturedDndProps = {
  onDragStart?: DndContextProps['onDragStart']
  onDragEnd?: DndContextProps['onDragEnd']
  onDragCancel?: DndContextProps['onDragCancel']
}

const { mockMoveCards, mockUndoMove, capturedRef } = vi.hoisted(() => ({
  mockMoveCards: vi.fn(),
  mockUndoMove: vi.fn(),
  capturedRef: { current: null as null | CapturedDndProps },
}))

vi.mock('../../_hooks/use-move-cards', () => ({
  useMoveCards: () => ({ moveCards: mockMoveCards, undoMove: mockUndoMove }),
}))

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    // capture wrapper: props を capturedRef へ保存しつつ実 DndContext をそのまま描画する。
    DndContext: (props: DndContextProps) => {
      capturedRef.current = {
        onDragStart: props.onDragStart,
        onDragEnd: props.onDragEnd,
        onDragCancel: props.onDragCancel,
      }
      return React.createElement(actual.DndContext, props)
    },
    // children passthrough stub (実 active state と乖離するため — file 冒頭コメント参照)。
    DragOverlay: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children ?? null),
  }
})

// card-editor-fields → card-image-gallery が '../_actions/asset-actions' (server action)
// を transitive import するため最小 stub (exam-card-table-move.test.tsx と同じ理由)。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { ControlledExamCardTable } from './exam-card-table-test-harness'
import { ROW_DND_LOCKED_REASON } from './exam-card-row-dnd'

const USER_ID = 'user-dnd-table'
const EXAM_ID = 'exam-dnd-table'

const MOVE_OK = {
  ok: true as const,
  movedCount: 1,
  originals: [{ id: 'card-1', exam_id: EXAM_ID, base_order: 1024 }],
  sourceExamId: EXAM_ID,
}

function makeExam(id: string, name: string, updatedAt: string): ClientExam {
  return {
    id,
    user_id: USER_ID,
    name,
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: updatedAt,
  }
}

function makeCard(n: number): ClientCard {
  return {
    id: `card-${n}`,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    source_document_id: null,
    title: `Card ${n}`,
    question_label: String(n).padStart(4, '0'),
    base_order: n * 1024,
    question_text: `Question ${n}`,
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-08-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    sync_status: 'synced',
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  capturedRef.current = null
  mockMoveCards.mockResolvedValue(MOVE_OK)
  mockUndoMove.mockResolvedValue({ ok: true })

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.card_tags.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.exams.put(makeExam(EXAM_ID, '現在の試験', '2026-08-10T00:00:00.000Z'))
})

afterEach(() => cleanup())

/** rows 枚のカードを mirror へ投入して render し、行が揃うまで待つ。 */
async function renderTable(rows: number) {
  const db = getClientDb()
  await db.cards.bulkPut(Array.from({ length: rows }, (_, i) => makeCard(i + 1)))
  render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
  await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(rows))
}

/** 直近の render で capture された DndContext の 3 handler。 */
function captured(): Required<CapturedDndProps> {
  const c = capturedRef.current
  if (!c?.onDragStart || !c.onDragEnd || !c.onDragCancel) {
    throw new Error('DndContext props not captured yet (render before calling captured())')
  }
  return c as Required<CapturedDndProps>
}

// 合成 event ヘルパー (spec §8-4: `{ active: { id }, over: { id } | null }`)。
// 実 dnd-kit の event 型はより多くの field を要求するが、本実装の handler は
// active.id / over?.id しか読まないため、テスト用の最小形を cast して渡す。
function dragStartEvent(activeId: string): DragStartEvent {
  return { active: { id: activeId } } as unknown as DragStartEvent
}
function dragEndEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId },
    over: overId === null ? null : { id: overId },
  } as unknown as DragEndEvent
}
function dragCancelEvent(): DragCancelEvent {
  return {} as unknown as DragCancelEvent
}

function handleButton(title: string) {
  return screen.getByRole('button', { name: `行を並べ替え: ${title}` })
}

// DndContext は自身のアナウンス用 LiveRegion (role="status" aria-live="assertive") を
// 常時 mount するため、ActionToast (role="status" aria-live="polite") と role が
// 衝突する。 aria-live で判別する (exam-card-table-move.test.tsx と同じ理由・同型)。
function actionToastOrNull(): HTMLElement | null {
  return (
    screen.queryAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite') ??
    null
  )
}
async function findActionToast(): Promise<HTMLElement> {
  return waitFor(() => {
    const toast = actionToastOrNull()
    if (!toast) throw new Error('ActionToast (role=status aria-live=polite) not found yet')
    return toast
  })
}

// ===========================================================================
// ① 有効 drop — moveCards への引数 (cardIds は活対象のみ)
// ===========================================================================

describe('① 有効 drop', () => {
  it('moveCards が cardIds=[activeId] で 1 回呼ばれる(選択中の別行があっても対象は drag 対象のみ)', async () => {
    await renderTable(3)
    // card-1 / card-2 を選択(drag 対象は非選択の card-3)。
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 1/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /行選択.*Card 2/ }))

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-3', 'card-1'))
    })

    expect(mockMoveCards).toHaveBeenCalledTimes(1)
    expect(mockMoveCards).toHaveBeenCalledWith({
      cardIds: ['card-3'],
      targetExamId: EXAM_ID,
      placement: { kind: 'start' },
    })
  })
})

// ===========================================================================
// ② 同一 tick 2 発 dispatch — moveCards は 1 回のみ(同期再入ガード)
// ===========================================================================

describe('② 同一 tick 2 発 dispatch', () => {
  it('await を挟まず onDragEnd を 2 回発火しても moveCards は 1 回', async () => {
    await renderTable(3)

    // 1 つの act() の中で await を挟まず連続発火する(fireEvent は 1 回ごとに act で
    // 包み再 render を flush するため、実ブラウザの「同一 tick に 2 発届く」窓を
    // 再現しない。 個別に act() で包むと同じ理由で窓が壊れる — 1 つの act() 内で
    // 両方を await なしに呼ぶ)。
    await act(async () => {
      void captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
      void captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })

    expect(mockMoveCards).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// ③ over=null / active===over — 未発行・toast なし
// ===========================================================================

describe('③ no-op 条件(over 不在 / 自分自身)', () => {
  it('over=null は moveCards を発行しない', async () => {
    await renderTable(3)
    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', null))
    })
    expect(mockMoveCards).not.toHaveBeenCalled()
    expect(actionToastOrNull()).toBeNull()
  })

  it('active===over は moveCards を発行しない', async () => {
    await renderTable(3)
    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-1'))
    })
    expect(mockMoveCards).not.toHaveBeenCalled()
    expect(actionToastOrNull()).toBeNull()
  })
})

// ===========================================================================
// ④ 同位置 no-op の後の有効 drop — 正常発行(ref 残置なしの pin)
// ===========================================================================

describe('④ no-op の後の有効 drop', () => {
  it('no-op drop の後でも次の有効な drop は正常に発行される', async () => {
    await renderTable(3)

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', null))
    })
    expect(mockMoveCards).not.toHaveBeenCalled()

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })
    expect(mockMoveCards).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// ⑤ 成功 — 「並び順を変更しました」+ 元に戻す → undoMove 配線
// ===========================================================================

describe('⑤ 成功経路', () => {
  it('成功で「並び順を変更しました」+ 元に戻す が表示され、undoMove に配線される', async () => {
    await renderTable(3)

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })

    const toast = await findActionToast()
    expect(toast).toHaveTextContent('並び順を変更しました')
    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))
    await waitFor(() => expect(mockUndoMove).toHaveBeenCalledWith(MOVE_OK))
  })
})

// ===========================================================================
// ⑥ 失敗(reject / {ok:false}) — 「並べ替えに失敗しました」+ undo ボタン非表示
// ===========================================================================

describe('⑥ 失敗経路', () => {
  it('reject (tx 失敗) は「並べ替えに失敗しました」を出し、undo ボタンは無い', async () => {
    mockMoveCards.mockRejectedValue(new Error('tx failed'))
    await renderTable(3)

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })

    const toast = await findActionToast()
    expect(toast).toHaveTextContent('並べ替えに失敗しました')
    expect(within(toast).queryByRole('button', { name: '元に戻す' })).not.toBeInTheDocument()
  })

  it('{ok:false} は理由を問わず「並べ替えに失敗しました」を出し、undo ボタンは無い', async () => {
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'no-cards' })
    await renderTable(3)

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })

    const toast = await findActionToast()
    expect(toast).toHaveTextContent('並べ替えに失敗しました')
    expect(within(toast).queryByRole('button', { name: '元に戻す' })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑦ reject 後の再試行 — 発行される(finally での ref 解除の pin)
// ===========================================================================

describe('⑦ reject 後の再試行', () => {
  it('reject の後でも次の drop は moveCards を発行する', async () => {
    mockMoveCards.mockRejectedValueOnce(new Error('tx failed'))
    await renderTable(3)

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })
    await findActionToast()

    mockMoveCards.mockResolvedValueOnce(MOVE_OK)
    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })

    expect(mockMoveCards).toHaveBeenCalledTimes(2)
  })
})

// ===========================================================================
// ⑧ sorting 適用中 — handle disabled + aria-describedby、onDragEnd 手動発火は破棄
// ===========================================================================

describe('⑧ sorting 適用中の gating', () => {
  it('handle が disabled + aria-describedby を持ち、onDragEnd 手動発火は moveCards を発行しない', async () => {
    await renderTable(3)

    // 列メニューから昇順ソートを適用(exam-card-table-move.test.tsx の gating test と同型)。
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const handle = handleButton('Card 1')
    expect(handle).toBeDisabled()
    // aria-describedby は dnd-kit 自前の id + lockedReasonId を空白区切りで合成する
    // (exam-card-row-dnd.tsx:147) ため、非 null チェックだけでは dnd-kit 側の id だけでも
    // 通ってしまい、table 側の sr-only <p id={lockedReasonId}> (exam-card-table.tsx) が
    // 消えても検出できない。参照先を実際に解決し、ロック理由本文を持つ要素であることまで
    // 確認する。
    const describedByIds = (handle.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    const lockedReasonEl = describedByIds
      .map((id) => document.getElementById(id))
      .find((el) => el?.textContent === ROW_DND_LOCKED_REASON)
    expect(lockedReasonEl).not.toBeUndefined()

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })
    expect(mockMoveCards).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// ⑨ data 1 件 — handle 非描画
// ===========================================================================

describe('⑨ data 1 件', () => {
  it('カードが 1 件のとき掴み手(handle)は描画されない', async () => {
    await renderTable(1)
    expect(screen.queryByRole('button', { name: /行を並べ替え:/ })).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑩ onDragStart のプレビュー — onDragEnd / onDragCancel で消える(cancel は無音)
// ===========================================================================

describe('⑩ プレビューの表示/消去', () => {
  it('onDragStart で番号+タイトルのプレビューが表示され、onDragEnd で消える', async () => {
    await renderTable(3)

    act(() => {
      captured().onDragStart(dragStartEvent('card-1'))
    })
    expect(screen.getByText('0001 Card 1')).toBeInTheDocument()

    await act(async () => {
      await captured().onDragEnd(dragEndEvent('card-1', null))
    })
    expect(screen.queryByText('0001 Card 1')).not.toBeInTheDocument()
  })

  it('onDragCancel でプレビューが消え、moveCards は不発火・toast も出ない', async () => {
    await renderTable(3)

    act(() => {
      captured().onDragStart(dragStartEvent('card-1'))
    })
    expect(screen.getByText('0001 Card 1')).toBeInTheDocument()

    act(() => {
      captured().onDragCancel(dragCancelEvent())
    })
    expect(screen.queryByText('0001 Card 1')).not.toBeInTheDocument()
    expect(mockMoveCards).not.toHaveBeenCalled()
    expect(actionToastOrNull()).toBeNull()
  })
})

// ===========================================================================
// ⑪ stale active id — onDragStart でプレビュー非表示
// ===========================================================================

describe('⑪ stale active id', () => {
  it('data に無い id の onDragStart はプレビューを表示しない', async () => {
    await renderTable(3)

    act(() => {
      captured().onDragStart(dragStartEvent('card-does-not-exist'))
    })
    expect(screen.queryByText('0001 Card 1')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// ⑫ moveCards 未解決中 — handle disabled(movePending 反映)
// ===========================================================================

describe('⑫ 移動実行中の handle disabled', () => {
  it('moveCards が未解決の間、handle は disabled になる', async () => {
    let resolveMove: (v: typeof MOVE_OK) => void = () => {}
    mockMoveCards.mockImplementation(
      () =>
        new Promise<typeof MOVE_OK>((resolve) => {
          resolveMove = resolve
        }),
    )
    await renderTable(3)

    act(() => {
      void captured().onDragEnd(dragEndEvent('card-1', 'card-2'))
    })

    await waitFor(() => expect(handleButton('Card 1')).toBeDisabled())

    await act(async () => {
      resolveMove(MOVE_OK)
    })
  })
})

// ===========================================================================
// ⑬ data 1 件 → 2 件目 insert — handle が出現する(rows 動的変化)
// ===========================================================================

describe('⑬ rows 動的変化', () => {
  it('1 件のときは非表示、2 件目を mirror へ insert すると handle が出現する', async () => {
    await renderTable(1)
    expect(screen.queryByRole('button', { name: /行を並べ替え:/ })).not.toBeInTheDocument()

    const db = getClientDb()
    await db.cards.put(makeCard(2))

    await waitFor(() => expect(handleButton('Card 1')).toBeInTheDocument())
  })
})
