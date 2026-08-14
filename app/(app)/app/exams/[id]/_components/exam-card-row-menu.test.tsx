// @vitest-environment jsdom
// ExamCardRowMenu + 取り込み picker の test (Grid-3 T7 / spec §7.2 / §7.4 / D-9)。
//
// 検証範囲 = 行メニューと picker が組み立てる **入力** だけ:
//   - menu に「ここに取り込む」が出る / gating 中は disabled + 理由
//   - picker が単一 source exam に閉じている (現 exam / 他 user の exam は候補外)
//   - checkbox リストが基準順 (compareByBaseOrder) で並ぶ
//   - 上限 (PULL_INTO_LIST_LIMIT) 超過ではリストを出さず一括バーへ誘導する
//   - 確定が onPullInto に渡す (cardIds, anchorId)
//   - onPullInto の返り値 (文言 / null) に対する dialog の開閉
//
// 実際の移動発行 (useMoveCards) と失敗 3 分岐の解釈は親の責務なので、ここでは
// onPullInto を spy にする (親側の pin は exam-card-table-pull-into.test.tsx)。
// mirror (exams / cards) は fake-indexeddb の実 read。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { ExamCardRowMenu, PULL_INTO_LIST_LIMIT } from './exam-card-row-menu'
import { POSITION_LOCKED_REASON } from './exam-card-move-popover'

const USER_ID = 'user-row-menu'
const CURRENT_EXAM = 'exam-current'
const SOURCE_EXAM = 'exam-source'
const OLD_EXAM = 'exam-old'
const ANCHOR_CARD = 'card-anchor'
const ROW_LABEL = 'アンカー行'

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

function makeCard(
  id: string,
  examId: string,
  baseOrder: number,
  label: string | null,
  overrides: Partial<ClientCard> = {},
): ClientCard {
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
    ...overrides,
  }
}

type Props = React.ComponentProps<typeof ExamCardRowMenu>

// 行の card = placement anchor。trigger の accessible name と picker の説明文の両方に使う。
const anchorRow = makeCard(ANCHOR_CARD, CURRENT_EXAM, 1024, 'A001', { title: ROW_LABEL })

function renderMenu(overrides: Partial<Props> = {}) {
  const props: Props = {
    userId: USER_ID,
    currentExamId: CURRENT_EXAM,
    anchorCard: anchorRow,
    positionLocked: false,
    pending: false,
    onPullInto: vi.fn(async () => null),
    ...overrides,
  }
  render(<ExamCardRowMenu {...props} />)
  return props
}

/** 行メニューを開く。 */
async function openMenu(overrides: Partial<Props> = {}) {
  const props = renderMenu(overrides)
  fireEvent.click(screen.getByRole('button', { name: `行メニュー: ${ROW_LABEL}` }))
  await screen.findByTestId('exam-card-row-menu')
  return props
}

/** 行メニュー → 「ここに取り込む」で picker を開き、source select の解決を待つ。 */
async function openPicker(overrides: Partial<Props> = {}) {
  const props = await openMenu(overrides)
  fireEvent.click(screen.getByRole('button', { name: 'ここに取り込む' }))
  await screen.findByTestId('exam-card-pull-into-dialog')
  await waitFor(() =>
    expect(within(sourceSelect()).getAllByRole('option').length).toBeGreaterThan(0),
  )
  return props
}

function sourceSelect(): HTMLSelectElement {
  return screen.getByLabelText('取り込み元の試験') as HTMLSelectElement
}

function cardCheckboxes(): HTMLInputElement[] {
  return within(screen.getByTestId('pull-into-card-list')).getAllByRole(
    'checkbox',
  ) as HTMLInputElement[]
}

beforeEach(async () => {
  vi.clearAllMocks()

  const db = getClientDb()
  await db.exams.clear()
  await db.cards.clear()
  await db.exams.bulkPut([
    makeExam(CURRENT_EXAM, '現在の試験', '2026-08-10T00:00:00.000Z'),
    makeExam(SOURCE_EXAM, '取り込み元の試験', '2026-08-12T00:00:00.000Z'),
    makeExam(OLD_EXAM, '古い試験', '2026-08-05T00:00:00.000Z'),
    // 他 user の exam は owner scope で出ない。
    makeExam('exam-alien', '他人の試験', '2026-08-13T00:00:00.000Z', 'other-user'),
  ])
  // source exam の基準順は card-s3 (1024) → card-s2 (2048) → card-s1 (4096)。
  // **id 昇順と基準順をわざと逆に**する: Dexie の index 読みは id 順で返るため、
  // 一致させると「基準順に並べ直している」ことを観測できない (sort 除去で red にならない)。
  await db.cards.bulkPut([
    makeCard('card-s3', SOURCE_EXAM, 1024, '0003'),
    makeCard('card-s2', SOURCE_EXAM, 2048, '0002'),
    makeCard('card-s1', SOURCE_EXAM, 4096, '0001'),
    anchorRow,
    makeCard('card-cur2', CURRENT_EXAM, 2048, 'A002'),
    makeCard('card-o1', OLD_EXAM, 1024, 'O001'),
  ])
})

