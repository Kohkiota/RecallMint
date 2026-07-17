import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- hoisted mocks ---
const { mockGetCurrentUser, mockRedirect, mockPortalCreate } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  // Next.js `redirect()` signals navigation by throwing NEXT_REDIRECT
  mockRedirect: vi.fn((_url: string) => {
    throw new Error('NEXT_REDIRECT')
  }),
  mockPortalCreate: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}))

// stripe mock は createBillingPortalSession のために残す
vi.mock('@/lib/stripe/client', () => ({
  stripe: { billingPortal: { sessions: { create: mockPortalCreate } } },
}))

import { createBillingPortalSession } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  // vi.clearAllMocks() wipes implementations, re-install NEXT_REDIRECT throw
  mockRedirect.mockImplementation((_url: string) => {
    throw new Error('NEXT_REDIRECT')
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createBillingPortalSession', () => {
  it('USER_NOT_SYNCED: getCurrentUser null → throws USER_NOT_SYNCED', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    await expect(createBillingPortalSession()).rejects.toThrow('USER_NOT_SYNCED')
  })

  it('Stripe customer not set → throws', async () => {
    mockGetCurrentUser.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000004',
      clerkId: 'user_1',
      email: 'a@example.com',
      stripeCustomerId: null,
      plan: 'free',
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAt: null,
      billingInterval: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    })
    await expect(createBillingPortalSession()).rejects.toThrow(
      'Stripe customer is not set for this user',
    )
  })

  // 監査 2026-07-17 G3: guard 経路のみで成功経路が未検証だった。決済隣接のため
  // customer / return_url の実引数と redirect(session.url) 発火を pin する。
  it('成功経路: stripeCustomerId と return_url で portal session を作成し session.url へ redirect', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://recallmint.example')
    mockGetCurrentUser.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000004',
      clerkId: 'user_1',
      email: 'a@example.com',
      stripeCustomerId: 'cus_test_123',
      plan: 'standard',
      subscriptionStatus: 'active',
      currentPeriodEnd: null,
      cancelAt: null,
      billingInterval: 'month',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    })
    mockPortalCreate.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session_xyz',
    })

    // redirect() は NEXT_REDIRECT throw で navigation を表現する (Next 仕様)
    await expect(createBillingPortalSession()).rejects.toThrow('NEXT_REDIRECT')

    expect(mockPortalCreate).toHaveBeenCalledTimes(1)
    expect(mockPortalCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      return_url: 'https://recallmint.example/app/settings',
    })
    expect(mockRedirect).toHaveBeenCalledWith(
      'https://billing.stripe.com/p/session_xyz',
    )
  })
})
