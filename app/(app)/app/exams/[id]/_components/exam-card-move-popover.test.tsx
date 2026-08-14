// @vitest-environment jsdom
// ExamCardMovePopover の test (Grid-3 T6 / spec §7.1 / §6.1 / §7.4)。
//
// 検証範囲 = popover が組み立てる **入力** だけ:
//   - 移動先 select (mirror の exams・updated_at desc・現 exam を含む)
//   - 配置 3 種が onMove に渡す placement
//   - anchor select が移動対象を除外し基準順で並ぶ (spec §2.3-2)
//   - gating (§7.4): ソート/フィルタ適用中は「直後」のみ disabled + 理由
//   - outcome の扱い (成功で閉じる / target-exam-missing で stale 選択を破棄)
//
// 実際の移動発行 (useMoveCards)・切り出しの逐次 3 段・toast / inline error・実行中
// flag は親の責務なので、ここでは `onMove` / `onSplitOut` を spy にして outcome を
// 注入する (親側の pin は exam-card-table-move.test.tsx)。 mirror は実 read。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { ExamCardMovePopover, POSITION_LOCKED_REASON } from './exam-card-move-popover'

const USER_ID = 'user-move'
const CURRENT_EXAM = 'exam-current'
const OTHER_EXAM = 'exam-other'

function makeExam(id: string, name: string, updatedAt: string, userId = USER_ID): ClientExam {
  return {
    id,
    user_id: userId,
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
    title: `title ${id}`,
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

type Props = React.ComponentProps<typeof ExamCardMovePopover>

async function renderPopover(overrides: Partial<Props> = {}) {
  const props: Props = {
    userId: USER_ID,
    currentExamId: CURRENT_EXAM,
    // 既定の移動対象 = 現 exam の card-2 (anchor 候補から除外されることの観測点)。
    selectedIds: ['card-2'],
    positionLocked: false,
    pending: false,
    onMove: vi.fn(async () => 'moved' as const),
    onSplitOut: vi.fn(async () => 'moved' as const),
    trigger: <button type="button">移動</button>,
    ...overrides,
  }
  render(<ExamCardMovePopover {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '移動' }))
  await screen.findByTestId('exam-card-move-popover')
  // exams の live query が解決するまで select は空 = 操作しても値が入らないため待つ。
  await waitFor(() =>
    expect(within(targetSelect()).getAllByRole('option').length).toBeGreaterThan(0),
  )
  return props
}

function targetSelect(): HTMLSelectElement {
  return screen.getByLabelText('移動先の試験') as HTMLSelectElement
}

beforeEach(async () => {
  vi.clearAllMocks()

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.exams.bulkPut([
    makeExam(CURRENT_EXAM, '現在の試験', '2026-08-10T00:00:00.000Z'),
    makeExam(OTHER_EXAM, '別の試験', '2026-08-12T00:00:00.000Z'),
    makeExam('exam-old', '古い試験', '2026-08-05T00:00:00.000Z'),
    // 他 user の exam は owner scope で出ない。
    makeExam('exam-alien', '他人の試験', '2026-08-13T00:00:00.000Z', 'other-user'),
  ])
  // 現 exam の基準順は card-3 (1024) → card-2 (2048) → card-1 (4096)。
  // **id 昇順と基準順をわざと逆に**する: Dexie の index 読みは id 順で返るため、
  // 一致させると「基準順に並べ直している」ことを観測できない (sort 除去で red にならない)。
  await db.cards.bulkPut([
    makeCard('card-3', CURRENT_EXAM, 1024, '0003'),
    makeCard('card-2', CURRENT_EXAM, 2048, '0002'),
    makeCard('card-1', CURRENT_EXAM, 4096, '0001'),
  ])
})

afterEach(() => cleanup())

// ===========================================================================
// 移動先 select
// ===========================================================================

describe('移動先の select', () => {
  it('mirror の自分の exam を updated_at desc で並べ、現 exam も候補に含む', async () => {
    await renderPopover()

    await waitFor(() =>
      expect(within(targetSelect()).getAllByRole('option')).toHaveLength(3),
    )
    const options = within(targetSelect()).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((o) => o.value)).toEqual([OTHER_EXAM, CURRENT_EXAM, 'exam-old'])
    // 現 exam は「同一 exam 内の位置移動」のために残す (spec §7.1)。既定値でもある。
    expect(options[1].textContent).toContain('(現在の試験)')
    expect(targetSelect().value).toBe(CURRENT_EXAM)
  })
})

// ===========================================================================
// 配置 3 種 → placement
// ===========================================================================

