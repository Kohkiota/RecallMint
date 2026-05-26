// @vitest-environment jsdom
// StudySessionHost test (S-local-3 Task 3)。 Dexie cards (local mirror) →
// fallback (server cards) の hybrid 切替が正しく動作することを verify。
// Dexie helper / Dexie write / SessionRunner を mock し、 props で受け渡される
// cards が「Dexie 由来」 か「server 由来」 かを assertion する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import type { Card } from '@/lib/db/schema'

const {
  mockGetDueCardsFromDexie,
  mockCreateStudySession,
  mockNewId,
  mockSessionRunner,
} = vi.hoisted(() => ({
  mockGetDueCardsFromDexie: vi.fn(),
  mockCreateStudySession: vi.fn(),
  mockNewId: vi.fn(),
  mockSessionRunner: vi.fn(),
}))

vi.mock('@/lib/cards/get-dexie-session-cards', () => ({
  getDueCardsFromDexie: mockGetDueCardsFromDexie,
}))
vi.mock('@/lib/sync/review-events', () => ({
  createStudySession: mockCreateStudySession,
  newId: mockNewId,
}))
vi.mock('./session-runner', () => ({
  SessionRunner: (props: { cards: Card[]; sessionId: string }) => {
    mockSessionRunner(props)
    return <div data-testid="session-runner">runner</div>
  },
}))

import { StudySessionHost } from './study-session-host'

function fakeCard(overrides?: Partial<Card>): Card {
  return {
    id: 'server-card-1',
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    title: 'Q',
    sortKey: null,
    questionText: 'Q?',
    options: [],
    correctAnswerIds: [],
    explanationText: null,
    memo: null,
    images: [],
    customProps: {},
    tags: [],
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

beforeEach(() => {
  vi.clearAllMocks()
  mockNewId.mockReturnValue('00000000-0000-4000-a000-000000000001')
  mockCreateStudySession.mockResolvedValue(undefined)
  mockGetDueCardsFromDexie.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe('StudySessionHost (S-local-3 hybrid)', () => {
  it('Dexie cards 1 件以上 → Dexie cards で SessionRunner が render される', async () => {
    const serverCards = [fakeCard({ id: 'server-a' })]
    const dexieCards = [fakeCard({ id: 'dexie-a' }), fakeCard({ id: 'dexie-b' })]
    mockGetDueCardsFromDexie.mockResolvedValueOnce(dexieCards)

    render(
      <StudySessionHost
        cards={serverCards}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )

    await waitFor(() =>
      expect(mockSessionRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          cards: expect.arrayContaining([
            expect.objectContaining({ id: 'dexie-a' }),
            expect.objectContaining({ id: 'dexie-b' }),
          ]),
        }),
      ),
    )
    // server cards は使われていない (= dexie で上書き)
    const lastCall = mockSessionRunner.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['dexie-a', 'dexie-b'])
    // createStudySession の card_ids も dexie 由来
    expect(mockCreateStudySession).toHaveBeenCalledWith(
      expect.objectContaining({
        card_ids: ['dexie-a', 'dexie-b'],
      }),
    )
  })

  it('Dexie cards 0 件 → server cards で fallback render', async () => {
    const serverCards = [fakeCard({ id: 'server-a' }), fakeCard({ id: 'server-b' })]
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])

    render(
      <StudySessionHost
        cards={serverCards}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )

    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    const lastCall = mockSessionRunner.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['server-a', 'server-b'])
    expect(mockCreateStudySession).toHaveBeenCalledWith(
      expect.objectContaining({ card_ids: ['server-a', 'server-b'] }),
    )
  })

  it('Dexie helper が throw → silent fallback (server cards で render)', async () => {
    const serverCards = [fakeCard({ id: 'server-only' })]
    mockGetDueCardsFromDexie.mockRejectedValueOnce(new Error('dexie boom'))

    render(
      <StudySessionHost
        cards={serverCards}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )

    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    const lastCall = mockSessionRunner.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['server-only'])
  })

  it('getDueCardsFromDexie が userId / sessionLimit で呼ばれる', async () => {
    render(
      <StudySessionHost
        cards={[fakeCard()]}
        fsrsMode={false}
        userId="user-xyz"
        sessionLimit={42}
        mode="smart"
      />,
    )

    await waitFor(() => expect(mockGetDueCardsFromDexie).toHaveBeenCalled())
    expect(mockGetDueCardsFromDexie).toHaveBeenCalledWith('user-xyz', 42)
  })
})
