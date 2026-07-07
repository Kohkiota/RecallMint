import '@/lib/clerk/env-check' // env prefix validation (side-effect, Node runtime)
import { cache } from 'react'
import { auth } from '@clerk/nextjs/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users, type User } from '@/lib/db/schema'
import type { Plan } from './plan-limits'
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
 * C2 load-bearing 不変条件: /app/layout.tsx が getCurrentUser() を呼んで users
 * 行を引いた後、 同 RSC render tree の page.tsx (C2 で switched 4 page) で
 * getAuthContext() の fallback path に落ちて getCurrentUser() を再度呼んでも、
 * cache() dedupe で SELECT は 1 回に固定される。 = JWT 未浸透時 (旧 session /
 * backfill 未済 user) の fallback コストは実質ゼロ。 layout で auth 読みを止
 * める refactor をする場合は、 本不変条件が崩れ page.tsx fallback が独立
 * SELECT に化けるので要再考。
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

/**
 * JWT sessionClaims から user identity / plan を読む軽量 helper。 DB SELECT 不要。
 *
 * 返却値:
 * - `clerkId`: Clerk の userId (= JWT `sub`)
 * - `dbUserId`: Clerk publicMetadata.dbUserId 由来 (= users.id の UUID)。 JWT
 *   template 未浸透 / 旧セッション持ち越し時は undefined → 呼出側で
 *   `getCurrentUser()` への fallback を発火する設計
 * - `plan`: Clerk publicMetadata.plan 由来。 同じく未浸透時は undefined
 *
 * 設計:
 * - JWT template 設定 docs: `docs/superpowers/sessions/2026-05-26-jwt-template-setup.md`
 * - sessionClaims 型: `types/clerk.d.ts` の `CustomJwtSessionClaims`
 * - 既存 `getCurrentUser()` は touch しない (API route / Server Action / layout は
 *   引き続き user 行全体を引く)
 */
export async function getAuthContext(): Promise<{
  clerkId: string
  dbUserId: string | undefined
  plan: Plan | undefined
}> {
  const { userId, sessionClaims } = await auth()
  if (!userId) throw new UnauthenticatedError()
  // sessionClaims は Clerk default token + JWT template 設定で publicMetadata 由来
  // claim が乗る前提。 未浸透時は dbUserId / plan ともに undefined となり、
  // 呼出側で getCurrentUser() fallback path が走る。
  const dbUserId = sessionClaims?.dbUserId
  const plan = sessionClaims?.plan
  return { clerkId: userId, dbUserId, plan }
}
