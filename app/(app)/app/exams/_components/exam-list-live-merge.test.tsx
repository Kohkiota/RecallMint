// @vitest-environment jsdom
// ExamListLive の結合配線 test (Grid-3 T8 / spec §7.3 / §7.5)。
//
// 行の MergeExamButton が組み立てた入力を **一覧がどう捌くか** だけを検証する:
//   - hook の moveCards が行に渡っている (結合実行で発行される)
//   - 成功で完了 toast + undo 配線 (movedCount 文言 / undoMove へ result を素通し)
//   - undo 失敗の理由別文言への差し替え・reject の汎用文言
//   - toast は単一 slot で、閉じると消える
//   - cardCount = 0 の行は「結合」 disabled (mirror 集計が行へ渡っている)
//
// useMoveCards は spy mock (hook 自体の挙動は use-move-cards.test.tsx が pin 済)。
// exams / cards mirror は fake-indexeddb の実 read。

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

vi.mock('../_hooks/use-move-cards', () => ({
  useMoveCards: () => ({ moveCards: mockMoveCards, undoMove: mockUndoMove }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))
vi.mock('@/app/(app)/app/exams/_actions/delete-exam', () => ({
  deleteExam: vi.fn().mockResolvedValue({ ok: true }),
}))

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { ExamListLive } from './exam-list-live'
import { ExamStatusProvider } from '../../_components/exam-status-live'

const USER_A = 'user-a'
import type { MoveResult } from '../_hooks/use-move-cards'

global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })

const USER_ID = 'user-list-merge'
const SOURCE_EXAM_ID = 'exam-src'

const MOVE_OK: MoveResult = {
  ok: true,
  movedCount: 2,
  originals: [{ id: 'c1', exam_id: SOURCE_EXAM_ID, base_order: 1024 }],
  sourceExamId: SOURCE_EXAM_ID,
}

