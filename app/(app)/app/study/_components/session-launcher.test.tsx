// @vitest-environment jsdom
// SessionLauncher test (T7 / FSRS 整合 Sprint A T5)。
// - cards=[] → emptyState render、 SessionRunner 不 render
// - cards 非空 → newId() で採番した sessionId + userId で SessionRunner render
// - Dexie 行 (旧 study_sessions) は作らない
// - 再 render で sessionId が変わらない (1 mount = 1 session)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import type { Card } from '@/lib/db/schema'

const { mockNewId, mockSessionRunner } = vi.hoisted(() => ({
  mockNewId: vi.fn(),
  mockSessionRunner: vi.fn(),
}))

vi.mock('@/lib/sync/review-events', () => ({
  newId: mockNewId,
}))

// SessionRunner は smart/_components 配下だが、 SessionLauncher 内から相対 import される。
// vi.mock のパスはモジュールの import パスと一致させる必要があるため、 resolver が解決する
// 実際の file path を使用する。
vi.mock('../smart/_components/session-runner', () => ({
  SessionRunner: (props: {
    cards: Card[]
    userId: string
    sessionId: string
    heading?: string
  }) => {
    mockSessionRunner(props)
    return <div data-testid="session-runner">runner</div>
  },
}))

import { SessionLauncher } from './session-launcher'

function fakeCard(overrides?: Partial<Card>): Card {
  return {
    id: 'card-1',
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    title: 'Q',
    questionLabel: null,
    baseOrder: 1024,
    questionText: 'Q?',
    options: [],
    correctAnswerIds: [],
    explanationText: null,
    memo: null,
    images: [],
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    due: new Date('2026-05-26T10:00:00.000Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    contentVersion: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    ...overrides,
  } as Card
}

const FIXED_ID = '00000000-0000-4000-a000-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
  mockNewId.mockReturnValue(FIXED_ID)
})

afterEach(() => {
  cleanup()
})

describe('SessionLauncher', () => {
  it('cards=[] → emptyState が render され、 SessionRunner は render されない', () => {
    const { getByText } = render(
      <SessionLauncher
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        heading="スマート復習"
        emptyState={<div>カードなし</div>}
      />,
    )

    expect(getByText('カードなし')).toBeInTheDocument()
    expect(mockSessionRunner).not.toHaveBeenCalled()
  })

  it('cards 非空 → newId() の sessionId と userId を SessionRunner に渡す', async () => {
    const cards = [fakeCard({ id: 'c1' }), fakeCard({ id: 'c2' })]

    render(
      <SessionLauncher
        cards={cards}
        fsrsMode={false}
        userId="user-xyz"
        heading="スマート復習"
        emptyState={<div>カードなし</div>}
      />,
    )

    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    expect(mockSessionRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        cards: expect.arrayContaining([
          expect.objectContaining({ id: 'c1' }),
          expect.objectContaining({ id: 'c2' }),
        ]),
        userId: 'user-xyz',
        sessionId: FIXED_ID,
        heading: 'スマート復習',
      }),
    )
  })

  it('session_id 採番のみで Dexie 行は作らない (study_sessions 廃止・spec §4.4)', async () => {
    render(
      <SessionLauncher
        cards={[fakeCard({ id: 'c1' })]}
        fsrsMode={false}
        userId="user-1"
        heading="スマート復習"
        emptyState={<div>カードなし</div>}
      />,
    )

    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    // review-events の mock は newId 以外を持たない = 他の write helper を呼べば throw する。
    expect(mockNewId).toHaveBeenCalledTimes(1)
  })

  it('props 変化で再 render しても sessionId は変わらない (1 mount = 1 session)', async () => {
    let seq = 0
    mockNewId.mockImplementation(() => `id-${(seq += 1)}`)
    const props = {
      fsrsMode: false as const,
      userId: 'user-1',
      heading: 'スマート復習',
      emptyState: <div>カードなし</div>,
    }
    const { rerender } = render(
      <SessionLauncher {...props} cards={[fakeCard({ id: 'c1' })]} />,
    )
    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())

    rerender(<SessionLauncher {...props} cards={[fakeCard({ id: 'c2' })]} />)

    const sessionIds = new Set(
      (mockSessionRunner.mock.calls as Array<[{ sessionId: string }]>).map(
        (c) => c[0].sessionId,
      ),
    )
    expect([...sessionIds]).toEqual(['id-1'])
  })
})
