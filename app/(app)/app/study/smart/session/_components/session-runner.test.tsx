// @vitest-environment jsdom
// SessionRunner client component の test。
// submitReview / next/navigation を mock して phase machine を検証する。

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
  // Default: submitReview resolves successfully with correct=true
  mockSubmitReview.mockResolvedValue({ ok: true, data: { correct: true } })
})

afterEach(() => {
  cleanup()
})

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------
describe('SessionRunner', () => {
  it('初期描画: 問題文と rate buttons が表示される', () => {
    render(<SessionRunner cards={[makeCard()]} />)
    expect(screen.getByText('問題文テキスト')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Good' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Easy' })).toBeInTheDocument()
  })

  it('1 枚: rate(Good) → 解説表示 → 次へ → 完了画面 (1/1 正答率 100%)', async () => {
    render(<SessionRunner cards={[makeCard()]} />)

    // asking phase: rate Good
    fireEvent.click(screen.getByRole('button', { name: 'Good' }))

    // showing-explanation phase
    await waitFor(() => {
      expect(screen.getByText('カード全体の解説')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument()

    // 次へ → finished
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    expect(screen.getByText(/1 枚/)).toBeInTheDocument()
    expect(screen.getByText(/1 正解/)).toBeInTheDocument()
    expect(screen.getByText(/100%/)).toBeInTheDocument()
    expect(screen.getByText('🎉')).toBeInTheDocument()
  })

  it('3 枚: Easy/Easy/Again → 完了画面 (3枚 / 2正解 / 67%)', async () => {
    const cards = [
      makeCard({ id: 'c1', questionText: '問1' }),
      makeCard({ id: 'c2', questionText: '問2' }),
      makeCard({ id: 'c3', questionText: '問3' }),
    ]
    mockSubmitReview
      .mockResolvedValueOnce({ ok: true, data: { correct: true } })  // Easy → correct
      .mockResolvedValueOnce({ ok: true, data: { correct: true } })  // Easy → correct
      .mockResolvedValueOnce({ ok: true, data: { correct: false } }) // Again → incorrect

    render(<SessionRunner cards={cards} />)

    // Card 1: Easy (rating=4 → tally.correct++)
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    // Card 2: Easy
    await waitFor(() => expect(screen.getByText('問2')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    // Card 3: Again (rating=1 → no tally.correct++)
    await waitFor(() => expect(screen.getByText('問3')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    // finished: 3 answered / 2 correct / 67%
    await waitFor(() => {
      expect(screen.getByText(/3 枚/)).toBeInTheDocument()
      expect(screen.getByText(/2 正解/)).toBeInTheDocument()
      expect(screen.getByText(/67%/)).toBeInTheDocument()
    })
  })

  it('submitReview ok:false → error UI 表示、 rate buttons は引き続き使える', async () => {
    mockSubmitReview.mockResolvedValueOnce({ ok: false, error: 'サーバーエラー' })
    render(<SessionRunner cards={[makeCard()]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Good' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('サーバーエラー')
    })

    // rate buttons should still be accessible for retry
    expect(screen.getByRole('button', { name: 'Again' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Easy' })).not.toBeDisabled()
  })

  it('Easy click で submitReview の引数が rating=4', async () => {
    render(<SessionRunner cards={[makeCard({ id: 'card-xyz' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }))

    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('card-xyz', 4)
    })
  })

  it('Again click で submitReview の引数が rating=1', async () => {
    mockSubmitReview.mockResolvedValueOnce({ ok: true, data: { correct: false } })
    render(<SessionRunner cards={[makeCard({ id: 'card-abc' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Again' }))

    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('card-abc', 1)
    })
  })

  it('Hard click で submitReview の引数が rating=2 + 正解扱い (boundary)', async () => {
    mockSubmitReview.mockResolvedValueOnce({ ok: true, data: { correct: true } })
    render(<SessionRunner cards={[makeCard({ id: 'card-hard' })]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Hard' }))

    // submitReview called with rating=2
    await waitFor(() => {
      expect(mockSubmitReview).toHaveBeenCalledWith('card-hard', 2)
    })

    // advance to finished
    await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    // Hard (rating=2) is "correct" on server side → 1/1/100%
    await waitFor(() => {
      expect(screen.getByText(/1 枚/)).toBeInTheDocument()
      expect(screen.getByText(/1 正解/)).toBeInTheDocument()
      expect(screen.getByText(/100%/)).toBeInTheDocument()
    })
  })

  it('完了画面の「もう一度」で router.refresh が呼ばれる', async () => {
    render(<SessionRunner cards={[makeCard()]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    await waitFor(() => expect(screen.getByText('🎉')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
    expect(mockRefresh).toHaveBeenCalledOnce()
  })

  it('showing-explanation phase: 正解 option が emerald スタイルで表示される', async () => {
    render(<SessionRunner cards={[makeCard()]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    await waitFor(() => expect(screen.getByText('カード全体の解説')).toBeInTheDocument())

    // 正解 option b の li に emerald クラスが付く
    const optionItems = screen.getAllByRole('listitem')
    const correctItem = optionItems.find((el) =>
      el.className.includes('emerald'),
    )
    expect(correctItem).toBeDefined()
  })

  it('asking phase では解説テキストが表示されない', () => {
    render(<SessionRunner cards={[makeCard()]} />)
    expect(screen.queryByText('カード全体の解説')).not.toBeInTheDocument()
  })

  it('カード進行インジケーター (1 / N) が表示される', () => {
    const cards = [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
    render(<SessionRunner cards={cards} />)
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })
})
