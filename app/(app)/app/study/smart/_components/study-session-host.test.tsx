// @vitest-environment jsdom
// StudySessionHost test (S-local-3 Task 3)。 Dexie cards (local mirror) →
// fallback (server cards) の hybrid 切替が正しく動作することを verify。
// Dexie helper / SessionLauncher を mock し、 props で受け渡される
// cards が「Dexie 由来」 か「server 由来」 かを assertion する。
//
// T7 変更: sessionId 採番は SessionLauncher に移管済。
// host test では SessionLauncher mock に渡された cards / userId を検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import type { Card } from '@/lib/db/schema'

const { mockGetDueCardsFromDexie, mockSessionLauncher } = vi.hoisted(() => ({
  mockGetDueCardsFromDexie: vi.fn(),
  mockSessionLauncher: vi.fn(),
}))

vi.mock('@/lib/cards/get-dexie-session-cards', () => ({
  getDueCardsFromDexie: mockGetDueCardsFromDexie,
}))
vi.mock('../../_components/session-launcher', () => ({
  SessionLauncher: (props: {
    cards: Card[]
    userId: string
    heading: string
    emptyState: React.ReactNode
  }) => {
    mockSessionLauncher(props)
    // cards が空のときは emptyState を render し、 non-empty のときは stub runner を返す。
    if (props.cards.length === 0) {
      return <>{props.emptyState}</>
    }
    return <div data-testid="session-launcher">launcher</div>
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

beforeEach(() => {
  vi.clearAllMocks()
  mockGetDueCardsFromDexie.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe('StudySessionHost (S-local-3 hybrid)', () => {
  it('Dexie cards 1 件以上 → Dexie cards で SessionLauncher が呼ばれる', async () => {
    const serverCards = [fakeCard({ id: 'server-a' })]
    const dexieCards = [fakeCard({ id: 'dexie-a' }), fakeCard({ id: 'dexie-b' })]
    mockGetDueCardsFromDexie.mockResolvedValueOnce(dexieCards)

    render(
      <StudySessionHost
        cards={serverCards}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
      />,
    )

    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({
          cards: expect.arrayContaining([
            expect.objectContaining({ id: 'dexie-a' }),
            expect.objectContaining({ id: 'dexie-b' }),
          ]),
        }),
      ),
    )
    // server cards は使われていない (= dexie で上書き)
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['dexie-a', 'dexie-b'])
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
      />,
    )

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['server-a', 'server-b'])
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
      />,
    )

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['server-only'])
  })

  it('getDueCardsFromDexie が userId / sessionLimit で呼ばれる', async () => {
    render(
      <StudySessionHost
        cards={[fakeCard()]}
        fsrsMode={false}
        userId="user-xyz"
        sessionLimit={42}
      />,
    )

    await waitFor(() => expect(mockGetDueCardsFromDexie).toHaveBeenCalled())
    expect(mockGetDueCardsFromDexie).toHaveBeenCalledWith('user-xyz', 42)
  })

  it('userId を SessionLauncher に転送する (flush の owner-scope 供給・spec §4.6)', async () => {
    render(
      <StudySessionHost
        cards={[fakeCard()]}
        fsrsMode={false}
        userId="user-xyz"
        sessionLimit={20}
      />,
    )

    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-xyz' }),
      ),
    )
  })

  it('origin="smart" を SessionLauncher に渡す (Dash-1 Home v1 spec §11.4 — smart host 固定値)', async () => {
    render(
      <StudySessionHost
        cards={[fakeCard()]}
        fsrsMode={false}
        userId="user-xyz"
        sessionLimit={20}
      />,
    )

    await waitFor(() =>
      expect(mockSessionLauncher).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'smart' }),
      ),
    )
  })

  // -------------------------------------------------------------------------
  // S-local-4 (Phase γ): Dexie + server 両方 0 件 → empty UI 表示。 旧 page.tsx の
  // 「ありません」 page を host 内に集約 (offline で server fetch fail → cards=[]
  // 渡し + Dexie も 0 件のときの一元判断)。
  // -------------------------------------------------------------------------

  it('Dexie 0 件 + server cards 0 件 → empty UI 表示', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const { getByText, getByRole } = render(
      <StudySessionHost
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
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
    // SessionLauncher には cards=[] が渡り、 emptyState が render される
    expect(mockSessionLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ cards: [] }),
    )
  })

  it('Dexie 0 件 + server cards 1 件以上 → server fallback で SessionLauncher (empty UI は出ない)', async () => {
    mockGetDueCardsFromDexie.mockResolvedValueOnce([])
    const serverCards = [fakeCard({ id: 'fallback-only' })]
    const { queryByText } = render(
      <StudySessionHost
        cards={serverCards}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
      />,
    )

    await waitFor(() => expect(mockSessionLauncher).toHaveBeenCalled())
    // empty UI は出ない (= server fallback で session 起動)
    expect(queryByText(/現在復習する card はありません/)).not.toBeInTheDocument()
    const lastCall = mockSessionLauncher.mock.lastCall?.[0] as { cards: Card[] }
    expect(lastCall.cards.map((c) => c.id)).toEqual(['fallback-only'])
  })

  it('Dexie throw + server cards 0 件 → silent fallback で empty UI', async () => {
    mockGetDueCardsFromDexie.mockRejectedValueOnce(new Error('dexie boom'))
    const { getByText } = render(
      <StudySessionHost
        cards={[]}
        fsrsMode={false}
        userId="user-1"
        sessionLimit={20}
      />,
    )

    await waitFor(() => {
      expect(getByText(/現在復習する card はありません/)).toBeInTheDocument()
    })
  })
})
