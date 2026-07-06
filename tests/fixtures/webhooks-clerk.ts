/**
 * tests/fixtures/webhooks-clerk.ts
 *
 * Per-route fixtures for POST /api/webhooks/clerk contract tests.
 *
 * Ported from app/api/webhooks/clerk/route.test.ts:
 *   - makeReq (POST request with Svix headers)
 *   - asyncIterFrom() — async generator factory for Stripe subscription lists
 *
 * DB interactions use the common `chain` mock from ./common.ts.
 */

import { chain } from './_drizzle-mock'

// ─── Request builder ──────────────────────────────────────────────────────

/**
 * Build a POST request for /api/webhooks/clerk.
 * Uses fake Svix headers (Webhook.verify is mocked).
 */
export function makeReq(body: unknown): Request {
  return new Request('https://test/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_test_1',
      'svix-timestamp': '0',
      'svix-signature': 'v1,sig',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// ─── Async iterator factory ───────────────────────────────────────────────

/**
 * Build an async generator that yields each item of `items`.
 * Used to mock Stripe subscriptions.list() in user.deleted handler tests.
 *
 * @example
 * mockStripeListIterator.mockReturnValue(asyncIterFrom([{ id: 'sub_a', status: 'active' }]))
 */
export async function* asyncIterFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

// ─── Re-export chain for convenience ─────────────────────────────────────

export { chain }
