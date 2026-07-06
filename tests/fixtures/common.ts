/**
 * tests/fixtures/common.ts
 *
 * Shared foundation for contract tests — thin layer only:
 *   - Determinism anchors (FIXED_* constants)
 *   - Clock stub  (vi.setSystemTime wrapper)
 *   - ID stub     (crypto.randomUUID wrapper)
 *   - Base Request builders (makeGetReq / makePostReq)
 *
 * Per-route fake-DB/tx builders are in sibling files (pull.ts,
 * entity-mutations.ts, review-events.ts, webhooks-stripe.ts,
 * webhooks-clerk.ts) so each route's DB shape stays explicit.
 * Drizzle chain mock lives in _drizzle-mock.ts (webhook fixtures only).
 */

import { vi } from 'vitest'

// ─── Determinism anchors ──────────────────────────────────────────────────
// Pin these values in every contract test to guarantee snapshot stability.
// They are visually distinguishable from real data.

/** ISO timestamp used as the pinned "now" in contract tests. */
export const FIXED_TIMESTAMP = '2026-07-06T00:00:00.000Z'

/** Milliseconds since epoch for FIXED_TIMESTAMP. */
export const FIXED_NOW_MS = new Date(FIXED_TIMESTAMP).getTime()

/** Default fake UUID returned by stubUUID(). v4 format, obviously synthetic. */
export const FIXED_UUID = '00000000-0000-4000-a000-000000000001' as const

/** Canonical fake user ID (v4 UUID). Matches entity-mutations / review-events tests. */
export const FIXED_USER_ID = '11111111-1111-4111-a111-111111111111' as const

// ─── Non-determinism sources to stub ─────────────────────────────────────
//
// Source            | Stub mechanism                 | Contract-relevant?
// ─────────────────────────────────────────────────────────────────────────
// Date.now()        | vi.setSystemTime               | ✓ snapshot if in body
// new Date()        | vi.setSystemTime               | ✓
// crypto.randomUUID | vi.spyOn(crypto, 'randomUUID') | ✓ if id surfaces
// lib/sync/new-id   | same (wraps crypto.randomUUID) | ✓
// performance.now() | not stubbed (not in contract)  | ✗ timing log
// Stripe/Svix sig t | route-specific header override | ✗ not in body
// logger/notifyOps  | not stubbed (not in contract)  | ✗ ops payload
// DB sql`now()`     | DB mock returns fixed value    | per-route decision
// ─────────────────────────────────────────────────────────────────────────

// ─── Clock stub ──────────────────────────────────────────────────────────

/**
 * Pin the system clock to `isoTimestamp` (default: FIXED_TIMESTAMP).
 *
 * Call `vi.useFakeTimers()` in beforeEach BEFORE this, or pass
 * `{ useFake: true }` to have this function call it automatically.
 */
export function stubClock(
  isoTimestamp: string = FIXED_TIMESTAMP,
  options: { useFake?: boolean } = {},
): void {
  if (options.useFake) vi.useFakeTimers()
  vi.setSystemTime(new Date(isoTimestamp))
}

/** Restore the real system clock. Pair with stubClock. */
export function restoreClock(): void {
  vi.useRealTimers()
}

// ─── ID stub ─────────────────────────────────────────────────────────────

/**
 * Stub `crypto.randomUUID` to always return `uuid` (default: FIXED_UUID).
 * Since `lib/sync/new-id.newId()` delegates to `crypto.randomUUID`, this
 * covers both call sites.
 *
 * Call vi.restoreAllMocks() in afterEach to undo.
 */
export function stubUUID(
  uuid: string = FIXED_UUID,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
    uuid as `${string}-${string}-${string}-${string}-${string}`,
  )
}

// ─── Request builders ─────────────────────────────────────────────────────

/** Build a minimal GET Request for `url`. */
export function makeGetReq(url: string): Request {
  return new Request(url)
}

/**
 * Build a POST Request with JSON body and optional extra headers.
 * Each route's per-route fixture wraps this with route-specific defaults.
 */
export function makePostReq(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