afterEach(() => cleanup())

// ===========================================================================
// menu 本体
// ===========================================================================

describe('行メニュー', () => {
  it('trigger で開き「ここに取り込む」が (唯一の項目として) 出る', async () => {
    await openMenu()

    const menu = screen.getByTestId('exam-card-row-menu')
    const item = within(menu).getByRole('button', { name: 'ここに取り込む' })
    expect(item).toBeEnabled()
    // 将来の項目追加を先取りしない (spec §7.2: 項目は当面 1 つ)。
    expect(within(menu).getAllByRole('button')).toHaveLength(1)
  })

  it('項目 click で menu が閉じ picker が開く', async () => {
    await openMenu()

    fireEvent.click(screen.getByRole('button', { name: 'ここに取り込む' }))

    expect(await screen.findByTestId('exam-card-pull-into-dialog')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-row-menu')).not.toBeInTheDocument(),
    )
  })

  it('picker に anchor 行のラベルを出す (どの行の直後に入るか)', async () => {
    await openPicker()

    // 行の card は question_label = 'A001' (title ではなくこちらを先頭部として出す)。
    expect(
      within(screen.getByTestId('exam-card-pull-into-dialog')).getByText(
        /「A001」の直後に移動します/,
      ),
    ).toBeInTheDocument()
  })

  it('取り込み元の候補がゼロなら picker が案内を出す', async () => {
    const db = getClientDb()
    await db.exams.clear()
    await db.exams.put(makeExam(CURRENT_EXAM, '現在の試験', '2026-08-10T00:00:00.000Z'))
    await openMenu()

    fireEvent.click(screen.getByRole('button', { name: 'ここに取り込む' }))

    expect(await screen.findByText('取り込める試験がありません。')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-row-menu')).not.toBeInTheDocument(),
    )
  })
})

// ===========================================================================
// gating (§7.4) — 文言は移動 popover (a) と同一定数
// ===========================================================================

describe('ソート/フィルタ gating', () => {
  it('positionLocked で項目が disabled になり理由が出る (title / aria-disabled 付き)', async () => {
    await openMenu({ positionLocked: true })

    const item = screen.getByRole('button', { name: 'ここに取り込む' })
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAttribute('title', POSITION_LOCKED_REASON)
    expect(screen.getByText(POSITION_LOCKED_REASON)).toBeInTheDocument()
  })

  it('gating なしなら理由を出さない', async () => {
    await openMenu()

    expect(screen.getByRole('button', { name: 'ここに取り込む' })).toBeEnabled()
    expect(screen.queryByText(POSITION_LOCKED_REASON)).not.toBeInTheDocument()
  })
})

// ===========================================================================
// picker: source exam (D-9 — 1 操作 1 exam)
// ===========================================================================

describe('取り込み元の試験', () => {
  it('自分の exam を updated_at desc で並べ、現 exam は候補に出さない', async () => {
    await openPicker()

    const options = within(sourceSelect()).getAllByRole('option') as HTMLOptionElement[]
    // 現 exam (取り込み先自身) と他 user の exam は候補外。
    expect(options.map((o) => o.value)).toEqual([SOURCE_EXAM, OLD_EXAM])
    expect(sourceSelect().value).toBe(SOURCE_EXAM)
  })

  it('source exam の select は 1 つだけ (1 操作 = 1 source exam)', async () => {
    await openPicker()

    const dialog = screen.getByTestId('exam-card-pull-into-dialog')
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1)
  })

  it('source を切り替えると、前の exam で選んだ card は渡らない (1 操作 1 exam)', async () => {
    const props = await openPicker()
    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))
    fireEvent.click(cardCheckboxes()[0]) // SOURCE_EXAM の card-s3

    fireEvent.change(sourceSelect(), { target: { value: OLD_EXAM } })
    await waitFor(() => expect(cardCheckboxes()).toHaveLength(1))
    fireEvent.click(cardCheckboxes()[0]) // OLD_EXAM の card-o1
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    // 複数 exam を跨いだ cardIds を渡すと useMoveCards が throw する (spec D-9)。
    await waitFor(() =>
      expect(props.onPullInto).toHaveBeenCalledWith(['card-o1'], ANCHOR_CARD),
    )
  })
})

// ===========================================================================
// picker: カードの並び
// ===========================================================================

describe('カードの checkbox リスト', () => {
  it('source exam のカードを基準順で並べ、question_label を表示する', async () => {
    await openPicker()

    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))
    const boxes = cardCheckboxes()
    // 基準順 (base_order 昇順) = id 順とは逆。
    expect(boxes.map((b) => b.value)).toEqual(['card-s3', 'card-s2', 'card-s1'])
    expect(
      boxes.map((b) => (b.closest('label') as HTMLElement).textContent?.trim()),
    ).toEqual(['0003', '0002', '0001'])
  })

  it('カードが 0 件の exam を選ぶと空の案内を出す', async () => {
    await openPicker()

    fireEvent.change(sourceSelect(), { target: { value: OLD_EXAM } })
    await getClientDb().cards.delete('card-o1')

    expect(await screen.findByText('この試験にはカードがありません。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled()
  })

  it('question_label が無いカードは title で代替する', async () => {
    await getClientDb().cards.put(
      makeCard('card-s0', SOURCE_EXAM, 512, null, { title: 'タイトルのみ' }),
    )
    await openPicker()

    await waitFor(() => expect(cardCheckboxes()).toHaveLength(4))
    expect(
      (cardCheckboxes()[0].closest('label') as HTMLElement).textContent?.trim(),
    ).toBe('タイトルのみ')
  })
})

