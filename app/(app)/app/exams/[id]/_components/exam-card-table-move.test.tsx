// @vitest-environment jsdom
// ExamCardTable の移動配線 test (Grid-3 T6 / spec §7.1 / §7.5)。
//
// popover が組み立てた入力を **親がどう捌くか** だけを検証する:
//   - moveCards へ渡す cardIds = 選択行 / 成功で toast + undo 配線
//   - 失敗 3 分岐 (reject = tx 失敗 / no-cards = no-op / target-exam-missing) の扱い
//   - undo 失敗の理由別文言への差し替え
//   - gating の props 経路 (sorting / columnFilters → 「直後」 disabled)
//
// useMoveCards は spy mock (hook 自体の挙動は use-move-cards.test.tsx が pin 済)。
// mirror (exams / cards) は fake-indexeddb の実 read。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
  act,
} from '@testing-library/react'

const { mockMoveCards, mockUndoMove, mockCreateExam, mockRunGuardedPull, mockWaitForExam } =
  vi.hoisted(() => ({
    mockMoveCards: vi.fn(),
    mockUndoMove: vi.fn(),
    mockCreateExam: vi.fn(),
    mockRunGuardedPull: vi.fn(),
    mockWaitForExam: vi.fn(),
  }))

vi.mock('../../_hooks/use-move-cards', () => ({
  useMoveCards: () => ({ moveCards: mockMoveCards, undoMove: mockUndoMove }),
}))

vi.mock('@/app/(app)/app/exams/_actions/create-exam', () => ({
  createExam: mockCreateExam,
}))
vi.mock('@/lib/sync/pull', () => ({
  runGuardedPull: mockRunGuardedPull,
}))
// 待機そのものの挙動 (上限 / 即返り / 途中出現) は wait-for-exam-mirror.test.ts が pin する。
// ここでは「移動の前に待つ」配線だけを見るため spy に差し替える (実時間で待たない)。
vi.mock('../_lib/wait-for-exam-mirror', () => ({
  waitForExamInMirror: mockWaitForExam,
}))

// card-editor-fields → card-image-gallery が server action / R2 経路を transitive import
// するため最小 stub (exam-card-table-bulk.test.tsx と同じ理由)。
vi.mock('../_actions/asset-actions', () => ({
  reserveAsset: vi.fn(),
  finalizeAsset: vi.fn(),
  resolveAssetUrls: vi.fn(async () => ({ ok: true, data: [] })),
}))
vi.mock('@/lib/media/get-asset', () => ({
  getAssetObjectURL: vi.fn(async () => null),
}))

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { POSITION_LOCKED_REASON } from './exam-card-move-popover'
import { ControlledExamCardTable } from './exam-card-table-test-harness'

const USER_ID = 'user-move-table'
const EXAM_ID = 'exam-move-table'

// movedCount は要求枚数ではなく **実際に移動した枚数** (useMoveCards の契約)。
// 選択 2 行に対して 3 を返させ、toast が movedCount を使っていることを観測可能にする。
const MOVE_OK = {
  ok: true as const,
  movedCount: 3,
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
    answered: n === 1,
    last_correct: n === 1 ? true : null,
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
  mockMoveCards.mockResolvedValue(MOVE_OK)
  mockUndoMove.mockResolvedValue({ ok: true })
  mockCreateExam.mockResolvedValue({ ok: true, data: { examId: 'exam-new' } })
  mockRunGuardedPull.mockResolvedValue('ran')
  mockWaitForExam.mockResolvedValue(false)

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.card_tags.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.exams.put(makeExam(EXAM_ID, '現在の試験', '2026-08-10T00:00:00.000Z'))
  await db.cards.bulkPut([makeCard(1), makeCard(2), makeCard(3)])
})

afterEach(() => cleanup())

function selectRow(n: number) {
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`行選択.*Card ${n}`) }))
}

/** 3 行を render → 指定行を選択 → 移動 popover を開く。 */
async function openMovePopover(rows: number[] = [1, 2]) {
  render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
  await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))
  for (const n of rows) selectRow(n)
  const bar = await screen.findByTestId('exam-card-table-action-bar')
  fireEvent.click(within(bar).getByRole('button', { name: '移動' }))
  await screen.findByTestId('exam-card-move-popover')
  await waitFor(() =>
    expect(
      within(screen.getByLabelText('移動先の試験')).getAllByRole('option').length,
    ).toBeGreaterThan(0),
  )
}

/** 閉じている popover を trigger から開き直す (実行中 flag が残っているかの確認用)。 */
async function reopenMovePopover() {
  const bar = screen.getByTestId('exam-card-table-action-bar')
  fireEvent.click(within(bar).getByRole('button', { name: '移動' }))
  await screen.findByTestId('exam-card-move-popover')
}

