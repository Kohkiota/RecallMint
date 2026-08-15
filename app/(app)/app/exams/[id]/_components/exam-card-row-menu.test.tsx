// @vitest-environment jsdom
// ExamCardRowMenu (二役グリップ + 行メニュー) + 取り込み picker の test
// (Grid-3 T7 / spec §7.2 / §7.4 / D-9 + row-ux spec §2 / §4 / §5)。
//
// 検証範囲 = grip の二役構造と、行メニュー / picker が組み立てる **入力** だけ:
//   - grip click で menu が開き「開く」「ここに取り込む」が (この順で) 出る
//   - drag 役の gating (dragEnabled のときだけ dnd semantics / locked は理由提示)
//   - picker が単一 source exam に閉じている (現 exam / 他 user の exam は候補外)
//   - checkbox リストが基準順 (compareByBaseOrder) で並ぶ
//   - 上限 (PULL_INTO_LIST_LIMIT) 超過ではリストを出さず一括バーへ誘導する
//   - 確定が onPullInto に渡す (cardIds, anchorId)
//   - onPullInto の返り値 (文言 / null) に対する dialog の開閉
//
// 実際の移動発行 (useMoveCards) と失敗 3 分岐の解釈は親の責務なので、ここでは
// onPullInto を spy にする (親側の pin は exam-card-table-pull-into.test.tsx)。
// mirror (exams / cards) は fake-indexeddb の実 read。
//
// drag 役の test は **real DndContext / real SortableContext + SortableRow** の下で行う:
// attributes / listeners が実物の dnd-kit 出力でなければ aria の pin が意味を持たない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  act,
  render,
  screen,
  cleanup,
  createEvent,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { ROW_DND_SR_INSTRUCTIONS } from '@/lib/dnd/accessibility'
import {
  useSortableSensors,
  type SortableSensorOptions,
} from '@/lib/dnd/use-sortable-sensors'
import { cardLabel, ExamCardRowMenu, PULL_INTO_LIST_LIMIT } from './exam-card-row-menu'
import { POSITION_LOCKED_REASON } from './exam-card-move-popover'
import { ROW_DND_LOCKED_REASON, SortableRow } from './exam-card-row-dnd'

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

const GRIP_LABEL = `行の操作: ${ROW_LABEL}`
const LOCKED_REASON_ID = 'row-dnd-locked-reason-test-id'

// exam-card-table.tsx の ROW_DND_SENSOR_OPTIONS と同値。 table 側は module 定数を export
// しない (test 専用 API を生やさない) ため、 harness は同じ値を写して production と同じ
// sensor 構成 (Enter は start に含めない = menu 用に残す) を再現する。
const ROW_DND_SENSOR_OPTIONS: SortableSensorOptions = {
  mouseActivationConstraint: { distance: 4 },
  keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] },
}

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    userId: USER_ID,
    currentExamId: CURRENT_EXAM,
    anchorCard: anchorRow,
    positionLocked: false,
    pending: false,
    onPullInto: vi.fn(async () => null),
    openCard: vi.fn(),
    ...overrides,
  }
}

function renderMenu(overrides: Partial<Props> = {}) {
  const props = makeProps(overrides)
  render(<ExamCardRowMenu {...props} />)
  return props
}

/**
 * 本番と同じ入れ子 (DndContext > SortableContext > SortableRow > td > grip) で render する。
 * gating 3 値は SortableRow に渡すもの = 「今この行がドラッグできるか」の入力。
 * lockedReasonId の参照先 <p> は table が持つ要素 (exam-card-table.tsx) の代役。
 */
function renderMenuInRow({
  dragAvailable = true,
  locked = false,
  pending = false,
  outerOnClick,
  ...overrides
}: Partial<Props> & {
  dragAvailable?: boolean
  locked?: boolean
  pending?: boolean
  outerOnClick?: () => void
} = {}) {
  const props = makeProps(overrides)
  function Harness() {
    const sensors = useSortableSensors(ROW_DND_SENSOR_OPTIONS)
    return (
      <DndContext
        sensors={sensors}
        accessibility={{ screenReaderInstructions: ROW_DND_SR_INSTRUCTIONS }}
      >
        <SortableContext items={[ANCHOR_CARD]} strategy={verticalListSortingStrategy}>
          <table>
            <tbody>
              <SortableRow
                cardId={ANCHOR_CARD}
                index={0}
                dragAvailable={dragAvailable}
                locked={locked}
                pending={pending}
                lockedReasonId={LOCKED_REASON_ID}
                measureElement={() => {}}
              >
                {/* select td 全域の onClick (行選択トグル) の代役。 */}
                <td onClick={outerOnClick}>
                  <ExamCardRowMenu {...props} />
                </td>
              </SortableRow>
            </tbody>
          </table>
          <p id={LOCKED_REASON_ID} className="sr-only">
            {ROW_DND_LOCKED_REASON}
          </p>
        </SortableContext>
      </DndContext>
    )
  }
  render(<Harness />)
  return props
}

