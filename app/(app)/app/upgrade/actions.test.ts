import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetCurrentUser,
  mockCheckoutCreate,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockCheckoutCreate: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    checkout: { sessions: { create: mockCheckoutCreate } },
  },
}))

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    // Next.js の redirect は throw でフロー終了する semantics を持つので
    // test 側で同等の throw を投げて assert で捕捉する。
    throw new Error(`__REDIRECT__:${url}`)
  },
}))

import { createCheckoutSession } from './actions'

const baseUser = {
  id: 'u_1',
  clerkId: 'clerk_u_1',
  email: 'test@example.com',
  stripeCustomerId: null,
  plan: 'free' as const,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAt: null,
  billingInterval: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentUser.mockResolvedValue(baseUser)
  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/test/abc' })
})

function fd(plan: string, interval: string): FormData {
  const f = new FormData()
  f.set('plan', plan)
  f.set('interval', interval)
  return f
}

describe('createCheckoutSession: 4 種類 (plan × interval) を Stripe Checkout に渡す', () => {
  it('Standard monthly: STRIPE_PRICE_STANDARD_MONTHLY を渡し redirect', async () => {
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      /__REDIRECT__:https:\/\/checkout/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [
          { price: process.env.STRIPE_PRICE_STANDARD_MONTHLY, quantity: 1 },
        ],
      }),
    )
  })

  it('Standard yearly', async () => {
    await expect(createCheckoutSession(fd('standard', 'year'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          { price: process.env.STRIPE_PRICE_STANDARD_YEARLY, quantity: 1 },
        ],
      }),
    )
  })

  it('Pro monthly', async () => {
    await expect(createCheckoutSession(fd('pro', 'month'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          { price: process.env.STRIPE_PRICE_PRO_MONTHLY, quantity: 1 },
        ],
      }),
    )
  })

  it('Pro yearly', async () => {
    await expect(createCheckoutSession(fd('pro', 'year'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          { price: process.env.STRIPE_PRICE_PRO_YEARLY, quantity: 1 },
        ],
      }),
    )
  })
})

describe('createCheckoutSession: 不正入力 / 未同期 user 拒否', () => {
  it('plan が未対応値 (free / null / garbage) → throw、 Stripe 呼ばない', async () => {
    await expect(createCheckoutSession(fd('free', 'month'))).rejects.toThrow(/Invalid plan/)
    await expect(createCheckoutSession(fd('garbage', 'month'))).rejects.toThrow(/Invalid plan/)
    // null は FormData.set で文字列化されるため、 plan キー未設定で再現
    const fEmpty = new FormData()
    fEmpty.set('interval', 'month')
    await expect(createCheckoutSession(fEmpty)).rejects.toThrow(/Invalid plan/)

    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('interval が未対応値 (weekly / 空) → throw、 Stripe 呼ばない', async () => {
    await expect(createCheckoutSession(fd('standard', 'weekly'))).rejects.toThrow(
      /Invalid interval/,
    )
    const fEmpty = new FormData()
    fEmpty.set('plan', 'standard')
    await expect(createCheckoutSession(fEmpty)).rejects.toThrow(/Invalid interval/)

    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('getCurrentUser null (webhook race) → USER_NOT_SYNCED throw、 Stripe 呼ばない', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      'USER_NOT_SYNCED',
    )
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('stripeCustomerId 既存時: customer を渡し customer_email は undefined', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({
      ...baseUser,
      stripeCustomerId: 'cus_existing',
    })
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
        customer_email: undefined,
      }),
    )
  })
})
