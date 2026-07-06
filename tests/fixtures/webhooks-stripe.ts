/**
 * tests/fixtures/webhooks-stripe.ts
 *
 * Per-route fixtures for POST /api/webhooks/stripe contract tests.
 *
 * Ported from app/api/webhooks/stripe/route.test.ts:
 *   - makeReq (POST request with stripe-signature header)
 *   - sub() — Stripe subscription object factory
 *   - stubIdempotencyInsertOnce() helper
 *   - PRICE constant keys (reads from process.env set by vitest.setup.ts)
 *
 * DB interactions use the common `chain` mock from ./common.ts.
 * The test file sets up mockDbInsert / mockDbUpdate with vi.hoisted and
 * passes them to the mock factories; this fixture provides the helpers
 * that build per-call return values.
 */

import { vi } from 'vitest'
import { chain } from './_drizzle-mock'

// ─── Price env constants ──────────────────────────────────────────────────
// vitest.setup.ts sets STRIPE_PRICE_* with fake_ prefix values.

export const PRICE = {
  get STANDARD_MONTHLY() {
    return process.env.STRIPE_PRICE_STANDARD_MONTHLY!
  },
  get STANDARD_YEARLY() {
    return process.env.STRIPE_PRICE_STANDARD_YEARLY!
  },
  get PRO_MONTHLY() {
    return process.env.STRIPE_PRICE_PRO_MONTHLY!
  },
  get PRO_YEARLY() {
    return process.env.STRIPE_PRICE_PRO_YEARLY!
  },
}

// ─── Request builder ──────────────────────────────────────────────────────

/**
 * Build a POST request for /api/webhooks/stripe.
 * Uses a fake stripe-signature header (constructEvent is mocked).
 */
export function makeReq(body: unknown): Request {
  return new Request('https://test/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'stripe-signature': 't=0,v1=fake',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// ─── Idempotency helper ───────────────────────────────────────────────────

/**
 * Stub the idempotency INSERT to return a new-event row.
 * Pass the mockDbInsert vi.fn() created in the test file.
 *
 * @example
 * const { mockDbInsert } = vi.hoisted(() => ({ mockDbInsert: vi.fn() }))
 * // in test:
 * stubIdempotencyInsertOnce(mockDbInsert)
 */
export function stubIdempotencyInsertOnce(
  mockDbInsert: ReturnType<typeof vi.fn>,
): void {
  mockDbInsert.mockReturnValueOnce(chain([{ id: 'evt_unit_test' }]))
}

// ─── Subscription factory ─────────────────────────────────────────────────

/**
 * Build a Stripe-like subscription object for use in constructEvent stubs.
 * Ported from app/api/webhooks/stripe/route.test.ts `sub()`.
 */
export function sub({
  priceId,
  status = 'active',
  cycleEnd = 1779999999,
  cancelAt = null,
  customerId = 'cus_unit_test',
  schedule = null,
}: {
  priceId: string
  status?: string
  cycleEnd?: number
  cancelAt?: number | null
  customerId?: string
  schedule?: string | { id: string } | null
}) {
  return {
    id: 'sub_unit',
    customer: customerId,
    status,
    cancel_at: cancelAt,
    schedule,
    items: {
      data: [{ price: { id: priceId }, current_period_end: cycleEnd }],
    },
  }
}

// ─── Re-export chain for convenience ─────────────────────────────────────

export { chain }
