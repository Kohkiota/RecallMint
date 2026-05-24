// @vitest-environment jsdom
// SessionRunner client component の test (S2.2.3 T1 で 3-button nav 拡張)。
//
// Phase machine: selecting → judged → finished
// - selecting (両モード共通): opt click + 「回答する」 で判定のみ (submit せず) → judged 遷移
//   3 button footer: 「← 前へ」 / 「回答する」 (primary) / 「次へ →」 (skip)
// - judged (通常): 3 button footer: 「← 前へ」 / 「↺ リトライ」 / 「次へ →」 (primary, auto submit)
// - judged (FSRS): 上段 4 rate (Again/Hard/Good/Easy) で submit + lastRating セット (自動次へなし)
//   下段 3 nav: 「← 前へ」 / 「↺ リトライ」 / 「次へ →」 (rate 後のみ enable、 submit なし純遷移)
// - finished: 統計 + もう一度 / ダッシュボードへ
//
// submitReview / next/navigation は mock。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { Card } from '@/lib/db/schema'

// -----------------------------------------------------------------------
// Hoisted mocks
// -----------------------------------------------------------------------
const { mockRefresh, mockSubmitReview } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockSubmitReview: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

vi.mock('../_actions/submit-review', () => ({
  submitReview: mockSubmitReview,
}))

// -----------------------------------------------------------------------
// Import under test (after mocks)
// -----------------------------------------------------------------------
import { SessionRunner } from './session-runner'

