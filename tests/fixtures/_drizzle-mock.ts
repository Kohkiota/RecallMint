/**
 * tests/fixtures/_drizzle-mock.ts
 *
 * Drizzle chain mock for webhook contract tests.
 * Moved from common.ts (common.ts is thin: clock / id / request builders only).
 *
 * Methods: union of stripe + clerk webhook source test chain shapes.
 *   stripe source (route.test.ts): values, onConflictDoNothing, returning, set, where
 *   clerk  source (route.test.ts): + from, limit  (clerk route uses .from(users).limit(1))
 *   orderBy: removed (not in any source test — YAGNI)
 */

import { vi } from 'vitest'

/**
 * Create a Drizzle-like chainable mock.
 * Any `await chain(...)` resolves to `resolveTo`.
 *
 * @example
 * mockDbInsert.mockReturnValueOnce(chain([{ id: 'evt_1' }]))
 */
export function chain(resolveTo: unknown = undefined): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  const self = () => c
  c.values = vi.fn(self)
  c.onConflictDoNothing = vi.fn(self)
  c.returning = vi.fn(self)
  c.set = vi.fn(self)
  c.where = vi.fn(self)
  // from + limit: present in clerk webhook route handler (.from(users).limit(1))
  c.from = vi.fn(self)
  c.limit = vi.fn(self)
  c.then = (onFulfilled: (v: unknown) => void) =>
    Promise.resolve(resolveTo).then(onFulfilled)
  return c
}
