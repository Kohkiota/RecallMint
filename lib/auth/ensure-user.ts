import '@/lib/clerk/env-check' // env prefix validation (side-effect, Node runtime)
import { cache } from 'react'
import { auth } from '@clerk/nextjs/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getNonTenantDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
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
 * Soft-deleted / scrubbed 行 (deletedAt set) は返さない: claim-present 読みは
 * WHERE に `deleted_at IS NULL` を含め、claim-absent (bootstrap) は scrub で
 * clerk_id=NULL のため構造的に 0 行。よって退会済みアカウントは null 契約で返り、
 * write 呼出側の `!user` ガードが 60s JWT window の ghost 書込を弾く。
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
    const { userId, sessionClaims } = await auth()
    if (!userId) throw new UnauthenticatedError()

    // RLS-P3 (Task 1): pre-tenant bootstrap resolve — app_bootstrap_user_from_clerk
    // (SECURITY DEFINER) は内部 id を context 確立前に解決するため非 tenant handle を
    // 使う (id 判明後は withTenantTx(db, resolvedId, ...) で tenant context を張る)。
    const db = getNonTenantDb()

    // 内部 UUID を解決する (claim-first・RLS bootstrap 循環の回避)。
    // - claim あり: JWT の dbUserId をそのまま使う (users SELECT 不要)。
    // - claim なし (sign-up race / 旧 session): SECURITY DEFINER 関数で clerk_id
    //   から内部 id を引く (RLS 迂回)。id 列だけ射影して snake_case 全列マッピングを
    //   避ける。scrub 済み行は clerk_id=NULL ゆえ構造的に 0 行。
    let dbUserId = sessionClaims?.dbUserId
    if (!dbUserId) {
      const idRows = await db.execute<{ id: string }>(
        sql`SELECT id FROM public.app_bootstrap_user_from_clerk(${userId})`,
      )
      dbUserId = idRows[0]?.id
    }
    if (!dbUserId) return null // 未同期 → 既存 null 契約 (SyncingPage 等)

    // 内部 id が判明したら tenant context を張って users を読む (drizzle マッピングで
    // 正しい camelCase User 形)。deleted_at IS NULL 除外は二重に効かせる: app 層
    // (この WHERE) と、RLS-on 後の users SELECT policy (id=ctx AND deleted_at IS NULL)
    // の両方。ゆえに ghost (削除済み・scrub 済み・60s JWT window) は RLS-on 前でも
    // app-WHERE で 0 行 → null になり、write 呼出側の `!user` ガードが ghost 書込を弾く。
    // claim あり分岐から bootstrap へ fallback しない (spec §2.4)。
    const resolvedId = dbUserId
    const rows = await withTenantTx(db, resolvedId, (tx) =>
      tx
        .select()
        .from(users)
        .where(and(eq(users.id, resolvedId), isNull(users.deletedAt)))
        .limit(1),
    )
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
 * - getAuthContext 導入時 (C2) は getCurrentUser を変更しなかった (API route /
 *   Server Action / layout は引き続き user 行全体を引く)
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
