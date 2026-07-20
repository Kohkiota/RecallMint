// RLS-P2 Task 10 (A): getCurrentUser の claim-first null 契約 4 分岐を実 PG (RLS on) で pin。
//
// auth-seam: `@clerk/nextjs/server` の auth() だけを mock し (userId + sessionClaims.dbUserId
// を per-test に注入)、getDb() は real (RLS on = 5 表 policy 有効) を掴む。この
// 「mocked auth + real getDb」の共存が本 file の要 — 既存 iso suite は auth() を通らない
// 経路のみ叩いていた。unit 側 (lib/auth/ensure-user.test.ts) は getDb を mock するため
// RLS policy を通過せず、ghost→null が「app-WHERE isNull」なのか「RLS policy」なのかを
// 切り分けられない。ここでは real policy を実際に通す。
//
// module-cache 注意 (brief 指定): getCurrentUser / getDb / closeDb / fixture helper は
// すべて **静的 import**。iso config は setupFiles で毎 test 前 vi.resetModules() を回すが、
// 静的 import 済みの binding は再評価されず file-load 時の同一 @/lib/db singleton (同一
// connection pool) を共有する。getCurrentUser を各 test で dynamic import すると
// resetModules 後に別 pool を掴み afterAll closeDb() が閉じ損ねて connection leak になる
// ため dynamic import は使わない。getCurrentUser は React cache() 包みだが、component 外
// 呼出は memoize しない (React 19 仕様) ので静的 import + test 間再呼出でも汚染しない。
//
// ghost→null の red 検証は「claim 分岐の反転」で行う (decoy live user Y を使う下記
// distinguisher)。app-WHERE の isNull(deletedAt) 除去は RLS-on では users_select policy
// (deleted_at IS NULL) が冗長に同じ除外を課すため behavior が変わらず red にならない
// (= app-isNull は RLS 下では二重防御の片翼・load-bearing は RLS 側)。cross-ref:
// rls-functions.test.ts の同注記 / rls-ghost.test.ts (RLS 単独防御の pin)。
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// auth() のみ mock。getDb は real (RLS on)。
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }))

import { auth } from '@clerk/nextjs/server'

import { closeDb, getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'

import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

beforeEach(async () => {
  await truncateAllUserTables()
  vi.mocked(auth).mockReset()
})

describe('getCurrentUser null contract on real PG (RLS on)', () => {
  it('claim present + live row → returns the User row', async () => {
    const owner = getFixtureOwnerDb()
    const clerkId = 'clerk_live_claim'
    const [u] = await owner
      .insert(users)
      .values({ clerkId, email: 'live@example.test' })
      .returning({ id: users.id })

    // claim-first: dbUserId を tenant key に直接使う (bootstrap 迂回)。
    vi.mocked(auth).mockResolvedValue({
      userId: clerkId,
      sessionClaims: { dbUserId: u!.id },
    } as never)

    const result = await getCurrentUser()
    expect(result).not.toBeNull()
    expect(result?.id).toBe(u!.id)
    expect(result?.clerkId).toBe(clerkId)
    expect(result?.deletedAt).toBeNull()
  })

  it('claim present + ghost (scrubbed) row → null; bootstrap definer NOT used (decoy live user is never returned)', async () => {
    const owner = getFixtureOwnerDb()
    const authUserId = 'clerk_ghost_auth'

    // ghost X: scrub 済み (deleted_at set + clerk_id/email NULL)。claim はここを指す。
    const [ghost] = await owner
      .insert(users)
      .values({ deletedAt: new Date('2026-07-01T00:00:00.000Z'), email: null, clerkId: null })
      .returning({ id: users.id })

    // decoy live Y: clerk_id === authUserId。もし getCurrentUser が claim を無視して
    // bootstrap(authUserId) へ落ちれば Y (live) を解決して返してしまう。claim-first
    // 契約はこの fallback を禁じる — ゆえに「null が返る」ことが「bootstrap 未使用」を含意する。
    const [decoy] = await owner
      .insert(users)
      .values({ clerkId: authUserId, email: 'decoy@example.test' })
      .returning({ id: users.id })

    // 非 vacuous 性の positive control: bootstrap(authUserId) は実際に decoy を解決する。
    // ゆえに「getCurrentUser が null を返した」= claim 分岐から bootstrap へ落ちていない。
    const boot = await getDb().execute<{ id: string }>(
      sql`SELECT id FROM public.app_bootstrap_user_from_clerk(${authUserId})`,
    )
    expect(boot[0]?.id).toBe(decoy!.id)

    vi.mocked(auth).mockResolvedValue({
      userId: authUserId,
      sessionClaims: { dbUserId: ghost!.id },
    } as never)

    const result = await getCurrentUser()
    expect(result).toBeNull()
  })

  it('no claim + unsynced clerk_id → bootstrap 0 rows → null', async () => {
    // users 未 seed = bootstrap は clerk_id で引けず 0 行 → dbUserId 未解決 → null 契約。
    vi.mocked(auth).mockResolvedValue({
      userId: 'clerk_never_synced_xyz',
      sessionClaims: {},
    } as never)

    const result = await getCurrentUser()
    expect(result).toBeNull()
  })

  it('no claim + synced clerk_id → bootstrap resolves → returns the User row', async () => {
    // claim 欠落 (旧 session / JWT 未浸透) 時の bootstrap path が生存 user を解決すること。
    const owner = getFixtureOwnerDb()
    const clerkId = 'clerk_synced_noclaim'
    const [u] = await owner
      .insert(users)
      .values({ clerkId, email: 'synced@example.test' })
      .returning({ id: users.id })

    vi.mocked(auth).mockResolvedValue({
      userId: clerkId,
      sessionClaims: {},
    } as never)

    const result = await getCurrentUser()
    expect(result?.id).toBe(u!.id)
    expect(result?.clerkId).toBe(clerkId)
    expect(result?.deletedAt).toBeNull()
  })

  it('no session (userId null) → throws UnauthenticatedError', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never)
    await expect(getCurrentUser()).rejects.toBeInstanceOf(UnauthenticatedError)
  })
})