// -----------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------
function makeCard(overrides?: Partial<Card>): Card {
  return {
    id: 'card-1',
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    title: '問1',
    sortKey: null,
    questionText: '問題文テキスト',
    options: [
      { id: 'a', text: '選択肢A', is_correct: false },
      { id: 'b', text: '選択肢B', is_correct: true, explanation: '選択肢B解説' },
    ],
    correctAnswerIds: ['b'],
    explanationText: 'カード全体の解説',
    memo: null,
    images: [],
    customProps: {},
    tags: [],
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    due: new Date('2020-01-01'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
    ...overrides,
  } as Card
}

beforeEach(() => {
  vi.clearAllMocks()
  // submitReview のデフォルトは ok=true。 戻り値 data.correct は client では使わないため
  // shape 互換性のためにのみ含める。
  mockSubmitReview.mockResolvedValue({ ok: true, data: { correct: true } })
})

afterEach(() => {
  cleanup()
})

// -----------------------------------------------------------------------
// 共通 helper
// -----------------------------------------------------------------------
function clickOption(text: string) {
  // opt は button role (selecting 中 click 可能)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(text) }))
}

// label の揺れに耐える regex で 3 nav button を取得 (icon + 「前へ」 等)
const NAME_PREV = /前へ/
const NAME_NEXT = /次へ/
const NAME_RETRY = /リトライ/

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------
describe('SessionRunner (3-button nav, S2.2.3 T1)', () => {
  it('初期描画: 問題文 + 選択肢 + 3 button (前へ disabled / 回答する disabled / 次へ enabled)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    expect(screen.getByText('問題文テキスト')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択肢A/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択肢B/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    // idx=0 で「前へ」 disabled、 「次へ」 (skip) は常時 enabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('opt click で selectedIds 追加、 再 click で削除 (toggle)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    const optA = screen.getByRole('button', { name: /選択肢A/ })
    fireEvent.click(optA)
    expect(optA).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(optA)
    expect(optA).toHaveAttribute('aria-pressed', 'false')
  })

  it('1 件以上選択で 「回答する」 が enabled (通常モード)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('selecting (両モード共通): FSRS モードでも footer は 3 button、 rate ボタンは存在しない', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    // selecting では 4 rate ボタン無し
    expect(screen.queryByRole('button', { name: 'Again' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Good' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Easy' })).not.toBeInTheDocument()
  })

  it('1 件以上選択で 「回答する」 が enabled (FSRS モードも同じ)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    clickOption('選択肢B')
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('通常モード: 「回答する」 押下時に submitReview は呼ばれず、 judged 遷移 + 解説 + 3 button (前へ/リトライ/次へ) 表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    // judged phase: 解説 + 3 nav
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    expect(screen.getByText(/正解/)).toBeInTheDocument()
    // 「回答する」 は judged では消える
    expect(screen.queryByRole('button', { name: '回答する' })).not.toBeInTheDocument()
    // submit は呼ばれない (判定のみ)
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it('通常モード: 誤答選択 → 「回答する」 で判定のみ (submit せず) + 不正解表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    expect(screen.getByText(/不正解/)).toBeInTheDocument()
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it('通常モード: judged 「次へ」 で submitReview(rating=3) が呼ばれ次 card に遷移 (correct 時)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 「次へ」 押下が submit を起動
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 3)
    })
    // 問2 に進んでいる
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
  })

  it('通常モード: judged 「次へ」 で submitReview(rating=1) (incorrect 時)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)

    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 1)
    })
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
  })

  it('通常モード: 「次へ」 submit error 時 (fire-and-forget): 次 card に即遷移 + error 表示 (judged 巻き戻さない)', async () => {
    // fire-and-forget 化: 「次へ」 押下で submit 結果を待たず即 next card に進む。
    // submit が失敗しても judged 巻き戻しなし、 失敗 error を次 card 上で表示する。
    mockSubmitReview.mockResolvedValueOnce({ ok: false, error: 'サーバーエラー' })
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    // 即 next card に遷移 (await なし、 fire-and-forget)
    expect(screen.getByText('問2')).toBeInTheDocument()
    // submit は呼ばれている
    expect(mockSubmitReview).toHaveBeenCalledWith('c1', 3)

    // submit 失敗の error が次 card 上に表示される
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('サーバーエラー')
    })
  })

  it('FSRS モード: 「回答する」 押下時に submitReview は呼ばれず、 judged 遷移 + 4 rate + 3 nav (下段) 表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 上段 4 rate
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Good' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Easy' })).toBeInTheDocument()
    // 下段 3 nav (前へ / リトライ / 次へ)
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    // 「回答する」 は消える
    expect(screen.queryByRole('button', { name: '回答する' })).not.toBeInTheDocument()
    // rate 未押下 → 「前へ」 (idx=0 でもあり) / 「次へ」 disabled、 「リトライ」 enabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_RETRY })).not.toBeDisabled()
    // submit はまだ呼ばれない
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it('FSRS モード: judged Hard 押下で submitReview(rating=2) (自動次へなし、 judged 維持)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // judged で Hard 押下 → submit (但し自動次へなし)
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 2)
    })
    // judged 維持 (問1 のまま)、 「次へ」 が enable に変わる
    expect(screen.getByText('問1')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
  })

  it('FSRS モード: rate 後 「次へ」 押下で submit せず純遷移 + selecting reset', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    // Good 1 回で submit
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('c1', 3))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })

    // 「次へ」 押下 → submit 追加なし、 問2 遷移
    const callsBefore = mockSubmitReview.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    expect(mockSubmitReview.mock.calls.length).toBe(callsBefore)
    // selecting reset (「回答する」 disabled に戻る)
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
  })

  it('FSRS モード: Again/Good/Easy それぞれで submitReview(rating=1|3|4) 呼出 (連続 unmount)', async () => {
    {
      const { unmount } = render(
        <SessionRunner cards={[makeCard({ id: 'cA' })]} fsrsMode={true} />,
      )
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Again' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('cA', 1))
      unmount()
    }
    {
      const { unmount } = render(
        <SessionRunner cards={[makeCard({ id: 'cG' })]} fsrsMode={true} />,
      )
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Good' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('cG', 3))
      unmount()
    }
    {
      render(<SessionRunner cards={[makeCard({ id: 'cE' })]} fsrsMode={true} />)
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('cE', 4))
    }
  })

  it('FSRS モード: rate submit error 時 (fire-and-forget + Optimistic): judged 維持 + error UI + 4 ボタン enable のまま、 lastRating は optimistic セット済で 「次へ」 enable (user は次 card に進める)', async () => {
    // Optimistic 化: rate click 時に lastRating は即セットされ、 server 失敗でも
    // rollback しない (= last write wins、 user は次 card に進めるか rate 再押下で
    // 上書き submit が可能)。 4 rate / 3 nav ボタンは pending で disable しない仕様。
    mockSubmitReview.mockResolvedValueOnce({ ok: false, error: 'rate 失敗' })
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('rate 失敗')
    })
    // judged 維持 (解説 + 4 ボタン残置)
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 4 ボタンは常時 enable (pending gate 撤回)、 再押下で上書き submit 可
    expect(screen.getByRole('button', { name: 'Again' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Hard' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Good' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Easy' })).not.toBeDisabled()
    // Optimistic: lastRating は click 時に Good 固定済、 「次へ」 enable
    // (失敗時 rollback なし、 user は次に進める = MVP UX)
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('B2 fix: opt.id と一致する先頭 ID prefix (例 "1誤正正誤") を strip し、 ID は太字 span で 1 回だけ表示', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1誤正正誤', is_correct: false },
        { id: '2', text: '2正解候補', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)

    expect(screen.queryByText('1誤正正誤', { exact: true })).not.toBeInTheDocument()
    const opt1Btn = screen.getByRole('button', { name: /誤正正誤/ })
    expect(opt1Btn).toBeInTheDocument()
    const idSpans = opt1Btn.querySelectorAll('span.font-medium')
    const idSpansWith1 = Array.from(idSpans).filter((s) => s.textContent === '1')
    expect(idSpansWith1).toHaveLength(1)
  })

  it('B2 fix (review I-1 A 案): ID 直後が数字の場合は同一 token とみなし strip しない ("1990s" 保全)', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1990s', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    const opt1Btn = screen.getByRole('button', { name: /1990s/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: "1) 答え" 形式 (ID + 閉じ括弧 + 半角 space) も strip', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1) 答え', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    const opt1Btn = screen.getByRole('button', { name: /^○?\s*1\s*答え$/ })
    expect(opt1Btn).toBeInTheDocument()
    expect(screen.queryByText('1) 答え', { exact: true })).not.toBeInTheDocument()
  })

  it('B2 fix: "1. 答え" 形式 (ID + 半角ドット) も strip', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1. 答え', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    expect(screen.queryByText('1. 答え', { exact: true })).not.toBeInTheDocument()
    const opt1Btn = screen.getByRole('button', { name: /答え/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: "1 答え" 形式 (ID + 半角 space) も strip', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1 答え', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    expect(screen.queryByText('1 答え', { exact: true })).not.toBeInTheDocument()
    const opt1Btn = screen.getByRole('button', { name: /答え/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: opt.text が opt.id で始まらない場合 (例 "単独") は strip しない', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '単独', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    const opt1Btn = screen.getByRole('button', { name: /単独/ })
    expect(opt1Btn).toBeInTheDocument()
  })

  it('B2 fix: 2 桁 ID ("12誤正" + opt.id="12") も startsWith マッチで strip', () => {
    const card = makeCard({
      options: [
        { id: '12', text: '12誤正', is_correct: false },
        { id: '13', text: '13正解', is_correct: true },
      ],
      correctAnswerIds: ['13'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    expect(screen.queryByText('12誤正', { exact: true })).not.toBeInTheDocument()
    const opt12Btn = screen.getByRole('button', { name: /誤正/ })
    expect(opt12Btn).toBeInTheDocument()
  })

  it('B2 fix (review I-1 trade-off 犠牲ケース): "1.5g" は ID + ドット strip 規則に従い "5g" 表示 (OT 承認済)', () => {
    const card = makeCard({
      options: [
        { id: '1', text: '1.5g', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    const opt1Btn = screen.getByRole('button', { name: /5g/ })
    expect(opt1Btn).toBeInTheDocument()
    expect(screen.queryByText('1.5g', { exact: true })).not.toBeInTheDocument()
  })

  it('judged 後: 正答 opt に ○、 非正答 opt に × mark', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByText('○')).toBeInTheDocument()
    expect(screen.getByText('×')).toBeInTheDocument()
  })

  it('judged 後 opt click は無効 (selectedIds 変わらない)', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()

    const optB = screen.getByRole('button', { name: /選択肢B/ })
    expect(optB).toBeDisabled()
  })

  it('3 枚連続 (通常モード) → 完了画面 (3/2/67%)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
      makeCard({ id: 'c3', questionText: '問3' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)

    // Card 1: 正答 → 回答する → 次へ (submit)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    // Card 2: 正答
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    // Card 3: 誤答
    await waitFor(() => expect(screen.getByText('問3')).toBeInTheDocument())
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() => {
      expect(screen.getByText('🎉')).toBeInTheDocument()
      expect(screen.getByText(/3 枚/)).toBeInTheDocument()
      expect(screen.getByText(/2 正解/)).toBeInTheDocument()
      expect(screen.getByText(/67%/)).toBeInTheDocument()
    })
  })

  it('card 切替で selectedIds / phase が reset (前 card の選択を引き継がない)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    const opts = screen.getAllByRole('button', { name: /選択肢/ })
    opts.forEach((o) => expect(o).toHaveAttribute('aria-pressed', 'false'))
  })

  it('完了画面の「もう一度」で router.refresh が呼ばれる', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
    expect(mockRefresh).toHaveBeenCalledOnce()
  })

  it('完了画面の「ダッシュボードへ」は /app への Link として render される (S2.0b-2 fix: submit 時 revalidatePath を撤回、 dynamic page default の navigation 経由 fresh fetch に委譲)', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    // Button asChild + Link href="/app" で <a href="/app"> として render される。
    // 純 navigation (router.refresh 不要 = navigation 先 cache に影響しないため、
    // dashboard 側の dynamic page default 挙動で fresh fetch が走る)。
    const dashLink = screen.getByRole('link', { name: 'ダッシュボードへ' })
    expect(dashLink).toHaveAttribute('href', '/app')
  })

  it('カード進行インジケーター (1 / N) が表示される', () => {
    const cards = [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
    render(<SessionRunner cards={cards} fsrsMode={false} />)
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('集合一致 boundary: 複数正答 opt の片方だけ選択は incorrect → 「次へ」 で rating=1 submit', async () => {
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: true },
        { id: 'b', text: '選択肢B', is_correct: true },
        { id: 'c', text: '選択肢C', is_correct: false },
      ],
      correctAnswerIds: ['a', 'b'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText(/不正解/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('card-1', 1))
  })

  it('集合一致 boundary: 複数正答 opt を完全一致選択は correct → 「次へ」 で rating=3 submit', async () => {
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: true },
        { id: 'b', text: '選択肢B', is_correct: true },
        { id: 'c', text: '選択肢C', is_correct: false },
      ],
      correctAnswerIds: ['a', 'b'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    clickOption('選択肢A')
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText(/^正解/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('card-1', 3))
  })

  it('集合一致 boundary: 余剰 opt 選択 (正答 + 誤答) は incorrect → 「次へ」 で rating=1 submit', async () => {
    const card = makeCard({
      options: [
        { id: 'a', text: '選択肢A', is_correct: true },
        { id: 'b', text: '選択肢B', is_correct: false },
      ],
      correctAnswerIds: ['a'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    clickOption('選択肢A')
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('card-1', 1))
  })
})

// -----------------------------------------------------------------------
// S2.2.3 T1 新規: 3-button nav (前へ / リトライ / 次へ) の追加 spec
// -----------------------------------------------------------------------
describe('SessionRunner (S2.2.3 T1: 前後ナビ + リトライ)', () => {
  // ---------------------------------------------------------------------
  // selecting footer
  // ---------------------------------------------------------------------

  it('selecting: idx=0 で「前へ」 disabled、 「回答する」 (空選択) disabled、 「次へ」 常時 enabled', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('selecting: 「次へ」 押下 → submit せず idx+1、 「回答する」 再表示 (selecting reset)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)
    // 1 件選択した上で「次へ」 (スキップ) → submit せず進む
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    expect(screen.getByText('問2')).toBeInTheDocument()
    expect(mockSubmitReview).not.toHaveBeenCalled()
    // 問2 では選択 reset → 「回答する」 disabled
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
  })

  it('selecting: idx>=1 で「前へ」 enable、 押下で idx-1 + selectedIds reset', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)
    // 問1 を選択せずスキップ → 問2 へ
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    expect(screen.getByText('問2')).toBeInTheDocument()
    // 問2 で「前へ」 enable、 1 件選択した状態で押下
    expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    // 問1 へ戻り、 selectedIds reset
    expect(screen.getByText('問1')).toBeInTheDocument()
    const optA = screen.getByRole('button', { name: /選択肢A/ })
    expect(optA).toHaveAttribute('aria-pressed', 'false')
    // 「前へ」 (idx=0) は再 disabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    // submit は呼ばれていない
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it('selecting: 最後の card で「次へ」 押下 → finished phase', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    // finished
    expect(screen.getByText('🎉')).toBeInTheDocument()
    // tally 0 (スキップなので answered 増えない)
    expect(screen.getByText(/0 枚/)).toBeInTheDocument()
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // judged 通常モード footer
  // ---------------------------------------------------------------------

  it('judged 通常モード: 3 button (前へ / リトライ / 次へ) 表示、 idx=0 で「前へ」 disabled、 「リトライ」 / 「次へ」 enabled', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_RETRY })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('judged 通常モード: 「リトライ」 押下 → selecting reset + 選択解除 + submit なし', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // judged 中
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    // selecting に戻る (「回答する」 再表示、 解説非表示)
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    expect(screen.queryByText('カード全体の解説')).not.toBeInTheDocument()
    // 選択 reset
    const optB = screen.getByRole('button', { name: /選択肢B/ })
    expect(optB).toHaveAttribute('aria-pressed', 'false')
    // submit は呼ばれない
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it('judged 通常モード: 「前へ」 押下 → idx-1 + selecting reset + submit なし', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)
    // 問1 スキップ → 問2
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    expect(screen.getByText('問2')).toBeInTheDocument()
    // 問2 で回答 → judged
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 「前へ」 → 問1 へ戻る (selecting reset)
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.queryByText('カード全体の解説')).not.toBeInTheDocument()
    // submit は呼ばれていない
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // judged FSRS モード footer
  // ---------------------------------------------------------------------

  it('judged FSRS モード: 4 rate (上段) + 3 nav (下段) 表示、 lastRating=null で「前へ」 / 「次へ」 disabled、 「リトライ」 enabled', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)
    // 問1 スキップ → 問2 (idx=1) で「前へ」 が idx 条件単独では enable のはず
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 上段 4 rate
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Easy' })).toBeInTheDocument()
    // 下段 3 nav
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_RETRY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeInTheDocument()
    // rate 未押下: idx>=1 でも lastRating === null で「前へ」 / 「次へ」 disabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeDisabled()
    expect(screen.getByRole('button', { name: NAME_RETRY })).not.toBeDisabled()
  })

  it('judged FSRS モード: Hard 押下 → submit + lastRating セット → 「次へ」 enable (idx=0 で「前へ」 は idx 条件で disabled)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('c1', 2))
    // lastRating セット → 「次へ」 enable
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // idx=0 なので「前へ」 は依然 disabled
    expect(screen.getByRole('button', { name: NAME_PREV })).toBeDisabled()
  })

  it('judged FSRS モード: idx>=1 + rate 押下後で「前へ」 enable', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)
    // 問1 スキップ → 問2 で回答 → judged
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('c2', 3))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    })
    expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
  })

  it('judged FSRS モード: rate 連打で毎回 submitReview 呼ばれる (上書き submit) + client tally は初回のみ +1', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 1 回目: Good (correct → tally +1)
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 3))
    // 「次へ」 enable まで待つ (pending 抜け)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 2 回目: Hard (上書き submit、 tally は +1 しない)
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 2))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    expect(mockSubmitReview).toHaveBeenCalledTimes(2)
    // 「次へ」 押下 → finished、 tally は 1 枚 / 1 正解 / 100%
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    expect(screen.getByText(/1 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
    expect(screen.getByText(/100%/)).toBeInTheDocument()
  })

  it('judged FSRS モード: 「リトライ」 → selecting reset + lastRating=null + 4 rate / 「次へ」 が再 disabled', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 「リトライ」 → selecting reset
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    // 4 rate ボタンは judged でしか出ないので消える
    expect(screen.queryByRole('button', { name: 'Again' })).not.toBeInTheDocument()
    // 再選択 → 回答 → judged で「次へ」 が rate 前 disabled に戻る (lastRating=null)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: NAME_NEXT })).toBeDisabled()
  })

  it('judged FSRS モード: 「前へ」 (rate 後) → idx-1 + selecting reset + submit 追加なし', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)
    // 問1 スキップ → 問2 で回答 → Good submit
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_PREV })).not.toBeDisabled()
    })
    // 「前へ」 → 問1 へ戻り submit 追加なし
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(mockSubmitReview).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
  })

  it('FSRS モード最後の card: rate → 「次へ」 で finished phase (submit 追加なし)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('c1', 4))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    expect(mockSubmitReview).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------
  // S2.2.3 T1 review I-1 fix: tally 真実 source を submittedCardIds に切替
  // (lastRating === null base では resetCardState で null 戻り → 再 submit 時に
  // isFirstSubmit が再 true になり tally 二重加算する bug があった)
  // ---------------------------------------------------------------------

  it('FSRS モード: リトライ後の再 submit で tally が二重加算されない (1 枚 / 1 正解)', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
    // 1 回目: 正答選択 → 回答 → Good submit (tally +1)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 3))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // リトライ → selecting reset (lastRating=null だが submittedCardIds は c1 保持)
    fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    // 再選択 → 回答 → Hard submit (上書き submit、 tally +1 しない想定)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 2))
    expect(mockSubmitReview).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()
    })
    // 「次へ」 → finished: tally 1 枚 / 1 正解 (初回 correctSnapshot=true を維持)
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    expect(screen.getByText(/1 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
  })

  it('通常モード: 前へ戻り後の再 submit で tally が二重加算されない (2 枚 / 1 正解)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={false} />)
    // 問1: 選択B → 回答 → 次へ (auto submit rating=3、 tally=1/1)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 3))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    // 問2 で 「前へ」 → 問1 戻り (selecting reset、 submittedCardIds は c1 保持)
    fireEvent.click(screen.getByRole('button', { name: NAME_PREV }))
    expect(screen.getByText('問1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    // 問1 を再回答 (誤答) → 次へ (上書き submit rating=1、 tally は二重加算しない)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 1))
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    // 問2: 選択A (誤答) → 回答 → 次へ (auto submit rating=1、 tally +1 / correct +0)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c2', 1))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
    // tally 2 枚 / 1 正解 (c1 は初回 correctSnapshot=true 維持で +1、 c2 incorrect で +0)
    // 二重加算していなければ answered=2 / correct=1 になる (c1 の再 submit で +1 されたら 3 枚 or 2 正解)
    expect(screen.getByText(/2 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // S2.2.5: FSRS rate ボタン押下ハイライト (濃色 fill + 白文字、 S2.2.4 selected fill bug fix)
  // -------------------------------------------------------------------------
  describe('S2.2.5: FSRS rate ボタン押下ハイライト (濃色 fill)', () => {
    it('rate 未押下 (lastRating=null) では 4 ボタンとも idle class (selected fill class なし)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument())
      // selected 用の bg-*-600 / text-white がついていない
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('bg-red-600')
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')
      expect(screen.getByRole('button', { name: 'Good' })).not.toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Easy' })).not.toHaveClass('bg-blue-600')
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('text-white')
    })

    it('Hard 押下後: Hard のみ orange-600 fill + text-white、 他 3 つは idle のまま', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('c1', 2))
      // Hard に selected fill + 白文字
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')
        expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('text-white')
      })
      // 他は idle (fill / 白文字 なし)
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('bg-red-600')
      expect(screen.getByRole('button', { name: 'Good' })).not.toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Easy' })).not.toHaveClass('bg-blue-600')
    })

    it('Hard → Good に切替: Good に selected fill、 Hard は idle に戻る (前のハイライト解除)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 2))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600'))
      // Good に切替
      fireEvent.click(screen.getByRole('button', { name: 'Good' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('c1', 3))
      // Good に selected fill + Hard が idle に戻る
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Good' })).toHaveClass('bg-emerald-600')
        expect(screen.getByRole('button', { name: 'Good' })).toHaveClass('text-white')
        expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')
        expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('text-white')
      })
    })

    it('Optimistic: rate click 直後に selected fill が反映 (server 完了待ちなし、 fire-and-forget)', async () => {
      // server resolve を意図的に保留 (pending Promise) しても、 click 同期で
      // 即 selected fill class が反映されることを検証 (Optimistic UI 必須条件)。
      let resolveSubmit!: () => void
      mockSubmitReview.mockImplementationOnce(
        () =>
          new Promise<{ ok: true; data: { correct: boolean } }>((res) => {
            resolveSubmit = () => res({ ok: true, data: { correct: true } })
          }),
      )
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))

      // click 前は idle
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')

      // click 直後 (server resolve 未だ): 即 selected fill
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('text-white')
      // submit は fire 済
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 2)

      // 4 ボタン + 「次へ」 が pending で disable されないことを同時確認
      // (rate4 / nav3 から pending gate を撤回した spec)
      expect(screen.getByRole('button', { name: 'Again' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Hard' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Good' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Easy' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: NAME_NEXT })).not.toBeDisabled()

      // 後片付け (テスト終了時の unhandled promise 防止)
      resolveSubmit()
    })

    it('Optimistic: rate 連打中 (前 submit pending) でも 2 回目 submit が即発火、 highlight も切替 (= 連打可 / last write wins)', async () => {
      // 1 回目 submit を hold、 2 回目 click した時点で 2 回目 submit が即 fire
      // されることを検証。 旧実装 (useTransition + await) は 1 回目 await 完了まで
      // 2 回目を受け付けない (= startTransition 抑止 or button disabled) ため、
      // この test は fire-and-forget 化の確実な regression guard になる。
      let resolveFirst!: () => void
      let resolveSecond!: () => void
      mockSubmitReview
        .mockImplementationOnce(
          () =>
            new Promise<{ ok: true; data: { correct: boolean } }>((res) => {
              resolveFirst = () => res({ ok: true, data: { correct: true } })
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<{ ok: true; data: { correct: boolean } }>((res) => {
              resolveSecond = () => res({ ok: true, data: { correct: true } })
            }),
        )
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))

      // 1 回目 (Hard) click — server hold 中だが UI は即 selected
      fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
      expect(mockSubmitReview).toHaveBeenCalledTimes(1)
      expect(mockSubmitReview).toHaveBeenNthCalledWith(1, 'c1', 2)
      expect(screen.getByRole('button', { name: 'Hard' })).toHaveClass('bg-orange-600')

      // 2 回目 (Good) click — 1 回目 pending 中でも即 fire される
      fireEvent.click(screen.getByRole('button', { name: 'Good' }))
      expect(mockSubmitReview).toHaveBeenCalledTimes(2)
      expect(mockSubmitReview).toHaveBeenNthCalledWith(2, 'c1', 3)
      // highlight は Good に切替 (Hard は idle に戻る)
      expect(screen.getByRole('button', { name: 'Good' })).toHaveClass('bg-emerald-600')
      expect(screen.getByRole('button', { name: 'Hard' })).not.toHaveClass('bg-orange-600')

      // tally は初回 click のみ +1 (連打を 1 カウント固定)、 「次へ」 で finished へ
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))
      await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())
      expect(screen.getByText(/1 枚/)).toBeInTheDocument()
      // 後片付け
      resolveFirst()
      resolveSecond()
    })

    it('Optimistic 通常モード: 「次へ」 click で server 待たず即 next card (fire-and-forget) + 成功時 error が次 card に出ない', async () => {
      // server resolve を hold した状態で「次へ」 を押下、 next card が即表示
      // されることを検証 (旧実装 = useTransition await goNext では server resolve
      // まで遷移しなかった)。 加えて成功 resolve 後に次 card 上に error が出ない
      // ことを assert する (= ok:true 経路で setError が誤発火しないことの guard、
      // 将来 refactor で意図せず alert 系を発火させた regression を捕捉する)。
      let resolveSubmit!: () => void
      mockSubmitReview.mockImplementationOnce(
        () =>
          new Promise<{ ok: true; data: { correct: boolean } }>((res) => {
            resolveSubmit = () => res({ ok: true, data: { correct: true } })
          }),
      )
      const cards = [
        makeCard({ id: 'c1', questionText: '問1' }),
        makeCard({ id: 'c2', questionText: '問2' }),
      ]
      render(<SessionRunner cards={cards} fsrsMode={false} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: NAME_NEXT }))

      // 同期: 即 next card に遷移している (server resolve 未だ)
      expect(screen.getByText('問2')).toBeInTheDocument()
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 3)

      // server resolve (ok:true) 後 microtask 経過させて、 次 card 上に error が
      // 出ないことを確認 (setError on success の defensive guard)。
      resolveSubmit()
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
      // 次 card のまま (= 副作用で何かが起きていないことの再確認)
      expect(screen.getByText('問2')).toBeInTheDocument()
    })

    it('リトライで lastRating=null 化、 再 judged 時 4 ボタンとも idle (fill なし)', async () => {
      render(<SessionRunner cards={[makeCard({ id: 'c1' })]} fsrsMode={true} />)
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Easy' })).toHaveClass('bg-blue-600'))
      // リトライ → selecting → 再回答 → judged
      fireEvent.click(screen.getByRole('button', { name: NAME_RETRY }))
      clickOption('選択肢B')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      // 4 ボタンとも idle (lastRating=null に reset 済)
      expect(screen.getByRole('button', { name: 'Easy' })).not.toHaveClass('bg-blue-600')
      expect(screen.getByRole('button', { name: 'Again' })).not.toHaveClass('bg-red-600')
    })
  })
})
