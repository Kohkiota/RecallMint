import { describe, it, expect, beforeEach, vi } from 'vitest'

// vitest.setup.ts has beforeEach(() => vi.resetModules()), so dynamic
// import() returns a fresh module instance each test — required to exercise
// module-load-time validation paths (missing env / duplicate price IDs).

describe('lib/stripe/price-mapping', () => {
  // Restore baseline env after each mutation since other tests in the suite
  // rely on the fake values set by vitest.setup.ts.
  const baseline = {
    STRIPE_PRICE_STANDARD_MONTHLY: process.env.STRIPE_PRICE_STANDARD_MONTHLY,
    STRIPE_PRICE_STANDARD_YEARLY: process.env.STRIPE_PRICE_STANDARD_YEARLY,
    STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY,
    STRIPE_PRICE_PRO_YEARLY: process.env.STRIPE_PRICE_PRO_YEARLY,
  }

  beforeEach(() => {
    for (const [k, v] of Object.entries(baseline)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  describe('resolveFromPriceId', () => {
    it('returns (standard, month) for STRIPE_PRICE_STANDARD_MONTHLY value', async () => {
      const { resolveFromPriceId } = await import('./price-mapping')
      expect(resolveFromPriceId(baseline.STRIPE_PRICE_STANDARD_MONTHLY!)).toEqual({
        plan: 'standard',
        interval: 'month',
      })
    })

    it('returns (standard, year) for STRIPE_PRICE_STANDARD_YEARLY value', async () => {
      const { resolveFromPriceId } = await import('./price-mapping')
      expect(resolveFromPriceId(baseline.STRIPE_PRICE_STANDARD_YEARLY!)).toEqual({
        plan: 'standard',
        interval: 'year',
      })
    })

    it('returns (pro, month) for STRIPE_PRICE_PRO_MONTHLY value', async () => {
      const { resolveFromPriceId } = await import('./price-mapping')
      expect(resolveFromPriceId(baseline.STRIPE_PRICE_PRO_MONTHLY!)).toEqual({
        plan: 'pro',
        interval: 'month',
      })
    })

    it('returns (pro, year) for STRIPE_PRICE_PRO_YEARLY value', async () => {
      const { resolveFromPriceId } = await import('./price-mapping')
      expect(resolveFromPriceId(baseline.STRIPE_PRICE_PRO_YEARLY!)).toEqual({
        plan: 'pro',
        interval: 'year',
      })
    })

    it('returns null for unknown price_id (caller falls back to free)', async () => {
      const { resolveFromPriceId } = await import('./price-mapping')
      expect(resolveFromPriceId('price_unknown_xyz')).toBeNull()
    })
  })

  describe('priceIdFor', () => {
    it('returns the env value for each (plan, interval) combination', async () => {
      const { priceIdFor } = await import('./price-mapping')
      expect(priceIdFor('standard', 'month')).toBe(baseline.STRIPE_PRICE_STANDARD_MONTHLY)
      expect(priceIdFor('standard', 'year')).toBe(baseline.STRIPE_PRICE_STANDARD_YEARLY)
      expect(priceIdFor('pro', 'month')).toBe(baseline.STRIPE_PRICE_PRO_MONTHLY)
      expect(priceIdFor('pro', 'year')).toBe(baseline.STRIPE_PRICE_PRO_YEARLY)
    })
  })

  describe('module-load validation', () => {
    it('throws when STRIPE_PRICE_STANDARD_MONTHLY is missing', async () => {
      delete process.env.STRIPE_PRICE_STANDARD_MONTHLY
      vi.resetModules()
      await expect(import('./price-mapping')).rejects.toThrow(
        /STRIPE_PRICE_STANDARD_MONTHLY/,
      )
    })

    it('throws when STRIPE_PRICE_STANDARD_YEARLY is missing', async () => {
      delete process.env.STRIPE_PRICE_STANDARD_YEARLY
      vi.resetModules()
      await expect(import('./price-mapping')).rejects.toThrow(
        /STRIPE_PRICE_STANDARD_YEARLY/,
      )
    })

    it('throws when STRIPE_PRICE_PRO_MONTHLY is missing', async () => {
      delete process.env.STRIPE_PRICE_PRO_MONTHLY
      vi.resetModules()
      await expect(import('./price-mapping')).rejects.toThrow(
        /STRIPE_PRICE_PRO_MONTHLY/,
      )
    })

    it('throws when STRIPE_PRICE_PRO_YEARLY is missing', async () => {
      delete process.env.STRIPE_PRICE_PRO_YEARLY
      vi.resetModules()
      await expect(import('./price-mapping')).rejects.toThrow(
        /STRIPE_PRICE_PRO_YEARLY/,
      )
    })

    it('throws when two env vars hold the same price ID (config bug)', async () => {
      process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_dup'
      process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_dup'
      vi.resetModules()
      await expect(import('./price-mapping')).rejects.toThrow(/distinct/)
    })

    it('throws when env is set to empty string (Vercel UI lets it slip)', async () => {
      process.env.STRIPE_PRICE_STANDARD_MONTHLY = ''
      vi.resetModules()
      await expect(import('./price-mapping')).rejects.toThrow(
        /STRIPE_PRICE_STANDARD_MONTHLY/,
      )
    })
  })
})