// ===========================================================================
// 大量件数の保護 (境界: LIMIT ちょうど / LIMIT + 1)
// ===========================================================================

describe('リスト表示の上限', () => {
  async function seedBigExam(count: number) {
    const db = getClientDb()
    // 既定 (updated_at desc の先頭) になるよう最新にする。
    await db.exams.put(makeExam('exam-big', '大量の試験', '2026-08-20T00:00:00.000Z'))
    await db.cards.bulkPut(
      Array.from({ length: count }, (_, i) =>
        makeCard(`card-big-${i}`, 'exam-big', (i + 1) * 1024, `B${i}`),
      ),
    )
  }

  it(`${PULL_INTO_LIST_LIMIT} 件ちょうどは checkbox リストを出す`, async () => {
    await seedBigExam(PULL_INTO_LIST_LIMIT)
    await openPicker()

    await waitFor(() => expect(cardCheckboxes()).toHaveLength(PULL_INTO_LIST_LIMIT))
    expect(screen.queryByTestId('pull-into-over-limit')).not.toBeInTheDocument()
  })

  it(`${PULL_INTO_LIST_LIMIT + 1} 件は checkbox リストを出さず一括バーへ誘導する`, async () => {
    await seedBigExam(PULL_INTO_LIST_LIMIT + 1)
    await openPicker()

    await waitFor(() =>
      expect(screen.getByTestId('pull-into-over-limit')).toHaveTextContent(
        '一括バーの「移動」を使ってください',
      ),
    )
    expect(screen.queryByTestId('pull-into-card-list')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled()
  })
})

// ===========================================================================
// 確定
// ===========================================================================

describe('取り込みの確定', () => {
  it('選んだカードを基準順で、行の card を anchor にして onPullInto へ渡す', async () => {
    const props = await openPicker()
    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))

    // 基準順の後ろ → 前 の順に選ぶ (渡す配列が選択順ではなく基準順である pin)。
    fireEvent.click(cardCheckboxes()[2]) // card-s1
    fireEvent.click(cardCheckboxes()[0]) // card-s3
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(props.onPullInto).toHaveBeenCalledWith(['card-s3', 'card-s1'], ANCHOR_CARD),
    )
  })

  it('未選択では確定できない', async () => {
    await openPicker()

    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled()
  })

  it('完了 (null) で dialog を閉じる', async () => {
    const onPullInto = vi.fn(async () => null)
    await openPicker({ onPullInto })
    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))
    fireEvent.click(cardCheckboxes()[0])

    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
  })

  it('文言が返ったら dialog 内 inline error に出し、開いたまま再試行できる', async () => {
    const onPullInto = vi.fn(async () => '移動に失敗しました。しばらくしてから再度お試しください。')
    await openPicker({ onPullInto })
    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))
    fireEvent.click(cardCheckboxes()[0])

    fireEvent.click(screen.getByRole('button', { name: '取り込む' }))

    await waitFor(() =>
      expect(screen.getByTestId('pull-into-error')).toHaveTextContent('移動に失敗しました'),
    )
    expect(screen.getByTestId('exam-card-pull-into-dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取り込む' })).toBeEnabled()
  })

  it('pending 中は確定 button と入力が disabled (実行中 flag は親が持つ)', async () => {
    await openPicker({ pending: true })

    await waitFor(() => expect(cardCheckboxes()).toHaveLength(3))
    fireEvent.click(cardCheckboxes()[0])
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled()
    expect(sourceSelect()).toBeDisabled()
    expect(cardCheckboxes()[0]).toBeDisabled()
  })

  it('キャンセルで閉じ、onPullInto は呼ばない', async () => {
    const props = await openPicker()

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
    expect(props.onPullInto).not.toHaveBeenCalled()
  })

  it('Escape で閉じる (ConfirmDialog と同じ既定)', async () => {
    await openPicker()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
  })

  it('backdrop click で閉じる', async () => {
    await openPicker()

    fireEvent.click(screen.getByTestId('pull-into-backdrop'))

    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-pull-into-dialog')).not.toBeInTheDocument(),
    )
  })

  it('閉じたら focus が行メニューの trigger に戻る', async () => {
    // 復帰先を dialog の mount 時 activeElement (= 同 commit で消える menu 項目) から
    // 取ると detached node への focus() = no-op になり activeElement が body へ落ちる。
    await openPicker()

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: `行メニュー: ${ROW_LABEL}` }),
      ),
    )
  })
})