function splitButton() {
  return screen.getByRole('button', { name: '新規試験へ切り出し' })
}

// row-dnd task-4 の帰結: DndContext が常時 mount されるようになり、dnd-kit 自身の
// アナウンス用 LiveRegion (role="status" aria-live="assertive") が常に 1 個存在する
// ようになった。 ActionToast (role="status" aria-live="polite") と role が衝突するため、
// aria-live で判別する (dnd-kit 側は本 test の対象外で、常に存在し続ける)。
function actionToastOrNull(): HTMLElement | null {
  return (
    screen.queryAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite') ??
    null
  )
}
function getActionToast(): HTMLElement {
  const toast = actionToastOrNull()
  if (!toast) throw new Error('ActionToast (role=status aria-live=polite) not found')
  return toast
}
async function findActionToast(): Promise<HTMLElement> {
  return waitFor(() => {
    const toast = actionToastOrNull()
    if (!toast) throw new Error('ActionToast (role=status aria-live=polite) not found yet')
    return toast
  })
}

// ===========================================================================
// 成功: moveCards 引数 + toast + undo
// ===========================================================================

describe('移動の成功経路', () => {
  it('選択行を cardIds に渡し、成功で「N枚を移動しました」+ 元に戻す を出す', async () => {
    await openMovePopover([1, 2])

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(mockMoveCards).toHaveBeenCalledWith({
        cardIds: ['card-1', 'card-2'],
        targetExamId: EXAM_ID,
        placement: { kind: 'end' },
      }),
    )
    // movedCount (要求枚数ではない) を文言に使う。
    const toast = await findActionToast()
    expect(toast).toHaveTextContent('3枚を移動しました')
    expect(within(toast).getByRole('button', { name: '元に戻す' })).toBeInTheDocument()
    expect(screen.queryByTestId('action-bar-move-error')).not.toBeInTheDocument()
  })

  it('「元に戻す」で undoMove に移動結果を渡し、toast を「元に戻しました」に置換する', async () => {
    await openMovePopover()
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))
    const toast = await findActionToast()

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() => expect(mockUndoMove).toHaveBeenCalledWith(MOVE_OK))
    await waitFor(() =>
      expect(getActionToast()).toHaveTextContent('元に戻しました'),
    )
    expect(screen.queryByRole('button', { name: '元に戻す' })).not.toBeInTheDocument()
  })

  it('undo 失敗は理由の文言に差し替える (cards-missing)', async () => {
    mockUndoMove.mockResolvedValue({ ok: false, reason: 'cards-missing' })
    await openMovePopover()
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))
    const toast = await findActionToast()

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() =>
      expect(getActionToast()).toHaveTextContent(
        '移動したカードの一部が削除されています',
      ),
    )
  })

  it('undo 失敗は理由の文言に差し替える (source-exam-missing)', async () => {
    mockUndoMove.mockResolvedValue({ ok: false, reason: 'source-exam-missing' })
    await openMovePopover()
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))
    const toast = await findActionToast()

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() =>
      expect(getActionToast()).toHaveTextContent('元の試験が削除されています'),
    )
  })
})

// ===========================================================================
// 失敗 3 分岐 (Task 5 の契約)
// ===========================================================================

describe('移動の失敗 3 分岐', () => {
  it('reject (tx 失敗) は inline error に出す (toast は出さない)', async () => {
    mockMoveCards.mockRejectedValue(new Error('tx failed'))
    await openMovePopover()

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(screen.getByTestId('action-bar-move-error')).toHaveTextContent(
        '移動に失敗しました',
      ),
    )
    expect(actionToastOrNull()).toBeNull()
  })

  it('no-cards は no-op (error も toast も出さない)', async () => {
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'no-cards' })
    await openMovePopover()

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() => expect(mockMoveCards).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('action-bar-move-error')).not.toBeInTheDocument()
    expect(actionToastOrNull()).toBeNull()
  })

  it('未知の失敗理由は silent な no-op にせず inline error に倒す', async () => {
    // reason union が将来増えたときに no-cards へ落ちない (網羅分岐) ことの pin。
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'some-future-reason' })
    await openMovePopover()

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(screen.getByTestId('action-bar-move-error')).toHaveTextContent(
        '移動に失敗しました',
      ),
    )
  })

  it('選択が変わったら直前の失敗表示を捨てる', async () => {
    mockMoveCards.mockRejectedValue(new Error('tx failed'))
    await openMovePopover([1, 2])
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))
    await waitFor(() => expect(screen.getByTestId('action-bar-move-error')).toBeInTheDocument())

    selectRow(3)

    await waitFor(() =>
      expect(screen.queryByTestId('action-bar-move-error')).not.toBeInTheDocument(),
    )
  })

  it('target-exam-missing は移動先不在の inline error を出す', async () => {
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'target-exam-missing' })
    await openMovePopover()

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(screen.getByTestId('action-bar-move-error')).toHaveTextContent(
        '移動先の試験が見つかりません',
      ),
    )
    expect(actionToastOrNull()).toBeNull()
  })
})

