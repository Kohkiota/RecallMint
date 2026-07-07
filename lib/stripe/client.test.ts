import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Stripe from 'stripe'

// VERCEL_ENV-aware key validation (CLAUDE.md §Stripe-1)。 lib/clerk.test.ts と同形式。
// - production → live keys 必須、 test keys 拒否
// - それ以外 (preview / development / undefined) → test keys 必須、 live keys 拒否

describe('Stripe client - non-production (VERCEL_ENV undefined / preview / development)', () => {
  beforeEach(() => {
    // 既知 baseline で start。 各テストで mutate して mode 強制を検証
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake_for_tests'
    delete process.env.VERCEL_ENV
  })

  it('Unset STRIPE_SECRET_KEY throws with message mentioning the key name', async () => {
    delete process.env.STRIPE_SECRET_KEY
    await expect(import('./client')).rejects.toThrow(/STRIPE_SECRET_KEY/)
  })

  it('Unset STRIPE_PUBLISHABLE_KEY throws with message mentioning the key name', async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY
    await expect(import('./client')).rejects.toThrow(/STRIPE_PUBLISHABLE_KEY/)
  })

  it('sk_live_ SECRET key is rejected with message mentioning both rk_test_ and sk_test_', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123'
    await expect(import('./client')).rejects.toThrow(
      /rk_test_.*sk_test_|sk_test_.*rk_test_/,
    )
  })

  it('rk_live_ SECRET key is rejected with message mentioning both rk_test_ and sk_test_', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_abc123'
    await expect(import('./client')).rejects.toThrow(
      /rk_test_.*sk_test_|sk_test_.*rk_test_/,
    )
  })

  it('pk_live_ PUBLISHABLE key is rejected with message mentioning pk_test_', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_abc123'
    await expect(import('./client')).rejects.toThrow(/pk_test_/)
  })

  it('rk_test_ + pk_test_ are accepted and stripe is exported', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_test_abc123'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_abc123'
    const mod = await import('./client')
    expect(mod.stripe).toBeDefined()
  })

  it('sk_test_ + pk_test_ are accepted and stripe is exported', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_abc123'
    const mod = await import('./client')
    expect(mod.stripe).toBeDefined()
  })

  it('VERCEL_ENV=preview rejects sk_live_ (live keys not allowed outside production)', async () => {
    process.env.VERCEL_ENV = 'preview'
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123'
    await expect(import('./client')).rejects.toThrow(/sk_test_/)
  })

  it('VERCEL_ENV=preview rejects pk_live_ (live keys not allowed outside production)', async () => {
    process.env.VERCEL_ENV = 'preview'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_abc123'
    await expect(import('./client')).rejects.toThrow(/pk_test_/)
  })
})

describe('Stripe client - production (VERCEL_ENV=production)', () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = 'production'
    process.env.STRIPE_SECRET_KEY = 'sk_live_fake_for_tests'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_fake_for_tests'
  })

  it('Unset STRIPE_SECRET_KEY in prod throws with message mentioning the key name', async () => {
    delete process.env.STRIPE_SECRET_KEY
    await expect(import('./client')).rejects.toThrow(/STRIPE_SECRET_KEY/)
  })

  it('Unset STRIPE_PUBLISHABLE_KEY in prod throws with message mentioning the key name', async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY
    await expect(import('./client')).rejects.toThrow(/STRIPE_PUBLISHABLE_KEY/)
  })

  it('sk_live_ + pk_live_ are accepted and stripe is exported', async () => {
    const mod = await import('./client')
    expect(mod.stripe).toBeDefined()
  })

  it('rk_live_ + pk_live_ are accepted (Restricted Key path)', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_abc123'
    const mod = await import('./client')
    expect(mod.stripe).toBeDefined()
  })

  it('sk_test_ SECRET key is rejected with message mentioning sk_live_', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    await expect(import('./client')).rejects.toThrow(/sk_live_/)
  })

  it('rk_test_ SECRET key is rejected with message mentioning rk_live_', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_test_abc123'
    await expect(import('./client')).rejects.toThrow(/rk_live_/)
  })

  it('pk_test_ PUBLISHABLE key is rejected with message mentioning pk_live_', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_abc123'
    await expect(import('./client')).rejects.toThrow(/pk_live_/)
  })
})

describe('cancelWithRetry', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests'
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake_for_tests'
    delete process.env.VERCEL_ENV
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('succeeds in 1 call when cancel resolves on first attempt', async () => {
    const { stripe, cancelWithRetry } = await import('./client')
    const cancelSpy = vi
      .spyOn(stripe.subscriptions, 'cancel')
      .mockResolvedValueOnce({} as never)
    await cancelWithRetry('sub_123')
    expect(cancelSpy).toHaveBeenCalledOnce()
    expect(cancelSpy).toHaveBeenCalledWith('sub_123')
  })

  it('retries once on 429 and succeeds on the 2nd call', async () => {
    const { stripe, cancelWithRetry } = await import('./client')
    const cancelSpy = vi
      .spyOn(stripe.subscriptions, 'cancel')
      .mockRejectedValueOnce(new Stripe.errors.StripeRateLimitError())
      .mockResolvedValueOnce({} as never)
    const promise = cancelWithRetry('sub_123')
    await vi.advanceTimersByTimeAsync(1000)
    await promise
    expect(cancelSpy).toHaveBeenCalledTimes(2)
  })

  it('throws on 2nd consecutive 429 (retry budget = 1)', async () => {
    const { stripe, cancelWithRetry } = await import('./client')
    const cancelSpy = vi
      .spyOn(stripe.subscriptions, 'cancel')
      .mockRejectedValueOnce(new Stripe.errors.StripeRateLimitError())
      .mockRejectedValueOnce(new Stripe.errors.StripeRateLimitError())
    // Attach catch immediately to avoid unhandled rejection while fake timers
    // delay the resolution by 1 sec.
    const errPromise = cancelWithRetry('sub_123').catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(1000)
    const err = await errPromise
    expect(err).toBeInstanceOf(Stripe.errors.StripeRateLimitError)
    expect(cancelSpy).toHaveBeenCalledTimes(2)
  })
})
