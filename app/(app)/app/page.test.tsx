// @vitest-environment jsdom
// Dashboard page(/app)。RSC なので `await Page()` で JSX を取り出して render する
// (quick/page.test.tsx と同型)。
//
// このページの RSC 側の責務は 3 つだけ: ① searchParams から `billing` / `exam` を
// 抜いて client へ渡す ② BillingBanner と「プラン変更」リンクを残す
// ③ HomeDashboard を置く。DB SELECT は行わない(S-perf-3 維持)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { mockGetCurrentUser, mockHomeDashboard } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockHomeDashboard: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('./_components/home/home-dashboard', () => ({
  HomeDashboard: (props: Record<string, unknown>) => {
    mockHomeDashboard(props)
    return <div data-testid="home-dashboard-mock" />
  },
}))

import Dashboard from './page'

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

async function renderPage(sp: Record<string, string | string[] | undefined> = {}) {
  const ui = await Dashboard({ searchParams: Promise.resolve(sp) })
  return render(ui)
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockGetCurrentUser.mockResolvedValue(fakeUser)
  mockHomeDashboard.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('Dashboard page', () => {
  it('HomeDashboard に userId と URL の exam を渡す', async () => {
    await renderPage({ exam: EXAM })
    expect(mockHomeDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', urlExamId: EXAM }),
    )
  })

  it('exam が配列で来たら先頭のみ採用する', async () => {
    await renderPage({ exam: [EXAM, 'other'] })
    expect(mockHomeDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ urlExamId: EXAM }),
    )
  })

  it('exam 不在なら undefined を渡す(client resolver が保存値 / 1 件自動で解決する)', async () => {
    await renderPage({})
    expect(mockHomeDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ urlExamId: undefined }),
    )
  })

  it('BillingBanner を残す(billing param を渡す)', async () => {
    await renderPage({ billing: 'upgrade' })
    expect(screen.getByRole('status')).toHaveTextContent(
      '支払い確認後にプランが反映されます。',
    )
  })

  it('「プラン変更」リンクを残す', async () => {
    await renderPage({})
    expect(screen.getByRole('link', { name: 'プラン変更' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
  })

  it('Pro 年額でも「プラン変更」CTA を表示する(除外撤廃・旧 Task 8 の pin)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...fakeUser,
      plan: 'pro' as const,
      billingInterval: 'year' as const,
    })
    await renderPage({})
    expect(screen.getByRole('link', { name: 'プラン変更' })).toHaveAttribute(
      'href',
      '/app/upgrade',
    )
    // 旧「アップグレード」文言は残さない
    expect(screen.queryByRole('link', { name: 'アップグレード' })).toBeNull()
  })

  it('billing なしでは banner を出さない(旧 Task 8 の pin)', async () => {
    await renderPage({})
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('撤去した DashboardStats / DashboardActions の CTA は出さない', async () => {
    await renderPage({})
    expect(screen.queryByText('今日の学習問題数')).toBeNull()
    expect(screen.queryByText(/復習完了/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'カスタム演習' })).toBeNull()
  })
})
