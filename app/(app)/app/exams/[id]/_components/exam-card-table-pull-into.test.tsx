// @vitest-environment jsdom
// ExamCardTable × 行メニュー「ここに取り込む」の配線 test (Grid-3 T7 / spec §7.2)。
//
// picker が組み立てた入力を **親がどう捌くか** だけを検証する:
//   - moveCards へ渡す引数 (取り込み先 = 現 exam / placement = 行 card の直後)
//   - 成功で toast + undo (一括バー (a) と同じ slot を共有する)
//   - 失敗 3 分岐 (reject / no-cards / target-exam-missing) の扱いが (a) と同契約
//   - gating (sorting / columnFilters) が meta 経由で行メニューまで届く
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

const { mockMoveCards, mockUndoMove } = vi.hoisted(() => ({
  mockMoveCards: vi.fn(),
  mockUndoMove: vi.fn(),
}))

vi.mock('../../_hooks/use-move-cards', () => ({
  useMoveCards: () => ({ moveCards: mockMoveCards, undoMove: mockUndoMove }),
}))

// card-editor-fields → card-image-gallery が server action / R2 経路を transitive import
// するため最小 stub (exam-card-table-move.test.tsx と同じ理由)。
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

const USER_ID = 'user-pull-into'
const EXAM_ID = 'exam-pull-into'
const SOURCE_EXAM = 'exam-pull-source'

const MOVE_OK = {
  ok: true as const,
  movedCount: 2,
  originals: [{ id: 'src-2', exam_id: SOURCE_EXAM, base_order: 2048 }],
  sourceExamId: SOURCE_EXAM,
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

function makeCard(id: string, examId: string, baseOrder: number, label: string): ClientCard {
  return {
    id,
    user_id: USER_ID,
    exam_id: examId,
    source_document_id: null,
    title: `Card ${id}`,
    question_label: label,
    base_order: baseOrder,
    question_text: 'q',
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
  mockMoveCards.mockResolvedValue(MOVE_OK)
  mockUndoMove.mockResolvedValue({ ok: true })

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.card_tags.clear()
  await db.tag_categories.clear()
  await db.tag_options.clear()
  await db.exams.bulkPut([
    makeExam(EXAM_ID, '現在の試験', '2026-08-10T00:00:00.000Z'),
    makeExam(SOURCE_EXAM, '取り込み元の試験', '2026-08-12T00:00:00.000Z'),
  ])
  await db.cards.bulkPut([
    makeCard('row-1', EXAM_ID, 1024, '0001'),
    makeCard('row-2', EXAM_ID, 2048, '0002'),
    makeCard('src-2', SOURCE_EXAM, 1024, 'S002'),
    makeCard('src-1', SOURCE_EXAM, 2048, 'S001'),
  ])
})

afterEach(() => cleanup())

/** table を render し、指定行の行メニューから picker を開いてカードを 1 枚選ぶ。 */
async function openPickerOnRow(rowCardId: string) {
  render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
  await waitFor(() => expect(screen.getAllByTestId(/^row-/)).toHaveLength(2))

  fireEvent.click(screen.getByRole('button', { name: `行メニュー: Card ${rowCardId}` }))
  fireEvent.click(await screen.findByRole('button', { name: 'ここに取り込む' }))
  await screen.findByTestId('exam-card-pull-into-dialog')

  const list = await screen.findByTestId('pull-into-card-list')
  await waitFor(() => expect(within(list).getAllByRole('checkbox')).toHaveLength(2))
  return within(list).getAllByRole('checkbox') as HTMLInputElement[]
}

// ===========================================================================
// 成功経路
// ===========================================================================

describe('取り込みの成功経路', () => {
  it('取り込み先 = 現 exam / 位置 = 行 card の直後 で moveCards を呼ぶ', async () => {
    const boxes = await openPickerOnRow('row-2')

    fireEvent.click(boxes[0]) // 基準順の先頭 = src-2
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(mockMoveCards).toHaveBeenCalledWith({
        cardIds: ['src-2'],
        targetExamId: EXAM_ID,
        placement: { kind: 'after', anchorId: 'row-2' },
      }),
    )
  })

  it('成功で picker が閉じ、一括バーと同じ toast + 元に戻す が出る', async () => {
    const boxes = await openPickerOnRow('row-1')

    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
    const toast = await screen.findByRole('status')
    // movedCount (要求枚数ではない) を文言に使う。
    expect(toast).toHaveTextContent('2枚を移動しました')

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))
    await waitFor(() => expect(mockUndoMove).toHaveBeenCalledWith(MOVE_OK))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('元に戻しました'),
    )
  })
})

// ===========================================================================
// 失敗 3 分岐 (Task 5 の契約 — 一括バー (a) と同じ扱い)
// ===========================================================================

