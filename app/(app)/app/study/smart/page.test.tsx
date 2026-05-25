// @vitest-environment jsdom
// SmartStudyPage tests (S2.2.1 T2 で session/page.tsx 統合)。
//
// page は server component (async function)。 getCurrentUser + db SELECT +
// getSessionCards を mock し、 await Page() で JSX を取得して render する。
//
// テスト観点:
// - cards 0 件: 「ありません」 文言 + ダッシュボードリンク表示
// - cards >= 1 件: SessionRunner が render される (SessionRunner は mock)
// - userSettings 行不在で sessionLimit=20 / fsrsMode=false fallback
//   (getSessionCards に渡される limit / SessionRunner の fsrsMode prop で verify)

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Card } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
// S-cache-1: page.tsx は SessionRunner を直接 render しなくなり、 client wrapper
// `StudySessionHost` を介す (session_id を Dexie で採番してから SessionRunner を
// mount するため)。 mock target を host に変えれば props verify は従来同様可能。
const { mockGetCurrentUser, settingsRowsState, mockGetSessionCards, mockSessionRunner } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    settingsRowsState: { rows: [] as Array<Record<string, unknown>> },
    mockGetSessionCards: vi.fn(),
    mockSessionRunner: vi.fn(),
  }))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(settingsRowsState.rows),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/cards/get-session-cards', () => ({
  getSessionCards: mockGetSessionCards,
}))

// S-cache-1: page.tsx は StudySessionHost を render する。 host が受け取る
// `cards` / `fsrsMode` を従来の SessionRunner mock と同じ shape で受けて
// 既存 assertion (`mockSessionRunner.mock.calls[0][0]` 等) を維持できる。
vi.mock('./_components/study-session-host', () => ({
  StudySessionHost: (props: { cards: Card[]; fsrsMode: boolean }) => {
    mockSessionRunner(props)
    return (
      <div data-testid="session-runner-mock">
        cards={props.cards.length}/fsrsMode={String(props.fsrsMode)}
      </div>
    )
  },
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import SmartStudyPage from './page'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const fakeUser = {
  id: 'user-1',
  clerkId: 'clerk-1',
  email: 'test@example.com',
  plan: 'free' as const,
  billingInterval: null,
  deletedAt: null,
  stripeCustomerId: null,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

function makeCard(id: string): Card {
  return {
    id,
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    title: `q-${id}`,
    sortKey: null,
    questionText: 'q text',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correctAnswerIds: ['a'],
    explanationText: null,
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
    contentVersion: 0,
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
  } as Card
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsRowsState.rows = []
  mockGetCurrentUser.mockResolvedValue(fakeUser)
  mockGetSessionCards.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

async function renderPage() {
  const ui = await SmartStudyPage()
  render(ui)
}

describe('SmartStudyPage', () => {
  it('未認証 (getCurrentUser → null) → null を返し render 不発火', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const ui = await SmartStudyPage()
    expect(ui).toBeNull()
    expect(mockGetSessionCards).not.toHaveBeenCalled()
  })

  it('cards 0 件 → 「ありません」案内 + ダッシュボードリンク表示', async () => {
    mockGetSessionCards.mockResolvedValueOnce([])
    await renderPage()
    expect(screen.getByText(/現在復習する card はありません/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'ダッシュボードへ' })).toHaveAttribute('href', '/app')
    // SessionRunner は render されない
    expect(screen.queryByTestId('session-runner-mock')).not.toBeInTheDocument()
  })

  it('cards >= 1 件 → SessionRunner が render される', async () => {
    mockGetSessionCards.mockResolvedValueOnce([makeCard('c1'), makeCard('c2')])
    settingsRowsState.rows = [{ sessionLimit: 30, fsrsMode: true }]
    await renderPage()
    expect(screen.getByTestId('session-runner-mock')).toBeInTheDocument()
    expect(mockSessionRunner).toHaveBeenCalledOnce()
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.cards).toHaveLength(2)
    expect(props.fsrsMode).toBe(true)
  })

  it('userSettings 行不在 → sessionLimit=20 / fsrsMode=false fallback で SessionRunner に渡す', async () => {
    settingsRowsState.rows = []
    mockGetSessionCards.mockResolvedValueOnce([makeCard('c1')])
    await renderPage()
    // getSessionCards に limit=20 が渡る
    expect(mockGetSessionCards).toHaveBeenCalledWith('user-1', 20)
    // SessionRunner には fsrsMode=false が渡る
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.fsrsMode).toBe(false)
  })

  it('userSettings 行存在 (sessionLimit=50) → getSessionCards に limit=50 が渡る', async () => {
    settingsRowsState.rows = [{ sessionLimit: 50, fsrsMode: false }]
    mockGetSessionCards.mockResolvedValueOnce([makeCard('c1')])
    await renderPage()
    expect(mockGetSessionCards).toHaveBeenCalledWith('user-1', 50)
  })

  it('userSettings 行存在 (fsrsMode=true) → SessionRunner に fsrsMode=true', async () => {
    settingsRowsState.rows = [{ sessionLimit: 20, fsrsMode: true }]
    mockGetSessionCards.mockResolvedValueOnce([makeCard('c1')])
    await renderPage()
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.fsrsMode).toBe(true)
  })
})
