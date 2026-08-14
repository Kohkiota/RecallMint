// @vitest-environment jsdom
// MergeExamButton の test (Grid-3 T8 / spec §7.3 — UI 入口 d 「結合」)。
//
// 検証するのは **入力の組み立てと実行の起動** だけ:
//   - 0 枚 / 候補ゼロの行では展開させない
//   - 合流先 select が自身を除外する
//   - 確認文言に枚数と合流先名が入る
//   - moveCards へ渡す引数 (結合元の全 card id / 合流先 / 配置) と owner scope
//   - 元 exam を削除しない (mirror の行も削除系 action も触らない)
//   - 失敗 3 分岐 (reject / no-cards / target-exam-missing) の扱い
//   - 同一 tick の二重 click を同期 ref ガードが弾く
//
// moveCards は spy 注入 (hook 自体の挙動は use-move-cards.test.tsx が pin 済)。
// 結合元 card の読み出しは fake-indexeddb の実 Dexie。
//
// toast / undo は **親** (ExamListLive) の責務なので本 file では見ない
// (exam-list-live-merge.test.tsx が pin する)。

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

// 本 component は削除系 action を import しない。将来 import されたら気付けるように
// module を mock して「呼ばれない」ことを assert する (spec §7.3: 元 exam は空で残す)。
const { mockDeleteExam } = vi.hoisted(() => ({ mockDeleteExam: vi.fn() }))
vi.mock('@/app/(app)/app/exams/_actions/delete-exam', () => ({
  deleteExam: mockDeleteExam,
}))

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { MergeExamButton } from './merge-exam-button'
import type { MoveCardsFn, MoveResult } from '../_hooks/use-move-cards'

type MergeSuccess = MoveResult & { ok: true }

const USER_ID = 'user-merge'
const OTHER_USER_ID = 'user-other'
const SOURCE_EXAM_ID = 'exam-a'

const MOVE_OK: MoveResult = {
  ok: true,
  // movedCount は要求枚数ではなく実枚数 (hook の契約) — 2 枚要求に対し 3 を返させて
  // 呼出側が result を素通しで親へ渡していることを観測可能にする。
  movedCount: 3,
  originals: [{ id: 'c1', exam_id: SOURCE_EXAM_ID, base_order: 1024 }],
  sourceExamId: SOURCE_EXAM_ID,
}

const EXAMS = [
  { id: SOURCE_EXAM_ID, name: '試験 A' },
  { id: 'exam-b', name: '試験 B' },
  { id: 'exam-c', name: '試験 C' },
]

