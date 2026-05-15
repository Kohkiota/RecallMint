import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Stripe from 'stripe'

describe('Stripe client', () => {
  beforeEach(() => {
    // vitest.setup.ts already calls vi.resetModules() in a global beforeEach,
    // but we set the base value here so each test can mutate it cleanly
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests'
  })

  it('Unset STRIPE_SECRET_KEY throws with message mentioning the key name', async () => {
    delete process.env.STRIPE_SECRET_KEY
    await expect(import('./stripe')).rejects.toThrow(/STRIPE_SECRET_KEY/)
  })

  it('sk_live_ key is rejected with message mentioning both rk_test_ and sk_test_', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123'
    await expect(import('./stripe')).rejects.toThrow(
      /rk_test_.*sk_test_|sk_test_.*rk_test_/,
    )
  })

  it('rk_live_ key is rejected with message mentioning both rk_test_ and sk_test_', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_abc123'
    await expect(import('./stripe')).rejects.toThrow(
      /rk_test_.*sk_test_|sk_test_.*rk_test_/,
    )
  })

  it('rk_test_ key is accepted and stripe is exported', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_test_abc123'
    const mod = await import('./stripe')
    expect(mod.stripe).toBeDefined()
  })

  it('sk_test_ key is accepted and stripe is exported', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    const mod = await import('./stripe')
    expect(mod.stripe).toBeDefined()
  })
})

describe('cancelWithRetry', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests'
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('succeeds in 1 call when cancel resolves on first attempt', async () => {
    const { stripe, cancelWithRetry } = await import('./stripe')
    const cancelSpy = vi
      .spyOn(stripe.subscriptions, 'cancel')
      .mockResolvedValueOnce({} as never)
    await cancelWithRetry('sub_123')
    expect(cancelSpy).toHaveBeenCalledOnce()
    expect(cancelSpy).toHaveBeenCalledWith('sub_123')
  })

  it('retries once on 429 and succeeds on the 2nd call', async () => {
    const { stripe, cancelWithRetry } = await import('./stripe')
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
    const { stripe, cancelWithRetry } = await import('./stripe')
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