describe('配置の選択が placement になる', () => {
  it('既定 (末尾) は { kind: "end" } を渡し、成功で popover を閉じる', async () => {
    const props = await renderPopover({ selectedIds: ['card-2', 'card-3'] })

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(props.onMove).toHaveBeenCalledWith(CURRENT_EXAM, { kind: 'end' }),
    )
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-move-popover')).not.toBeInTheDocument(),
    )
  })

  it('先頭を選ぶと { kind: "start" } を渡す', async () => {
    const props = await renderPopover()

    fireEvent.click(screen.getByRole('radio', { name: '先頭' }))
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(props.onMove).toHaveBeenCalledWith(CURRENT_EXAM, { kind: 'start' }),
    )
  })

  it('直後を選ぶと選択中の anchor id で { kind: "after" } を渡す', async () => {
    const props = await renderPopover()

    fireEvent.click(screen.getByRole('radio', { name: '指定カードの直後' }))
    const anchor = (await screen.findByLabelText('基準カード')) as HTMLSelectElement
    // 既定 (基準順の先頭 = card-3) ではない方を選ぶ = 選択値が使われる pin。
    fireEvent.change(anchor, { target: { value: 'card-1' } })
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(props.onMove).toHaveBeenCalledWith(CURRENT_EXAM, {
        kind: 'after',
        anchorId: 'card-1',
      }),
    )
  })

  it('移動先を変えると placement はその exam に対して渡る', async () => {
    const db = getClientDb()
    await db.cards.put(makeCard('card-o1', OTHER_EXAM, 1024, 'O001'))
    const props = await renderPopover()

    fireEvent.change(targetSelect(), { target: { value: OTHER_EXAM } })
    fireEvent.click(screen.getByRole('radio', { name: '先頭' }))
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() =>
      expect(props.onMove).toHaveBeenCalledWith(OTHER_EXAM, { kind: 'start' }),
    )
  })
})

// ===========================================================================
// anchor の候補集合
// ===========================================================================

describe('anchor select の候補', () => {
  it('移動対象を除外し、移動先の常駐カードを基準順で並べる', async () => {
    await renderPopover({ selectedIds: ['card-2'] })

    fireEvent.click(screen.getByRole('radio', { name: '指定カードの直後' }))
    const anchor = (await screen.findByLabelText('基準カード')) as HTMLSelectElement

    const options = within(anchor).getAllByRole('option') as HTMLOptionElement[]
    // card-2 (移動対象自身) は anchor に取れない (spec §2.3-2)。
    // 並びは基準順 (base_order 昇順) = id 順とは逆。
    expect(options.map((o) => o.value)).toEqual(['card-3', 'card-1'])
    // 表示は question_label の先頭部。
    expect(options.map((o) => o.textContent)).toEqual(['0003', '0001'])
  })
})

// ===========================================================================
// gating (§7.4)
// ===========================================================================

describe('ソート/フィルタ gating', () => {
  it('positionLocked で「直後」だけ disabled になり理由が出る (末尾・先頭は有効)', async () => {
    await renderPopover({ positionLocked: true })

    expect(screen.getByRole('radio', { name: '指定カードの直後' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '末尾' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: '先頭' })).toBeEnabled()
    expect(screen.getByText(POSITION_LOCKED_REASON)).toBeInTheDocument()
    // 切り出しも許可される (§7.4)。
    expect(screen.getByRole('button', { name: '新規試験へ切り出し' })).toBeEnabled()
  })

  it('gating なしなら「直後」は有効で理由も出ない', async () => {
    await renderPopover()

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '指定カードの直後' })).toBeEnabled(),
    )
    expect(screen.queryByText(POSITION_LOCKED_REASON)).not.toBeInTheDocument()
  })
})

// ===========================================================================
// 切り出し (b)
// ===========================================================================

describe('新規試験へ切り出し', () => {
  it('切り出し button は onSplitOut を 1 回呼び、成功で popover を閉じる', async () => {
    const props = await renderPopover()

    fireEvent.click(screen.getByRole('button', { name: '新規試験へ切り出し' }))

    await waitFor(() => expect(props.onSplitOut).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-move-popover')).not.toBeInTheDocument(),
    )
  })

  it('pending 中は実行系 button が両方 disabled (実行中 flag は親が持つ)', async () => {
    await renderPopover({ pending: true })

    expect(screen.getByRole('button', { name: '新規試験へ切り出し' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '移動する' })).toBeDisabled()
  })
})

// ===========================================================================
// 移動先が消えていた場合
// ===========================================================================

describe('target-exam-missing の扱い', () => {
  it('stale な移動先選択を既定 (現 exam) に戻し、popover は開いたまま', async () => {
    const onMove = vi.fn(async () => 'target-exam-missing' as const)
    await renderPopover({ onMove })

    fireEvent.change(targetSelect(), { target: { value: OTHER_EXAM } })
    expect(targetSelect().value).toBe(OTHER_EXAM)

    fireEvent.click(screen.getByRole('button', { name: '移動する' }))

    await waitFor(() => expect(targetSelect().value).toBe(CURRENT_EXAM))
    expect(screen.getByTestId('exam-card-move-popover')).toBeInTheDocument()
  })
})