function makeExam(id: string, name: string, userId = USER_ID): ClientExam {
  return {
    id,
    user_id: userId,
    name,
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

function makeCard(id: string, examId: string, baseOrder: number, userId = USER_ID): ClientCard {
  return {
    id,
    user_id: userId,
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

let moveCards: Mock<MoveCardsFn>
let onMerged: Mock<(result: MergeSuccess) => void>

function renderButton(overrides?: { cardCount?: number; exams?: { id: string; name: string }[] }) {
  return render(
    <MergeExamButton
      userId={USER_ID}
      examId={SOURCE_EXAM_ID}
      cardCount={overrides?.cardCount ?? 2}
      exams={overrides?.exams ?? EXAMS}
      moveCards={moveCards}
      onMerged={onMerged}
    />,
  )
}

/** idle → confirm。 */
function expand() {
  fireEvent.click(screen.getByRole('button', { name: '結合' }))
}

const targetSelect = () => screen.getByLabelText('合流先の試験') as HTMLSelectElement
const mergeButton = () => screen.getByRole('button', { name: '結合する' })

beforeEach(async () => {
  vi.clearAllMocks()
  moveCards = vi.fn<MoveCardsFn>().mockResolvedValue(MOVE_OK)
  onMerged = vi.fn<(result: MergeSuccess) => void>()

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.exams.bulkPut([
    makeExam(SOURCE_EXAM_ID, '試験 A'),
    makeExam('exam-b', '試験 B'),
    makeExam('exam-c', '試験 C'),
  ])
  await db.cards.bulkPut([
    makeCard('c1', SOURCE_EXAM_ID, 1024),
    makeCard('c2', SOURCE_EXAM_ID, 2048),
    // 別 exam の card は結合対象に混ざらない
    makeCard('c3', 'exam-b', 1024),
    // 他 user の card は同じ exam_id を持っても混ざらない (CLAUDE.md Clerk 3)
    makeCard('c9', SOURCE_EXAM_ID, 3072, OTHER_USER_ID),
  ])
})

afterEach(() => {
  cleanup()
})

describe('MergeExamButton — 展開の可否', () => {
  it('cardCount = 0 の行では「結合」が disabled', () => {
    renderButton({ cardCount: 0 })

    expect(screen.getByRole('button', { name: '結合' })).toBeDisabled()
  })

  it('cardCount > 0 なら「結合」は押せる', () => {
    renderButton()

    expect(screen.getByRole('button', { name: '結合' })).toBeEnabled()
  })

  it('合流先候補が自分しかない場合も disabled (選べる合流先が無い)', () => {
    renderButton({ exams: [{ id: SOURCE_EXAM_ID, name: '試験 A' }] })

    expect(screen.getByRole('button', { name: '結合' })).toBeDisabled()
  })
})

describe('MergeExamButton — confirm 展開の中身', () => {
  it('合流先 select に自身が出ない', () => {
    renderButton()
    expand()

    const options = Array.from(targetSelect().options).map((o) => o.textContent)
    expect(options).toEqual(['試験 B', '試験 C'])
    expect(options).not.toContain('試験 A')
    // value 側でも自分自身が選択肢に無いこと (表示名が同じ exam があっても効く pin)
    expect(Array.from(targetSelect().options).map((o) => o.value)).not.toContain(SOURCE_EXAM_ID)
  })

  it('確認文言に件数と合流先名が入る (既定 = 候補の先頭)', () => {
    renderButton({ cardCount: 5 })
    expand()

    expect(
      screen.getByText('5枚を「試験 B」へ移動します。元の試験は空のまま残ります。'),
    ).toBeInTheDocument()
  })

  it('合流先を切り替えると確認文言の試験名も変わる', () => {
    renderButton()
    expand()

    fireEvent.change(targetSelect(), { target: { value: 'exam-c' } })

    expect(
      screen.getByText('2枚を「試験 C」へ移動します。元の試験は空のまま残ります。'),
    ).toBeInTheDocument()
  })

  it('配置の既定は末尾 (先頭は未選択)', () => {
    renderButton()
    expand()

    expect(screen.getByLabelText('末尾')).toBeChecked()
    expect(screen.getByLabelText('先頭')).not.toBeChecked()
  })

  it('キャンセルで idle に戻る (移動は発行しない)', () => {
    renderButton()
    expand()

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    expect(screen.getByRole('button', { name: '結合' })).toBeInTheDocument()
    expect(moveCards).not.toHaveBeenCalled()
  })
})

describe('MergeExamButton — 実行', () => {
  it('結合元の全 card を選んだ合流先へ末尾で移動する', async () => {
    renderButton()
    expand()
    fireEvent.change(targetSelect(), { target: { value: 'exam-c' } })

    fireEvent.click(mergeButton())

    await waitFor(() => expect(moveCards).toHaveBeenCalledTimes(1))
    const arg = moveCards.mock.calls[0][0]
    // 結合元の全件 (順序は問わない — 相対順は hook 内 domain が base_order で決める)。
    // 別 exam の c3 と他 user の c9 は含まない。
    expect([...arg.cardIds].sort()).toEqual(['c1', 'c2'])
    expect(arg.targetExamId).toBe('exam-c')
    expect(arg.placement).toEqual({ kind: 'end' })
  })

  it('「先頭」を選ぶと placement が start になる', async () => {
    renderButton()
    expand()
    fireEvent.click(screen.getByLabelText('先頭'))

    fireEvent.click(mergeButton())

    await waitFor(() => expect(moveCards).toHaveBeenCalledTimes(1))
    expect(moveCards).toHaveBeenCalledWith(
      expect.objectContaining({ targetExamId: 'exam-b', placement: { kind: 'start' } }),
    )
  })

  it('成功で onMerged に MoveResult を渡し、idle に戻る', async () => {
    renderButton()
    expand()

    fireEvent.click(mergeButton())

    await waitFor(() => expect(onMerged).toHaveBeenCalledWith(MOVE_OK))
    expect(await screen.findByRole('button', { name: '結合' })).toBeInTheDocument()
    expect(screen.queryByTestId('merge-exam-error')).not.toBeInTheDocument()
  })

  it('元 exam を削除しない・exams mirror に一切書かない (削除系 action も呼ばない)', async () => {
    // 削除だけでなく **書込系全般** を見る (fix round 1 / canonical Minor):
    // ① Table の書込 API を全て spy して 0 呼出 ② 内容 snapshot が完全一致
    //   (where().modify() など spy に乗らない経路も content 比較が捕まえる)
    // ③ 行の存在 ④ server action の削除も呼ばない。
    const db = getClientDb()
    const writeMethods = [
      'add',
      'put',
      'bulkAdd',
      'bulkPut',
      'update',
      'delete',
      'bulkDelete',
      'clear',
    ] as const
    const writeSpies = writeMethods.map((name) => [name, vi.spyOn(db.exams, name)] as const)
    const before = await db.exams.orderBy('id').toArray()

    renderButton()
    expand()
    fireEvent.click(mergeButton())

    await waitFor(() => expect(onMerged).toHaveBeenCalled())

    for (const [name, spy] of writeSpies) {
      expect(spy, `db.exams.${name} が呼ばれた`).not.toHaveBeenCalled()
    }
    expect(await db.exams.orderBy('id').toArray()).toEqual(before)
    expect(await db.exams.get(SOURCE_EXAM_ID)).toBeDefined()
    expect(mockDeleteExam).not.toHaveBeenCalled()

    for (const [, spy] of writeSpies) spy.mockRestore()
  })

  it('実行中は「結合中…」で disabled (二重 submit を state 側でも塞ぐ)', async () => {
    let resolveMove: (v: MoveResult) => void = () => {}
    moveCards.mockImplementation(
      () =>
        new Promise<MoveResult>((resolve) => {
          resolveMove = resolve
        }),
    )
    renderButton()
    expand()

    fireEvent.click(mergeButton())

    const pendingButton = await screen.findByRole('button', { name: '結合中…' })
    expect(pendingButton).toBeDisabled()

    await act(async () => {
      resolveMove(MOVE_OK)
    })
  })

  it('同一 tick に click が 2 発届いても moveCards は 1 回 (同期 ref ガード)', async () => {
    // fireEvent は 1 回ごとに act で再 render を flush するため、実ブラウザの
    // 「phase 更新が反映される前に 2 発目が届く」窓を再現しない。1 つの act の中で
    // native click を 2 発 dispatch して窓を作る (state だけのガードでは 2 回入る)。
    let resolveMove: (v: MoveResult) => void = () => {}
    moveCards.mockImplementation(
      () =>
        new Promise<MoveResult>((resolve) => {
          resolveMove = resolve
        }),
    )
    renderButton()
    expand()
    const btn = mergeButton()

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(moveCards).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveMove(MOVE_OK)
    })
  })
})

describe('MergeExamButton — 失敗 3 分岐', () => {
  it('reject (tx 失敗) は inline error にし、onMerged を呼ばない', async () => {
    moveCards.mockRejectedValue(new Error('tx failed'))
    renderButton()
    expand()

    fireEvent.click(mergeButton())

    await waitFor(() =>
      expect(screen.getByTestId('merge-exam-error')).toHaveTextContent('結合に失敗しました'),
    )
    expect(onMerged).not.toHaveBeenCalled()
  })

  it('no-cards は no-op (error を出さず idle へ戻す)', async () => {
    moveCards.mockResolvedValue({ ok: false, reason: 'no-cards' })
    renderButton()
    expand()

    fireEvent.click(mergeButton())

    expect(await screen.findByRole('button', { name: '結合' })).toBeInTheDocument()
    expect(screen.queryByTestId('merge-exam-error')).not.toBeInTheDocument()
    expect(onMerged).not.toHaveBeenCalled()
  })

  it('target-exam-missing は合流先を選び直させる inline error', async () => {
    moveCards.mockResolvedValue({ ok: false, reason: 'target-exam-missing' })
    renderButton()
    expand()

    fireEvent.click(mergeButton())

    await waitFor(() =>
      expect(screen.getByTestId('merge-exam-error')).toHaveTextContent(
        '合流先の試験が見つかりません',
      ),
    )
    expect(onMerged).not.toHaveBeenCalled()
  })

  it('error からの再試行で confirm に戻り、再実行できる', async () => {
    moveCards.mockRejectedValueOnce(new Error('tx failed'))
    renderButton()
    expand()
    fireEvent.click(mergeButton())
    await screen.findByTestId('merge-exam-error')

    fireEvent.click(screen.getByRole('button', { name: '再試行' }))
    expect(screen.queryByTestId('merge-exam-error')).not.toBeInTheDocument()

    fireEvent.click(mergeButton())
    await waitFor(() => expect(onMerged).toHaveBeenCalledWith(MOVE_OK))
    expect(moveCards).toHaveBeenCalledTimes(2)
  })
})
