import '@/lib/clerk' // env prefix validation (side-effect, Node runtime)
import { cache } from 'react'
import { auth } from '@clerk/nextjs/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users, type User } from '@/lib/db/schema'
import { UnauthenticatedError } from './errors'

/**
 * Returns the current user's DB row, or null if the webhook hasn't synced
 * the user yet (sign-up race) or the user no longer exists in our DB.
 *
 * Design (R2 webhook-only sync, Bug 3 fix): Clerk is source of truth and the
 * `users` table is a synchronized copy maintained by `app/api/webhooks/clerk/`.
 * This function is therefore a pure DB lookup — no `clerkClient.users.getUser()`
 * call — which avoids 404s during Clerk's 60s JWT cache window after deleteUser.
 *
 * Throws `UnauthenticatedError` if there's no Clerk session.
 *
 * Returns the row AS-IS even if `deletedAt` is set — caller (e.g. /app layout)
 * is responsible for zombie-session detection.
 *
 * Phase 1 G-5-1 (request-scoped dedupe): wrapped with React.cache() so /app
 * layout + page in the same RSC render tree share one users SELECT (was 2x
 * per request before). React 19 cache() docs note that calling a memoized
 * function outside of a component will not use the cache — vitest tests
 * therefore execute the function each call, matching pre-wrap behavior.
 *
 * See spec docs/superpowers/specs/2026-04-26-webhook-only-user-sync-design.md §3.1
 */
export const getCurrentUser = cache(
  async (): Promise<User | null> => {
    const { userId } = await auth()
    if (!userId) throw new UnauthenticatedError()

    const db = getDb()
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1)
    return rows[0] ?? null
  },
)