describe('取り込みの失敗 3 分岐', () => {
  it('reject (tx 失敗) は picker 内 inline error に出す (toast は出さない)', async () => {
    mockMoveCards.mockRejectedValue(new Error('tx failed'))
    const boxes = await openPickerOnRow('row-1')

    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(screen.getByTestId('pull-into-error')).toHaveTextContent('移動に失敗しました'),
    )
    expect(screen.getByTestId('exam-card-pull-into-dialog')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('no-cards は no-op (error も toast も出さず picker を閉じる)', async () => {
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'no-cards' })
    const boxes = await openPickerOnRow('row-1')

    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
    expect(screen.queryByTestId('pull-into-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('target-exam-missing は移動先不在の inline error を出す', async () => {
    mockMoveCards.mockResolvedValue({ ok: false, reason: 'target-exam-missing' })
    const boxes = await openPickerOnRow('row-1')

    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(screen.getByTestId('pull-into-error')).toHaveTextContent(
        '移動先の試験が見つかりません',
      ),
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

// ===========================================================================
// 行 cell との干渉 / gating の props 経路
// ===========================================================================

describe('行メニューの配線', () => {
  it('行メニューを開いても行選択はトグルしない (select td の click 分離)', async () => {
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-/)).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: '行メニュー: Card row-1' }))

    await screen.findByRole('button', { name: 'ここに取り込む' })
    expect(screen.getByRole('checkbox', { name: '行選択: Card row-1' })).not.toBeChecked()
    // 選択ゼロ = 一括バーは mount されない (行メニューは選択に依存しない導線)。
    expect(screen.queryByTestId('exam-card-table-action-bar')).not.toBeInTheDocument()
  })

  it('menu 項目 (ここに取り込む) の click でも行選択はトグルしない', async () => {
    // PopoverContent は portal でも React tree では行 cell の子 = td の onClick へ伝播する。
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-/)).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '行メニュー: Card row-1' }))

    fireEvent.click(await screen.findByRole('button', { name: 'ここに取り込む' }))

    await screen.findByTestId('exam-card-pull-into-dialog')
    expect(screen.getByRole('checkbox', { name: '行選択: Card row-1' })).not.toBeChecked()
  })

  it('picker 内の checkbox click でも行選択はトグルしない', async () => {
    const boxes = await openPickerOnRow('row-1')

    fireEvent.click(boxes[0])

    expect(boxes[0]).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '行選択: Card row-1' })).not.toBeChecked()
  })

  it('backdrop click (picker を閉じる) でも行選択はトグルしない', async () => {
    await openPickerOnRow('row-1')

    fireEvent.click(screen.getByTestId('pull-into-backdrop'))

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('checkbox', { name: '行選択: Card row-1' })).not.toBeChecked()
  })

  it('取り込みの実行中は確定 button が塞がり、二重 submit しても moveCards は 1 回', async () => {
    // 実行中 flag は table の movePending (一括バー / 切り出しと共有) を meta 経由で配る。
    let resolveMove: (v: typeof MOVE_OK) => void = () => {}
    mockMoveCards.mockImplementation(
      () =>
        new Promise<typeof MOVE_OK>((resolve) => {
          resolveMove = resolve
        }),
    )
    const boxes = await openPickerOnRow('row-1')
    fireEvent.click(boxes[0])

    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    expect(mockMoveCards).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveMove(MOVE_OK)
    })
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
  })

  it('ソート適用中は menu 項目が disabled になり理由が出る', async () => {
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-/)).toHaveLength(2))

    // 列メニューから昇順ソートを適用 (sorting.length > 0)。
    fireEvent.click(screen.getByLabelText('タイトル の列メニュー'))
    fireEvent.click(await screen.findByRole('button', { name: '昇順' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '行メニュー: Card row-1' }))

    const item = await screen.findByRole('button', { name: 'ここに取り込む' })
    expect(item).toBeDisabled()
    expect(screen.getByText(POSITION_LOCKED_REASON)).toBeInTheDocument()
  })

  it('フィルタ適用中も menu 項目が disabled になる', async () => {
    render(<ControlledExamCardTable examId={EXAM_ID} userId={USER_ID} />)
    await waitFor(() => expect(screen.getAllByTestId(/^row-/)).toHaveLength(2))

    // 列メニューから「直近正解」フィルタを適用 (columnFilters.length > 0)。
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    fireEvent.change(
      within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'),
      { target: { value: 'correct' } },
    )
    await waitFor(() => expect(screen.queryAllByTestId(/^row-/)).toHaveLength(0))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // フィルタで全行が消えるため、フィルタを緩めずに menu を確認できるよう
    // 「未回答」に切り替えて 2 行に戻す。
    fireEvent.click(screen.getByLabelText('直近正誤 の列メニュー'))
    fireEvent.change(
      within(screen.getByRole('dialog')).getByLabelText('回答状態フィルタ'),
      { target: { value: 'unanswered' } },
    )
    await waitFor(() => expect(screen.getAllByTestId(/^row-/)).toHaveLength(2))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '行メニュー: Card row-1' }))

    const item = await screen.findByRole('button', { name: 'ここに取り込む' })
    expect(item).toBeDisabled()
    expect(screen.getByText(POSITION_LOCKED_REASON)).toBeInTheDocument()
  })
})
