// @vitest-environment jsdom
// SessionRunner client component の test (S2.2.2 T1 で 2-step フロー再設計)。
//
// Phase machine: selecting → judged → finished
// - selecting (両モード共通): opt click + 「回答する」 で判定のみ (submit せず) → judged 遷移
// - judged (通常): 「次へ」 で auto rating submit (correct→3 / incorrect→1) + 次 card 自動遷移
// - judged (FSRS): Again/Hard/Good/Easy 4 ボタンで user 選択 rating submit + 次 card 自動遷移
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

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------
describe('SessionRunner (selecting → judged → finished, 2-step)', () => {
  it('初期描画: 問題文 + 選択肢 + 「回答する」 button (disabled)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    expect(screen.getByText('問題文テキスト')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択肢A/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択肢B/ })).toBeInTheDocument()
    const submitBtn = screen.getByRole('button', { name: '回答する' })
    expect(submitBtn).toBeDisabled()
  })

  it('opt click で selectedIds 追加、 再 click で削除 (toggle)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    const optA = screen.getByRole('button', { name: /選択肢A/ })
    fireEvent.click(optA)
    // selected 状態は aria-pressed で表現
    expect(optA).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(optA)
    expect(optA).toHaveAttribute('aria-pressed', 'false')
  })

  it('1 件以上選択で 「回答する」 が enabled (通常モード)', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    expect(screen.getByRole('button', { name: '回答する' })).not.toBeDisabled()
  })

  it('selecting (両モード共通): FSRS モードでも footer は 「回答する」 のみ、 rate ボタンは存在しない', () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    // 「回答する」 1 個のみ、 selecting では 4 rate ボタン無し
    expect(screen.getByRole('button', { name: '回答する' })).toBeInTheDocument()
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

  it('通常モード: 「回答する」 押下時に submitReview は呼ばれず、 judged 遷移 + 解説 + 「次へ」 表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    // judged phase: 解説 + 次へ
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument()
    expect(screen.getByText(/正解/)).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 1)
    })
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
  })

  it('通常モード: 「次へ」 submit error 時 → judged 維持 + error 表示 + 「次へ」 再 enable で retry 可能', async () => {
    mockSubmitReview.mockResolvedValueOnce({ ok: false, error: 'サーバーエラー' })
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // judged 遷移済
    expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('サーバーエラー')
    })
    // judged 維持 (解説 + 判定 banner 出続ける)
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByText(/正解/)).toBeInTheDocument()
    // 「次へ」 再 enable で retry
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '次へ' })).not.toBeDisabled()
    })
  })

  it('FSRS モード: 「回答する」 押下時に submitReview は呼ばれず、 judged 遷移 + 解説 + 4 rate ボタン (Again/Hard/Good/Easy) 表示', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))

    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Good' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Easy' })).toBeInTheDocument()
    // judged では「回答する」 / 「次へ」 は出ない
    expect(screen.queryByRole('button', { name: '回答する' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '次へ' })).not.toBeInTheDocument()
    // submit はまだ呼ばれない
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it('FSRS モード: judged Hard 押下で submitReview(rating=2) + 次 card 自動遷移 (selecting reset + 「回答する」 disabled)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
    ]
    render(<SessionRunner cards={cards} fsrsMode={true} />)

    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // judged で Hard 押下 → submit + 自動次へ
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))
    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('c1', 2)
    })
    // 問2 に進む + selecting reset (「回答する」 が disabled に戻る)
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
  })

  it('FSRS モード: Again/Good/Easy それぞれで submitReview(rating=1|3|4) 呼出', async () => {
    // Again ケース
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
    // Good ケース
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
    // Easy ケース
    {
      render(<SessionRunner cards={[makeCard({ id: 'cE' })]} fsrsMode={true} />)
      clickOption('選択肢A')
      fireEvent.click(screen.getByRole('button', { name: '回答する' }))
      fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
      await waitFor(() => expect(mockSubmitReview).toHaveBeenLastCalledWith('cE', 4))
    }
  })

  it('FSRS モード: rate submit error 時 → judged 維持 + error UI + 4 ボタン再 enable で retry', async () => {
    mockSubmitReview.mockResolvedValueOnce({ ok: false, error: 'rate 失敗' })
    render(<SessionRunner cards={[makeCard()]} fsrsMode={true} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // judged 遷移済 → Good 押下で submit error
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('rate 失敗')
    })
    // judged 維持 (解説 + 4 ボタン残置)
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Again' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Hard' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Good' })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: 'Easy' })).not.toBeDisabled()
    })
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

    // text 表示は prefix が strip されている (本文に "1誤正正誤" は登場しない)
    expect(screen.queryByText('1誤正正誤', { exact: true })).not.toBeInTheDocument()
    // 本文部分は "誤正正誤" として描画
    const opt1Btn = screen.getByRole('button', { name: /誤正正誤/ })
    expect(opt1Btn).toBeInTheDocument()
    // ID 1 を含む font-medium span が opt1Btn 内に 1 つだけ存在
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
    // "1990s" は元文字列のまま残る
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
    // 元の "1) 答え" 全文は本文部分には残らない
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
    // 犠牲ケース: opt.id="1" と text="1.5g" は startsWith マッチし、 直後が "." (非数字) なので
    // strip 処理に進む。 A 案 trade-off として OT 承認済 (純数値先頭の単位付き文字列の犠牲)。
    const card = makeCard({
      options: [
        { id: '1', text: '1.5g', is_correct: false },
        { id: '2', text: '2正解', is_correct: true },
      ],
      correctAnswerIds: ['2'],
    })
    render(<SessionRunner cards={[card]} fsrsMode={false} />)
    // 本文部分が "5g" として描画されている
    const opt1Btn = screen.getByRole('button', { name: /5g/ })
    expect(opt1Btn).toBeInTheDocument()
    expect(screen.queryByText('1.5g', { exact: true })).not.toBeInTheDocument()
  })

  it('judged 後: 正答 opt に ○、 非正答 opt に × mark', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    // 同期遷移なので即 judged
    expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    // 各 li に ○ / × mark
    expect(screen.getByText('○')).toBeInTheDocument()
    expect(screen.getByText('×')).toBeInTheDocument()
  })

  it('judged 後 opt click は無効 (selectedIds 変わらない)', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument()

    // judged 中の opt click では再選択トグルが効かない
    const optB = screen.getByRole('button', { name: /選択肢B/ })
    // disabled になっているはず
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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    // Card 2: 正答
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    // Card 3: 誤答
    await waitFor(() => expect(screen.getByText('問3')).toBeInTheDocument())
    clickOption('選択肢A')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())

    // 問2 では 「回答する」 が再び disabled (selectedIds が空に reset)
    expect(screen.getByRole('button', { name: '回答する' })).toBeDisabled()
    // 全 opt の aria-pressed=false
    const opts = screen.getAllByRole('button', { name: /選択肢/ })
    opts.forEach((o) => expect(o).toHaveAttribute('aria-pressed', 'false'))
  })

  it('完了画面の「もう一度」で router.refresh が呼ばれる', async () => {
    render(<SessionRunner cards={[makeCard()]} fsrsMode={false} />)
    clickOption('選択肢B')
    fireEvent.click(screen.getByRole('button', { name: '回答する' }))
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
    expect(mockRefresh).toHaveBeenCalledOnce()
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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
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
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    await waitFor(() => expect(mockSubmitReview).toHaveBeenCalledWith('card-1', 1))
  })
})