function grip(): HTMLElement {
  return screen.getByRole('button', { name: GRIP_LABEL })
}

/** aria-describedby の参照先要素の text を解決する (id の存在だけでは弱いため)。 */
function describedByTexts(el: HTMLElement): string[] {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
}

/** 行メニューを開く。 */
async function openMenu(overrides: Partial<Props> = {}) {
  const props = renderMenu(overrides)
  fireEvent.click(grip())
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
  it('grip click で開き「開く」「ここに取り込む」の 2 項目がこの順で出る', async () => {
    await openMenu()

    const menu = screen.getByTestId('exam-card-row-menu')
    const items = within(menu).getAllByRole('button')
    // 項目は 2 つだけ (row-ux §5: 将来の項目追加を先取りしない)。順序も契約。
    expect(items.map((el) => el.textContent)).toEqual(['開く', 'ここに取り込む'])
    expect(within(menu).getByRole('button', { name: 'ここに取り込む' })).toBeEnabled()
  })

  it('openCard 未配線では「開く」項目を描画しない (「ここに取り込む」のみ)', async () => {
    await openMenu({ openCard: undefined })

    const menu = screen.getByTestId('exam-card-row-menu')
    expect(within(menu).queryByRole('button', { name: '開く' })).not.toBeInTheDocument()
    expect(within(menu).getAllByRole('button')).toHaveLength(1)
  })

  it('「開く」click で openCard(card.id) が 1 回呼ばれ menu が閉じる', async () => {
    const props = await openMenu()

    fireEvent.click(screen.getByRole('button', { name: '開く' }))

    expect(props.openCard).toHaveBeenCalledTimes(1)
    expect(props.openCard).toHaveBeenCalledWith(ANCHOR_CARD)
    await waitFor(() =>
      expect(screen.queryByTestId('exam-card-row-menu')).not.toBeInTheDocument(),
    )
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

  it('閉じたら focus が grip (trigger) に戻る', async () => {
    // 復帰先を dialog の mount 時 activeElement (= 同 commit で消える menu 項目) から
    // 取ると detached node への focus() = no-op になり activeElement が body へ落ちる。
    await openPicker()

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    await waitFor(() => expect(document.activeElement).toBe(grip()))
  })
})

// ===========================================================================
// 二役グリップ (row-ux §2 / §4) — drag 役の gating と menu 役の生存
//
// dragAvailable = この試験で並べ替えが意味を持つか / dragEnabled = 今ドラッグできるか。
// dnd の semantics は dragEnabled のときだけ付き、menu 役はどの状態でも生きている。
// ===========================================================================

describe('二役グリップ — dragEnabled (行 2 枚以上・非 locked・非 pending)', () => {
  it('dnd の semantics が付く: aria-roledescription="sortable" + describedby が日本語 instructions を指す', () => {
    renderMenuInRow()

    expect(grip()).toHaveAttribute('aria-roledescription', 'sortable')
    // id の存在だけでは弱い (参照先が消えても通る)。実文言まで解決する。
    expect(describedByTexts(grip())).toEqual([ROW_DND_SR_INSTRUCTIONS.draggable])
  })

  it('grip は native disabled ではなく aria-disabled も持たない (menu 役が常に生きている)', () => {
    renderMenuInRow()

    expect(grip()).toBeEnabled()
    expect(grip()).not.toHaveAttribute('aria-disabled')
    expect(grip()).not.toHaveAttribute('title')
  })

  it('touch-none は grip のみに付く (行 / 他要素には付けない = event 分離契約)', () => {
    renderMenuInRow()

    const touchNoneEls = document.body.querySelectorAll('[class~="touch-none"]')
    expect(touchNoneEls).toHaveLength(1)
    expect(touchNoneEls[0]).toBe(grip())
  })

  it('grip click で menu が開き、外側 (select td) の onClick は発火しない (stopPropagation)', async () => {
    const outerOnClick = vi.fn()
    renderMenuInRow({ outerOnClick })

    fireEvent.click(grip())

    expect(await screen.findByTestId('exam-card-row-menu')).toBeInTheDocument()
    expect(outerOnClick).not.toHaveBeenCalled()
  })

  it('Space keydown は preventDefault される (掴む = native click 不発生 → menu は開かない)', async () => {
    renderMenuInRow()

    const event = createEvent.keyDown(grip(), { code: 'Space', key: ' ' })
    fireEvent(grip(), event)

    expect(event.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('exam-card-row-menu')).not.toBeInTheDocument()

    // 掴んだ KeyboardSensor は document へ keydown listener を張る (setTimeout 経由) ため、
    // 掴んだまま test を抜けると次の test の keydown まで拾ってしまう。 unmount 前に
    // Escape で取り消して sensor を detach させる。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
  })

  it('Enter keydown は preventDefault されない (native click が生きて menu 役に回る)', () => {
    renderMenuInRow()

    const event = createEvent.keyDown(grip(), { code: 'Enter', key: 'Enter' })
    fireEvent(grip(), event)

    // jsdom は keydown → click の native 連鎖を合成しないため、ここでは「掴みに
    // 取られていない」ことだけを pin する (menu が開くこと自体は click の test 側)。
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('二役グリップ — locked (ソート/フィルタ適用中)', () => {
  it('dnd semantics が消え、title + describedby が並べ替え不能の理由だけを指す', () => {
    renderMenuInRow({ locked: true })

    expect(grip()).not.toHaveAttribute('aria-roledescription')
    expect(grip()).toHaveAttribute('title', ROW_DND_LOCKED_REASON)
    // 単独 pin: dnd 側 id が同居しない (dragEnabled でないので instructions は指さない)。
    expect(grip().getAttribute('aria-describedby')).toBe(LOCKED_REASON_ID)
    expect(describedByTexts(grip())).toEqual([ROW_DND_LOCKED_REASON])
  })

  it('menu 役は生きている (grip は enabled で click すると menu が開く)', async () => {
    renderMenuInRow({ locked: true })

    expect(grip()).toBeEnabled()
    expect(grip()).not.toHaveAttribute('aria-disabled')
    fireEvent.click(grip())

    expect(await screen.findByTestId('exam-card-row-menu')).toBeInTheDocument()
  })
})

describe('二役グリップ — pending (移動実行中)', () => {
  it('dnd semantics が消え、理由の提示もしない (一時状態)', () => {
    renderMenuInRow({ pending: true })

    expect(grip()).not.toHaveAttribute('aria-roledescription')
    expect(grip()).not.toHaveAttribute('title')
    expect(grip()).not.toHaveAttribute('aria-describedby')
    expect(grip()).toBeEnabled()
  })
})

describe('二役グリップ — drag 役なし', () => {
  it('dragAvailable:false (1 枚の試験) でも grip は描画され menu は開く (dnd semantics のみ消える)', async () => {
    renderMenuInRow({ dragAvailable: false })

    expect(grip()).not.toHaveAttribute('aria-roledescription')
    expect(grip()).not.toHaveAttribute('aria-describedby')
    fireEvent.click(grip())

    expect(await screen.findByTestId('exam-card-row-menu')).toBeInTheDocument()
  })

  it('provider 不在 (SortableRow 外) でも menu 専用 trigger として成立する', async () => {
    renderMenu()

    expect(grip()).not.toHaveAttribute('aria-roledescription')
    expect(grip()).toBeEnabled()
    fireEvent.click(grip())

    expect(await screen.findByTestId('exam-card-row-menu')).toBeInTheDocument()
  })

  it('dragAvailable:false なら locked でも理由を出さない (解除しても並べ替えられない行に誤案内しない)', () => {
    // 理由文言は「解除すると並べ替えられます」と言うので、1 枚の試験 (= 解除しても
    // 並べ替えられない) の行に出すと誤案内になる。 title / describedby とも
    // dragAvailable かつ locked のときだけ付く。
    renderMenuInRow({ dragAvailable: false, locked: true })

    expect(grip()).not.toHaveAttribute('title')
    expect(grip()).not.toHaveAttribute('aria-describedby')
    expect(grip()).not.toHaveAttribute('aria-roledescription')
  })
})

// ===========================================================================
// cardLabel — picker の checkbox と DnD 読み上げが共有する表示名の解決
// ===========================================================================

describe('cardLabel', () => {
  it('question_label が空白のみなら title に落ちる (`??` 単独では左辺が選ばれてしまう)', () => {
    // 空文字は編集経路が null 正規化するが、空白のみはすり抜けて mirror に残る。
    expect(
      cardLabel(makeCard('card-ws', SOURCE_EXAM, 1024, '   ', { title: 'タイトルのみ' })),
    ).toBe('タイトルのみ')
  })

  it('question_label / title が両方空白なら「(無題)」', () => {
    expect(cardLabel(makeCard('card-empty', SOURCE_EXAM, 1024, '  ', { title: ' ' }))).toBe(
      '(無題)',
    )
  })
})
