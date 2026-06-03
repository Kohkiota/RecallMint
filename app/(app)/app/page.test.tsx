// @vitest-environment jsdom
// Dashboard (server component) の render test。
//
// 観点 (Task 8):
// - 全 plan で「プラン変更」CTA を /app/upgrade に表示 (Pro 年額の除外撤廃)
// - ?billing=<kind> を searchParams (Next 15 Promise) から抽出し BillingBanner へ渡す
//
// getCurrentUser / 子 client component / next/link を mock し await Dashboard() で
// JSX を取得して render する (study/smart/page.test.tsx と同方針)。

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { mockGetCurrentUser } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

// 子 component は DB / Dexie 依存なので mock で無害化 (本 test の関心外)。
vi.mock('./_components/dashboard-stats', () => ({
  DashboardStats: () => <div data-testid="dashboard-stats" />,
}))
vi.mock('./_components/dashboard-actions', () => ({
  DashboardActions: () => <div data-testid="dashboard-actions" />,
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import Dashboard from './page'

const baseUser = {
  id: 'u_1',
  plan: 'free' as const,
  billingInterval: null as 'month' | 'year' | null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentUser.mockResolvedValue(baseUser)
})

afterEach(() => {
  cleanup()
})

function sp(params: Record<string, string>) {
  return Promise.resolve(params)
}

describe('Dashboard CTA: プラン変更 entry 統一', () => {
  it('free: 「プラン変更」CTA を /app/upgrade に表示', async () => {
    render(await Dashboard({ searchParams: sp({}) }))
    const cta = screen.getByRole('link', { name: 'プラン変更' })
    expect(cta).toHaveAttribute('href', '/app/upgrade')
  })

  it('Pro 年額でも「プラン変更」CTA を表示 (除外撤廃)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...baseUser,
      plan: 'pro',
      billingInterval: 'year',
    })
    render(await Dashboard({ searchParams: sp({}) }))
    expect(screen.getByRole('link', { name: 'プラン変更' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
    // 旧「アップグレード」文言は残さない
    expect(
      screen.queryByRole('link', { name: 'アップグレード' }),
    ).not.toBeInTheDocument()
  })
})

describe('Dashboard billing banner: searchParams 連携', () => {
  it('?billing=new で banner 文言を表示', async () => {
    render(await Dashboard({ searchParams: sp({ billing: 'new' }) }))
    expect(screen.getByRole('status')).toHaveTextContent(
      '決済を受け付けました。反映まで少し時間がかかる場合があります。',
    )
  })

  it('billing なしでは banner を出さない', async () => {
    render(await Dashboard({ searchParams: sp({}) }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