// ===========================================================================
// 切り出し (b) — 逐次 3 段 / orphan exam の抑制 (fix round 1)
// ===========================================================================

describe('新規試験へ切り出し', () => {
  it('createExam → runGuardedPull → mirror 待機 → moveCards(末尾) の順で実行する', async () => {
    const calls: string[] = []
    mockCreateExam.mockImplementation(async () => {
      calls.push('createExam')
      return { ok: true, data: { examId: 'exam-new' } }
    })
    mockRunGuardedPull.mockImplementation(async () => {
      calls.push('pull')
      return 'ran'
    })
    mockWaitForExam.mockImplementation(async () => {
      calls.push('wait')
      return true
    })
    mockMoveCards.mockImplementation(async () => {
      calls.push('move')
      return MOVE_OK
    })
    await openMovePopover([1, 2])

    fireEvent.click(splitButton())

    await waitFor(() => expect(calls).toEqual(['createExam', 'pull', 'wait', 'move']))
    expect(mockCreateExam).toHaveBeenCalledWith('無題の試験')
    expect(mockRunGuardedPull).toHaveBeenCalledWith({ userId: USER_ID, reason: 'exam-create' })
    // 待つ対象は pull の outcome ではなく「移動先 exam が mirror に居る」こと。
    expect(mockWaitForExam).toHaveBeenCalledWith('exam-new', USER_ID)
    expect(mockMoveCards).toHaveBeenCalledWith({
      cardIds: ['card-1', 'card-2'],
      targetExamId: 'exam-new',
      placement: { kind: 'end' },
    })
    // 自動遷移しない (spec §6.1) = toast が出て現ビューに留まる。
    expect(await findActionToast()).toHaveTextContent('3枚を移動しました')
  })

  it('実行中は実行系 button が disabled で、二重 submit しても createExam は 1 回', async () => {
    let resolveCreate: (v: { ok: true; data: { examId: string } }) => void = () => {}
    mockCreateExam.mockImplementation(
      () =>
        new Promise<{ ok: true; data: { examId: string } }>((resolve) => {
          resolveCreate = resolve
        }),
    )
    await openMovePopover()

    fireEvent.click(splitButton())
    fireEvent.click(splitButton())

    expect(mockCreateExam).toHaveBeenCalledTimes(1)
    expect(splitButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: '移動する' })).toBeDisabled()

    await act(async () => {
      resolveCreate({ ok: true, data: { examId: 'exam-new' } })
    })
  })

  it('同一 tick に click が 2 発届いても createExam は 1 回 (同期 ref ガード)', async () => {
    // fireEvent は 1 回ごとに act で包み再 render を flush するため、実ブラウザの
    // 「disabled が反映される前に 2 発目が届く」窓を再現しない。1 つの act の中で
    // native click を 2 発 dispatch して窓を作る (state だけのガードでは 2 回入る)。
    let resolveCreate: (v: { ok: true; data: { examId: string } }) => void = () => {}
    mockCreateExam.mockImplementation(
      () =>
        new Promise<{ ok: true; data: { examId: string } }>((resolve) => {
          resolveCreate = resolve
        }),
    )
    await openMovePopover()
    const btn = splitButton()

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockCreateExam).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate({ ok: true, data: { examId: 'exam-new' } })
    })
  })

  it('実行中に popover を閉じて開き直しても二重 submit にならない (flag は table 側)', async () => {
    let resolveCreate: (v: { ok: true; data: { examId: string } }) => void = () => {}
    mockCreateExam.mockImplementation(
      () =>
        new Promise<{ ok: true; data: { examId: string } }>((resolve) => {
          resolveCreate = resolve
        }),
    )
    await openMovePopover()
    fireEvent.click(splitButton())

    // 閉じる → 開き直す (popover は unmount されるので local state なら pending が消える)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-move-popover')).not.toBeInTheDocument(),
    )
    await reopenMovePopover()

    expect(splitButton()).toBeDisabled()
    fireEvent.click(splitButton())
    expect(mockCreateExam).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate({ ok: true, data: { examId: 'exam-new' } })
    })
  })

  it('exam 作成失敗は inline error にし、pull も移動も発行しない', async () => {
    mockCreateExam.mockResolvedValue({ ok: false, error: '認証が必要です' })
    await openMovePopover()

    fireEvent.click(splitButton())

    await waitFor(() =>
      expect(screen.getByTestId('action-bar-move-error')).toHaveTextContent(
        '認証が必要です',
      ),
    )
    expect(mockRunGuardedPull).not.toHaveBeenCalled()
    expect(mockMoveCards).not.toHaveBeenCalled()
  })

  it('pull が skip されても引き直さず、mirror 待機を挟んで移動する', async () => {
    // 即時 retry は同じ skip が返るだけなので、待機 (mirror の実前提) に置き換えてある。
    mockRunGuardedPull.mockResolvedValue('inflight-skip')
    mockWaitForExam.mockResolvedValue(true)
    await openMovePopover()

    fireEvent.click(splitButton())

    await waitFor(() => expect(mockMoveCards).toHaveBeenCalledTimes(1))
    expect(mockRunGuardedPull).toHaveBeenCalledTimes(1)
    expect(mockWaitForExam).toHaveBeenCalledTimes(1)
  })

  it('移動が成立しなければ作成済み exam を保持し、次のクリックで createExam を飛ばす', async () => {
    mockRunGuardedPull.mockResolvedValue('lock-busy')
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'target-exam-missing' })
    await openMovePopover()

    fireEvent.click(splitButton())
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-move-error')).toHaveTextContent(
        '作成した試験の同期が終わっていません',
      ),
    )
    // pull 済みで消えていた場合 (別 test) とは文言を分ける。
    expect(screen.getByTestId('action-bar-move-error')).not.toHaveTextContent(
      '切り出し先の試験が見つかりません',
    )

    // 2 回目: exam は作り直さず (orphan を増やさない)、pull + move から再開する。
    fireEvent.click(splitButton())
    await waitFor(() => expect(mockMoveCards).toHaveBeenCalledTimes(2))
    expect(mockCreateExam).toHaveBeenCalledTimes(1)
    expect(mockMoveCards).toHaveBeenLastCalledWith({
      cardIds: ['card-1', 'card-2'],
      targetExamId: 'exam-new',
      placement: { kind: 'end' },
    })
  })

  it('pull が走ったのに移動先が居なければ保持を破棄し、次のクリックで作り直す', async () => {
    // pull 済み = mirror は最新 → 移動先不在は「未同期」ではなく削除。resume を続けると
    // createExam が二度と走らず切り出しが詰まるので手放す (fix round 2)。
    mockRunGuardedPull.mockResolvedValue('ran')
  mockWaitForExam.mockResolvedValue(false)
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'target-exam-missing' })
    await openMovePopover()

    fireEvent.click(splitButton())
    await waitFor(() =>
      expect(screen.getByTestId('action-bar-move-error')).toHaveTextContent(
        '切り出し先の試験が見つかりません',
      ),
    )
    // 同期待ちの案内は出さない (削除に対する誤誘導の防止)。
    expect(screen.getByTestId('action-bar-move-error')).not.toHaveTextContent(
      '同期が終わっていません',
    )

    fireEvent.click(splitButton())
    await waitFor(() => expect(mockCreateExam).toHaveBeenCalledTimes(2))
  })

  it('移動が成立したら保持を手放し、次の切り出しは新しい exam を作る', async () => {
    await openMovePopover()

    fireEvent.click(splitButton())
    await waitFor(() => expect(mockMoveCards).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-move-popover')).not.toBeInTheDocument(),
    )

    await reopenMovePopover()
    fireEvent.click(splitButton())

    await waitFor(() => expect(mockCreateExam).toHaveBeenCalledTimes(2))
  })
})

