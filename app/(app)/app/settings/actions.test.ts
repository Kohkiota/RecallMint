import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- hoisted mocks ---
const { mockGetCurrentUser, mockRedirect } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  // Next.js `redirect()` signals navigation by throwing NEXT_REDIRECT
  mockRedirect: vi.fn((_url: string) => {
    throw new Error('NEXT_REDIRECT')
  }),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}))

// stripe mock は createBillingPortalSession のために残す
vi.mock('@/lib/stripe', () => ({
  stripe: { billingPortal: { sessions: { create: vi.fn() } } },
}))

import { createBillingPortalSession } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  // vi.clearAllMocks() wipes implementations, re-install NEXT_REDIRECT throw
  mockRedirect.mockImplementation((_url: string) => {
    throw new Error('NEXT_REDIRECT')
  })
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
      createdAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    })
    await expect(createBillingPortalSession()).rejects.toThrow(
      'Stripe customer is not set for this user',
    )
  })
})
