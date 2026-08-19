// @vitest-environment jsdom
// QuickStudyPage tests (design doc §7)。
//
// page は server component (async function)。 getCurrentUser + user_settings 読み
// を mock し、 await Page() で JSX を取得して render する。 quick は server 側の
// card 取得を持たない(smart/page.test.tsx と異なる)ため、 assertion は
// QuickSessionHost に渡る props(userId/sessionLimit/fsrsMode/examId/preset/
// tagOptionId)のみを見る。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { mockGetCurrentUser, settingsRowsState, mockQuickSessionHost } = vi.hoisted(
  () => ({
    mockGetCurrentUser: vi.fn(),
    settingsRowsState: { rows: [] as Array<Record<string, unknown>> },
    mockQuickSessionHost: vi.fn(),
  }),
)

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

vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: vi.fn(async (_userId: string, fn: (tx: unknown) => unknown) => {
    const { getDb } = await import('@/lib/db')
    return fn(getDb())
  }),
}))

vi.mock('./_components/quick-session-host', () => ({
  QuickSessionHost: (props: Record<string, unknown>) => {
    mockQuickSessionHost(props)
    return <div data-testid="quick-session-host-mock" />
  },
}))

import QuickStudyPage from './page'

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

const EXAM = '11111111-2222-3333-4444-555555555555'

async function renderPage(
  searchParams: { [k: string]: string | string[] | undefined } = {},
) {
  const ui = await QuickStudyPage({ searchParams: Promise.resolve(searchParams) })
  render(ui)
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsRowsState.rows = []
  mockGetCurrentUser.mockResolvedValue(fakeUser)
})

afterEach(() => {
  cleanup()
})

describe('QuickStudyPage', () => {
  it('未認証 (getCurrentUser → null) → null を返し render 不発火', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const ui = await QuickStudyPage({ searchParams: Promise.resolve({}) })
    expect(ui).toBeNull()
    expect(mockQuickSessionHost).not.toHaveBeenCalled()
  })

  it('exam / preset / tag を QuickSessionHost にそのまま渡す', async () => {
    await renderPage({ exam: EXAM, preset: 'mistakes', tag: 'opt-1' })
    expect(screen.getByTestId('quick-session-host-mock')).toBeInTheDocument()
    expect(mockQuickSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        examId: EXAM,
        preset: 'mistakes',
        tagOptionId: 'opt-1',
      }),
    )
  })

  it('exam / preset / tag 不在(bookmark 直行)→ undefined で host に委ねる', async () => {
    await renderPage({})
    expect(mockQuickSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({
        examId: undefined,
        preset: undefined,
        tagOptionId: undefined,
      }),
    )
  })

  it('?preset=a&preset=b (配列) → 先頭のみ採用', async () => {
    await renderPage({ preset: ['mistakes', 'weak'] })
    expect(mockQuickSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'mistakes' }),
    )
  })

  it('userSettings 行不在 → sessionLimit=20 / fsrsMode=false fallback', async () => {
    settingsRowsState.rows = []
    await renderPage({})
    expect(mockQuickSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ sessionLimit: 20, fsrsMode: false }),
    )
  })

  it('userSettings 行存在 → sessionLimit / fsrsMode をそのまま渡す', async () => {
    settingsRowsState.rows = [{ sessionLimit: 5, fsrsMode: true }]
    await renderPage({})
    expect(mockQuickSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ sessionLimit: 5, fsrsMode: true }),
    )
  })

  it('session_limit が明示 null(上限なし)→ null のまま渡す', async () => {
    settingsRowsState.rows = [{ sessionLimit: null, fsrsMode: false }]
    await renderPage({})
    expect(mockQuickSessionHost).toHaveBeenCalledWith(
      expect.objectContaining({ sessionLimit: null }),
    )
  })
})

// ---------------------------------------------------------------------------
// origin query param は一切読まない(§7・§11.1)。 QuickSessionHost に origin という
// prop 自体を持たせていない(host が preset/tag から自分で導出する)ので、 query
// に origin が乗っていても host への props には一切現れないことを確認する。
// ---------------------------------------------------------------------------
describe('QuickStudyPage — origin query param は無視される(§7)', () => {
  it('?origin=... を渡しても QuickSessionHost の props に origin キーが無い', async () => {
    await renderPage({ exam: EXAM, preset: 'mistakes', origin: 'evil_injected_value' })
    const props = mockQuickSessionHost.mock.calls[0][0] as Record<string, unknown>
    expect(props).not.toHaveProperty('origin')
    // query の値がどこにも紛れ込んでいないことも確認
    expect(Object.values(props)).not.toContain('evil_injected_value')
  })
})