// ===========================================================================
// gating の props 経路 (§7.4)
// ===========================================================================

describe('ソート/フィルタ gating の配線', () => {
  it('ソート適用中は「指定カードの直後」が disabled になる', async () => {
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    // 列メニューから昇順ソートを適用 (sorting.length > 0)。
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    selectRow(1)
    const bar = await screen.findByTestId('exam-card-table-action-bar')
    fireEvent.click(within(bar).getByRole('button', { name: '移動' }))
    await screen.findByTestId('exam-card-move-popover')

    // gating 理由の表示 = positionLocked が popover まで届いた証拠。
    // (radio の disabled は anchor 候補ゼロでも立つため、理由文言で判別する。)
    expect(screen.getByText(POSITION_LOCKED_REASON)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '指定カードの直後' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '末尾' })).toBeEnabled()
  })

  it('フィルタ適用中は「指定カードの直後」が disabled になる', async () => {
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(3))

    // 列メニューから「直近正解」フィルタを適用 (columnFilters.length > 0)。
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    fireEvent.change(
      within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'),
      { target: { value: 'correct' } },
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-card-/)).toHaveLength(1))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    selectRow(1)
    const bar = await screen.findByTestId('exam-card-table-action-bar')
    fireEvent.click(within(bar).getByRole('button', { name: '移動' }))
    await screen.findByTestId('exam-card-move-popover')

    expect(screen.getByText(POSITION_LOCKED_REASON)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '指定カードの直後' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '末尾' })).toBeEnabled()
  })
})
