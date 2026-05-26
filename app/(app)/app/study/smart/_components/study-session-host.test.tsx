// @vitest-environment jsdom
// StudySessionHost test (S-local-3 Task 3)。 Dexie cards (local mirror) →
// fallback (server cards) の hybrid 切替が正しく動作することを verify。
// Dexie helper / Dexie write / SessionRunner を mock し、 props で受け渡される
// cards が「Dexie 由来」 か「server 由来」 かを assertion する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'
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
  SessionRunner: (props: {
    cards: Card[]
    sessionId: string
    onNavigateAction?: () => void
    hideRetry?: boolean
  }) => {
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

  // -------------------------------------------------------------------------
  // S-local-5: onNavigateAction / hideRetry を SessionRunner に pass-through
  // -------------------------------------------------------------------------

  it('S-local-5: onNavigateAction / hideRetry が SessionRunner に pass-through される', async () => {
    const onNavigateAction = vi.fn()
    render(
      <StudySessionHost
        cards={[fakeCard()]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
        onNavigateAction={onNavigateAction}
        hideRetry={true}
      />,
    )
    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    const lastCall = mockSessionRunner.mock.lastCall?.[0] as {
      onNavigateAction?: () => void
      hideRetry?: boolean
    }
    expect(lastCall.onNavigateAction).toBe(onNavigateAction)
    expect(lastCall.hideRetry).toBe(true)
  })

  it('S-local-5 review fix: empty UI + onNavigateAction provided → button click で callback 呼出 (Link でなく)', async () => {
    const onNavigateAction = vi.fn()
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { findByRole, queryByRole } = render(
      <StudySessionHost
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
        onNavigateAction={onNavigateAction}
      />,
    )
    // empty UI 内の button を await
    const btn = await findByRole('button', { name: 'ダッシュボードへ' })
    // Link (= <a>) ではなく button、 = callback 経路
    expect(queryByRole('link', { name: 'ダッシュボードへ' })).not.toBeInTheDocument()
    fireEvent.click(btn)
    expect(onNavigateAction).toHaveBeenCalledTimes(1)
  })

  it('S-local-5 review fix: empty UI + onNavigateAction 未指定 → 既存 Link 経路維持', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { findByRole } = render(
      <StudySessionHost
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )
    // 未指定なら従来通り <Link>
    const link = await findByRole('link', { name: 'ダッシュボードへ' })
    expect(link).toHaveAttribute('href', '/app')
  })

  it('S-local-5: prop 未指定 → SessionRunner に undefined / undefined で渡る (既存挙動維持)', async () => {
    render(
      <StudySessionHost
        cards={[fakeCard()]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )
    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    const lastCall = mockSessionRunner.mock.lastCall?.[0] as {
      onNavigateAction?: () => void
      hideRetry?: boolean
    }
    expect(lastCall.onNavigateAction).toBeUndefined()
    expect(lastCall.hideRetry).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // S-local-4 (Phase γ): Dexie + server 両方 0 件 → empty UI 表示。 旧 page.tsx の
  // 「ありません」 page を host 内に集約 (offline で server fetch fail → cards=[]
  // 渡し + Dexie も 0 件のときの一元判断)。
  // -------------------------------------------------------------------------

  it('Dexie 0 件 + server cards 0 件 → empty UI 表示、 createStudySession は呼ばれない', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { getByText, getByRole } = render(
      <StudySessionHost
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )

    await waitFor(() => {
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument()
    })
    // ダッシュボードへ link が表示される
    expect(getByRole('link', { name: 'ダッシュボードへ' })).toHaveAttribute(
      'href',
      '/app',
    )
    // 空 session を作らない (Dexie write 不発火)
    expect(mockCreateStudySession).not.toHaveBeenCalled()
    // SessionRunner も render されない
    expect(mockSessionRunner).not.toHaveBeenCalled()
  })

  it('Dexie 0 件 + server cards 1 件以上 → server fallback で SessionRunner (empty UI は出ない)', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const serverCards = [fakeCard({ id: 'fallback-only' })]
    const { queryByText } = render(
      <StudySessionHost
        cards={serverCards}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )

    await waitFor(() => expect(mockSessionRunner).toHaveBeenCalled())
    // empty UI は出ない (= server fallback で session 起動)
    expect(queryByText(/現在復習する card はありません/)).not.toBeInTheDocument()
    expect(mockCreateStudySession).toHaveBeenCalled()
  })

  it('Dexie throw + server cards 0 件 → silent fallback で empty UI', async () => {
    mockGetDueCardsFromDexie.mockRejectedValueOnce(new Error('dexie boom'))
    const { getByText } = render(
      <StudySessionHost
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
        mode="smart"
      />,
    )

    await waitFor(() => {
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument()
    })
    expect(mockCreateStudySession).not.toHaveBeenCalled()
    expect(mockSessionRunner).not.toHaveBeenCalled()
  })
})