// 2 件目の結合 (別の行) の結果。movedCount / originals を変えて、どちらの undo 素材が
// 生きているかを観測可能にする。
const MOVE_OK_B: MoveResult = {
  ok: true,
  movedCount: 1,
  originals: [{ id: 'c3', exam_id: 'exam-second', base_order: 1024 }],
  sourceExamId: 'exam-second',
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

function makeCard(id: string, examId: string, baseOrder: number): ClientCard {
  return {
    id,
    user_id: USER_ID,
    exam_id: examId,
    source_document_id: null,
    title: id,
    question_label: null,
    base_order: baseOrder,
    question_text: 'Q',
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

/**
 * 一覧を描画する。行は 3 つ:
 * - 結合元の試験 (2 枚) / 第二の試験 (1 枚) = 結合できる行
 * - 合流先の試験 (0 枚) = disabled の行
 */
async function renderList() {
  const db = getClientDb()
  await db.exams.bulkPut([
    makeExam(SOURCE_EXAM_ID, '結合元の試験', '2026-08-10T00:00:00.000Z'),
    makeExam('exam-dst', '合流先の試験', '2026-08-09T00:00:00.000Z'),
    makeExam('exam-second', '第二の試験', '2026-08-08T00:00:00.000Z'),
  ])
  await db.cards.bulkPut([
    makeCard('c1', SOURCE_EXAM_ID, 1024),
    makeCard('c2', SOURCE_EXAM_ID, 2048),
    makeCard('c3', 'exam-second', 1024),
  ])

  render(
    <ExamStatusProvider initialStatuses={{}} userId={USER_A}>
      <ExamListLive userId={USER_ID} />
    </ExamStatusProvider>,
  )

  await screen.findByText('結合元の試験')
}

/** 指定した行だけに絞って「結合」を展開し、結合を実行する。 */
async function runMerge(examName = '結合元の試験') {
  const row = screen.getByText(examName).closest('li')
  if (row === null) throw new Error(`${examName} の行が見つからない`)
  fireEvent.click(within(row).getByRole('button', { name: '結合' }))
  fireEvent.click(within(row).getByRole('button', { name: '結合する' }))
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockMoveCards.mockResolvedValue(MOVE_OK)
  mockUndoMove.mockResolvedValue({ ok: true })

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
})

afterEach(() => {
  cleanup()
})

describe('ExamListLive — 結合の配線', () => {
  it('hook の moveCards が行に渡っている (結合元の全 card / 合流先 / 末尾)', async () => {
    await renderList()
    await runMerge()

    await waitFor(() => expect(mockMoveCards).toHaveBeenCalledTimes(1))
    const arg = mockMoveCards.mock.calls[0][0] as {
      cardIds: string[]
      targetExamId: string
      placement: { kind: string }
    }
    expect([...arg.cardIds].sort()).toEqual(['c1', 'c2'])
    expect(arg.targetExamId).toBe('exam-dst')
    expect(arg.placement).toEqual({ kind: 'end' })
  })

  it('cardCount = 0 の行は「結合」が disabled (mirror 集計が行へ渡っている)', async () => {
    await renderList()

    const emptyRow = screen.getByText('合流先の試験').closest('li')
    if (emptyRow === null) throw new Error('合流先の行が見つからない')
    expect(within(emptyRow).getByRole('button', { name: '結合' })).toBeDisabled()
  })

  it('成功で完了 toast (movedCount 文言) と「元に戻す」が出る', async () => {
    await renderList()
    await runMerge()

    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('2枚を移動しました')
    expect(within(toast).getByRole('button', { name: '元に戻す' })).toBeInTheDocument()
  })

  it('「元に戻す」で undoMove に MoveResult を渡し、完了文言に差し替える', async () => {
    await renderList()
    await runMerge()
    const toast = await screen.findByRole('status')

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() => expect(mockUndoMove).toHaveBeenCalledWith(MOVE_OK))
    expect(await screen.findByRole('status')).toHaveTextContent('元に戻しました')
    // 差し替え後は undo button が消える (二度押しの余地を残さない)
    expect(screen.queryByRole('button', { name: '元に戻す' })).not.toBeInTheDocument()
  })

  it('undo 発行中は「元に戻す」が disabled (actionPending 配線)', async () => {
    let resolveUndo: (v: { ok: true }) => void = () => {}
    mockUndoMove.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveUndo = resolve
        }),
    )
    await renderList()
    await runMerge()
    const toast = await screen.findByRole('status')

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled(),
    )

    await act(async () => {
      resolveUndo({ ok: true })
    })
  })

  it.each([
    ['source-exam-missing', '元の試験が削除されています'],
    ['cards-missing', '移動したカードの一部が削除されています'],
  ])('undo 失敗 (%s) は理由文言に差し替える', async (reason, message) => {
    mockUndoMove.mockResolvedValue({ ok: false, reason })
    await renderList()
    await runMerge()
    const toast = await screen.findByRole('status')

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message))
  })

  it('undo の reject は汎用の失敗文言に差し替える', async () => {
    mockUndoMove.mockRejectedValue(new Error('tx failed'))
    await renderList()
    await runMerge()
    const toast = await screen.findByRole('status')

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('元に戻せませんでした'),
    )
  })

  // fix round 1 (Codex Imp): undo の完了は「それを開始した toast」の slot にだけ書く。
  it('undo 発行中に別の行が結合を完了 → 古い undo の完了が新しい toast を壊さない', async () => {
    let resolveUndoA: (v: { ok: true }) => void = () => {}
    mockUndoMove.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveUndoA = resolve
        }),
    )
    mockMoveCards.mockResolvedValueOnce(MOVE_OK).mockResolvedValueOnce(MOVE_OK_B)

    await renderList()
    // 結合 A → undo A を開始 (未完了のまま保持)
    await runMerge('結合元の試験')
    const toastA = await screen.findByRole('status')
    fireEvent.click(within(toastA).getByRole('button', { name: '元に戻す' }))
    await waitFor(() => expect(mockUndoMove).toHaveBeenCalledWith(MOVE_OK))

    // 別の行で結合 B が完了 → toast は B に置き換わる
    await runMerge('第二の試験')
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('1枚を移動しました'),
    )
    // undo pending は操作単位: A の発行中でも B の undo は押せる
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeEnabled()

    // 古い undo A の完了が B の toast を上書きしない
    await act(async () => {
      resolveUndoA({ ok: true })
    })
    expect(screen.getByRole('status')).toHaveTextContent('1枚を移動しました')
    expect(screen.queryByText('元に戻しました')).not.toBeInTheDocument()

    // B の undo 素材が生きている (B の result で発行できる)
    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }))
    await waitFor(() => expect(mockUndoMove).toHaveBeenLastCalledWith(MOVE_OK_B))
  })

  it('古い undo の完了が、後から始まった undo の pending を消さない', async () => {
    let resolveUndoA: (v: { ok: true }) => void = () => {}
    let resolveUndoB: (v: { ok: true }) => void = () => {}
    mockUndoMove
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            resolveUndoA = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            resolveUndoB = resolve
          }),
      )
    mockMoveCards.mockResolvedValueOnce(MOVE_OK).mockResolvedValueOnce(MOVE_OK_B)

    await renderList()
    await runMerge('結合元の試験')
    fireEvent.click(within(await screen.findByRole('status')).getByRole('button', { name: '元に戻す' }))
    await runMerge('第二の試験')
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('1枚を移動しました'),
    )
    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }))
    await waitFor(() => expect(mockUndoMove).toHaveBeenLastCalledWith(MOVE_OK_B))
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled()

    // A の完了は B の pending を解除しない (B は発行中のまま)
    await act(async () => {
      resolveUndoA({ ok: true })
    })
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled()

    await act(async () => {
      resolveUndoB({ ok: true })
    })
    expect(screen.getByRole('status')).toHaveTextContent('元に戻しました')
  })

  it('toast を閉じた後に undo が完了しても toast は復活しない (dismiss = 破棄)', async () => {
    let resolveUndo: (v: { ok: true }) => void = () => {}
    mockUndoMove.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveUndo = resolve
        }),
    )
    await renderList()
    await runMerge()
    const toast = await screen.findByRole('status')

    fireEvent.click(within(toast).getByRole('button', { name: '元に戻す' }))
    fireEvent.click(within(toast).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())

    await act(async () => {
      resolveUndo({ ok: true })
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('toast を閉じると消える (undo 素材も一緒に破棄される)', async () => {
    await renderList()
    await runMerge()
    const toast = await screen.findByRole('status')

    fireEvent.click(within(toast).getByRole('button', { name: '閉じる' }))

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('失敗 (reject) では toast を出さない (行の inline error に留める)', async () => {
    mockMoveCards.mockRejectedValue(new Error('tx failed'))
    await renderList()
    await runMerge()

    await waitFor(() =>
      expect(screen.getByTestId('merge-exam-error')).toHaveTextContent('結合に失敗しました'),
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
