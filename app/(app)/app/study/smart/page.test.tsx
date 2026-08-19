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

// RLS-P2/P3 Wave2: page は getSessionCards と user_settings read を withTenantTx(userId, ...)
// で包む(RLS-P3 Task 2 で getDb を内部取得する署名へ変更)。fake getDb() は transaction を
// 持たないため withTenantTx を stub し、本物同様に内部で getDb() を呼んで fn に mock db を
// 渡す(user_settings read の tx.select().from()... が mock db 経由で解決される)。
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: vi.fn(
    async (_userId: string, fn: (tx: unknown) => unknown) => {
      const { getDb } = await import('@/lib/db')
      return fn(getDb())
    },
  ),
}))

// S-cache-1: page.tsx は StudySessionHost を render する。 host が受け取る
// `cards` / `fsrsMode` を従来の SessionRunner mock と同じ shape で受けて
// 既存 assertion (`mockSessionRunner.mock.calls[0][0]` 等) を維持できる。
vi.mock('./_components/study-session-host', () => ({
  StudySessionHost: (props: {
    cards: Card[]
    fsrsMode: boolean
    examId: string | undefined
    origin: string
  }) => {
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
    baseOrder: 1024,
    sourceDocumentId: null,
    title: `q-${id}`,
    questionLabel: null,
    questionText: 'q text',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    images: [],
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
    firstReviewedAt: null,
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

// Dash-1 Home v1 §8.5: exam / origin を searchParams から読むようになったため、
// 既定では「W2 CTA と同じ形」(exam あり) で render する。
const EXAM = '11111111-2222-3333-4444-555555555555'

async function renderPage(
  searchParams: { [k: string]: string | string[] | undefined } = { exam: EXAM },
) {
  const ui = await SmartStudyPage({ searchParams: Promise.resolve(searchParams) })
  render(ui)
}

describe('SmartStudyPage', () => {
  it('未認証 (getCurrentUser → null) → null を返し render 不発火', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const ui = await SmartStudyPage({ searchParams: Promise.resolve({}) })
    expect(ui).toBeNull()
    expect(mockGetSessionCards).not.toHaveBeenCalled()
  })

  it('cards 0 件 → StudySessionHost に cards=[] で進む (empty UI 表示は host 側で行う)', async () => {
    // S-local-4: 旧 page.tsx で行っていた「ありません」 page 早期 return は撤回。
    // Dexie cards との empty 判定は StudySessionHost に集約 (offline + 両方 0 件
    // のときも host 内で empty UI を出すため)。
    mockGetSessionCards.mockResolvedValueOnce([])
    await renderPage()
    expect(screen.getByTestId('session-runner-mock')).toBeInTheDocument()
    expect(mockSessionRunner).toHaveBeenCalledOnce()
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.cards).toEqual([])
  })

  it('S-local-4: getSessionCards が throw (server fetch fail / offline) → cards=[] で StudySessionHost に進む', async () => {
    mockGetSessionCards.mockRejectedValueOnce(new Error('network down'))
    await renderPage()
    // page render は成功 (no 500 / no error boundary 発火)
    expect(screen.getByTestId('session-runner-mock')).toBeInTheDocument()
    // cards は空配列で渡る → host 側で Dexie cards 試行 / empty UI 判定
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.cards).toEqual([])
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
    // getSessionCards に examId + limit=20 が渡る (dbc = withTenantTx の tx)
    expect(mockGetSessionCards).toHaveBeenCalledWith(
      'user-1',
      EXAM,
      20,
      expect.anything(),
    )
    // SessionRunner には fsrsMode=false が渡る
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.fsrsMode).toBe(false)
  })

  it('userSettings 行存在 (sessionLimit=50) → getSessionCards に limit=50 が渡る', async () => {
    settingsRowsState.rows = [{ sessionLimit: 50, fsrsMode: false }]
    mockGetSessionCards.mockResolvedValueOnce([makeCard('c1')])
    await renderPage()
    expect(mockGetSessionCards).toHaveBeenCalledWith(
      'user-1',
      EXAM,
      50,
      expect.anything(),
    )
  })

  it('userSettings 行存在 (fsrsMode=true) → SessionRunner に fsrsMode=true', async () => {
    settingsRowsState.rows = [{ sessionLimit: 20, fsrsMode: true }]
    mockGetSessionCards.mockResolvedValueOnce([makeCard('c1')])
    await renderPage()
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.fsrsMode).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dash-1 Home v1 §8.5 / §6: exam scope
// ---------------------------------------------------------------------------
describe('SmartStudyPage — exam の受け渡し(§8.5)', () => {
  it('?exam=<uuid> を getSessionCards と host の examId prop に渡す', async () => {
    await renderPage({ exam: EXAM })
    expect(mockGetSessionCards).toHaveBeenCalledWith(
      'user-1',
      EXAM,
      20,
      expect.anything(),
    )
    expect(mockSessionRunner.mock.calls[0][0].examId).toBe(EXAM)
  })

  it('exam 不在 (bookmark 直行) → server 取得を行わず、examId=undefined で host に委ねる', async () => {
    // 試験の解決は Dexie(保存値 / 1 件自動)を要するため client の共通 resolver の
    // 責務。ここで別の解決手段を持たない = server 取得はしない。
    await renderPage({})
    expect(mockGetSessionCards).not.toHaveBeenCalled()
    const props = mockSessionRunner.mock.calls[0][0]
    expect(props.examId).toBeUndefined()
    expect(props.cards).toEqual([])
  })

  it('?exam=a&exam=b (配列) → 先頭のみ採用', async () => {
    await renderPage({ exam: [EXAM, 'other'] })
    expect(mockSessionRunner.mock.calls[0][0].examId).toBe(EXAM)
  })
})

// ---------------------------------------------------------------------------
// Dash-1 Home v1 §11: origin の正規化(query を信頼しない)
// ---------------------------------------------------------------------------
describe('SmartStudyPage — origin の正規化(§11.3 / Task 4 Ruling 12)', () => {
  it('?origin=home_today は通す', async () => {
    await renderPage({ exam: EXAM, origin: 'home_today' })
    expect(mockSessionRunner.mock.calls[0][0].origin).toBe('home_today')
  })

  it('未知値は smart に落とす', async () => {
    await renderPage({ exam: EXAM, origin: 'home_todayy' })
    expect(mockSessionRunner.mock.calls[0][0].origin).toBe('smart')
  })

  it('64 文字超の値は smart に落とす(wire schema 違反 = 回答 event の恒久破棄を防ぐ)', async () => {
    await renderPage({ exam: EXAM, origin: 'x'.repeat(65) })
    expect(mockSessionRunner.mock.calls[0][0].origin).toBe('smart')
  })

  it('origin 不在は smart(§11.1 の既定)', async () => {
    await renderPage({ exam: EXAM })
    expect(mockSessionRunner.mock.calls[0][0].origin).toBe('smart')
  })

  it('home_today 以外の既知値 (custom 等) も smart に落とす(この入口の値ではない)', async () => {
    await renderPage({ exam: EXAM, origin: 'custom' })
    expect(mockSessionRunner.mock.calls[0][0].origin).toBe('smart')
  })
})
