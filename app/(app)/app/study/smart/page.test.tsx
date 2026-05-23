// @vitest-environment jsdom
// SmartStudyEntryPage tests.
//
// page は server component (async function)。 getCurrentUser + db SELECT を
// mock し、 await Page() で JSX を取得して render する。
// I-1 regression guard: description に 'session_limit' を含めない。
// I-2: 開始 button (client) click で revalidateAppPath が呼ばれる。
// T3: 現在の session_limit を「XX 枚」で表示。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockGetCurrentUser, settingsRowsState, mockRevalidate } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  // SELECT chain が返す行を test ごとに差し替えるための可変 state
  settingsRowsState: { rows: [] as Array<Record<string, unknown>> },
  mockRevalidate: vi.fn(),
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

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
  }: {
    href: string
    children: React.ReactNode
    onClick?: (e: React.MouseEvent) => void
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))

vi.mock('@/app/(app)/app/_actions/revalidate', () => ({
  revalidateAppPath: mockRevalidate,
}))

import SmartStudyEntryPage from './page'

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

beforeEach(() => {
  vi.clearAllMocks()
  settingsRowsState.rows = []
  mockGetCurrentUser.mockResolvedValue(fakeUser)
})

afterEach(() => {
  cleanup()
})

// Helper: async server component を await して render する
async function renderPage() {
  const ui = await SmartStudyEntryPage()
  render(ui)
}

describe('SmartStudyEntryPage', () => {
  it('タイトル・説明文・スタートリンクが正しく描画される', async () => {
    settingsRowsState.rows = [{ sessionLimit: 20, fsrsMode: false }]
    await renderPage()
    expect(screen.getByRole('heading', { name: 'スマート復習' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'スマート復習を始める' })).toHaveAttribute(
      'href',
      '/app/study/smart/session',
    )
    expect(screen.getByText(/設定した上限枚数まで/)).toBeInTheDocument()
  })

  it('「スマート復習を始める」click で revalidateAppPath(/app/study/smart/session) が呼ばれる', async () => {
    settingsRowsState.rows = [{ sessionLimit: 20, fsrsMode: false }]
    await renderPage()
    fireEvent.click(screen.getByRole('link', { name: 'スマート復習を始める' }))
    expect(mockRevalidate).toHaveBeenCalledTimes(1)
    expect(mockRevalidate).toHaveBeenCalledWith('/app/study/smart/session')
  })

  it('説明文に "session_limit" という文字列が含まれない (I-1 regression guard)', async () => {
    settingsRowsState.rows = [{ sessionLimit: 20, fsrsMode: false }]
    await renderPage()
    const description = screen.getByText(/設定した上限枚数まで/)
    expect(description.textContent).not.toContain('session_limit')
  })

  describe('T3: 現在の session_limit 表示', () => {
    it('sessionLimit=20 → 「20 枚」と表示', async () => {
      settingsRowsState.rows = [{ sessionLimit: 20, fsrsMode: false }]
      await renderPage()
      expect(screen.getByText(/現在の設定:/)).toBeInTheDocument()
      expect(screen.getByText('20 枚')).toBeInTheDocument()
    })

    it('sessionLimit=50 → 「50 枚」と表示', async () => {
      settingsRowsState.rows = [{ sessionLimit: 50, fsrsMode: false }]
      await renderPage()
      expect(screen.getByText('50 枚')).toBeInTheDocument()
    })

    it('user_settings 行不在 (0 件) → default 20 で「20 枚」と表示', async () => {
      settingsRowsState.rows = []
      await renderPage()
      expect(screen.getByText('20 枚')).toBeInTheDocument()
    })
  })
})
