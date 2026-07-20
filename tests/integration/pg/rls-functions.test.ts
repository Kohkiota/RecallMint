// RLS-P2 (0025): tenant-context loud 検出関数 + users 特殊経路の SECURITY DEFINER 3 本の
// behavioral 保証。migration 0025 (drizzle/migrations/0025_rls_p2_functions.sql) が
// 定義する 4 関数を app role (recallmint_app) 経由で呼び、runtime と同じ EXECUTE
// grant 経路 (PUBLIC / REVOKE+GRANT recallmint_app) を実際に通す。
//
// 接続の使い分け (既存 harness 規約):
//   - 関数呼出 (検証対象) = getDb() (app role recallmint_app)。
//   - seed / 直接読み書き = getFixtureOwnerDb() / truncateAllUserTables()。
//
// SQLSTATE 'P0RLS' の判定は drizzle-orm postgres-js driver が raw postgres-js の
// PostgresError (`.code` に SQLSTATE) を DrizzleQueryError でラップし元 error を
// `.cause` に載せる (drizzle-orm/errors.js) ため、top-level と `.cause` chain の
// 両方を見る (role-privilege.test.ts の permissionSemanticsIn と同型)。
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'

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
})

function isP0RLS(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code
  if (code === 'P0RLS') return true
  const cause = (err as { cause?: unknown } | undefined)?.cause
  return cause !== undefined && cause !== err ? isP0RLS(cause) : false
}

async function assertRejectsWithP0RLS(op: () => Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await op()
  } catch (e) {
    caught = e
  }
  expect(caught, 'expected the operation to reject').toBeDefined()
  expect(isP0RLS(caught), `expected SQLSTATE P0RLS, got ${String(caught)}`).toBe(true)
}

describe('RLS-P2 tenant-context functions (migration 0025)', () => {
  describe('app_current_user_id', () => {
    it('returns the uuid set via app.user_id within the same transaction', async () => {
      const userId = randomUUID()
      const rows = await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`)
        return tx.execute<{ app_current_user_id: string }>(
          sql`SELECT public.app_current_user_id()`,
        )
      })
      expect(rows[0]?.app_current_user_id).toBe(userId)
    })

    it('rejects with P0RLS when app.user_id is not set', async () => {
      await assertRejectsWithP0RLS(() =>
        getDb().execute(sql`SELECT public.app_current_user_id()`),
      )
    })

    it('rejects with P0RLS when app.user_id is set to an empty string', async () => {
      await assertRejectsWithP0RLS(() =>
        getDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.user_id', '', true)`)
          return tx.execute(sql`SELECT public.app_current_user_id()`)
        }),
      )
    })
  })

  describe('app_bootstrap_user_from_clerk', () => {
    it('returns the 1 matching row for a known clerk_id', async () => {
      const owner = getFixtureOwnerDb()
      const [seeded] = await owner
        .insert(users)
        .values({ clerkId: 'ck_test_1' })
        .returning({ id: users.id })

      const rows = await getDb().execute<{ id: string }>(
        sql`SELECT * FROM public.app_bootstrap_user_from_clerk('ck_test_1')`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(seeded?.id)
    })

    it('returns 0 rows for an unknown clerk_id', async () => {
      const rows = await getDb().execute(
        sql`SELECT * FROM public.app_bootstrap_user_from_clerk('ck_unknown_xyz')`,
      )
      expect(rows).toHaveLength(0)
    })

    it('cannot find a scrubbed user (clerk_id nulled) by its former clerk_id', async () => {
      const owner = getFixtureOwnerDb()
      const [seeded] = await owner
        .insert(users)
        .values({ clerkId: 'ck_scrub_bootstrap' })
        .returning({ id: users.id })
      await owner
        .update(users)
        .set({ deletedAt: new Date(), email: null, clerkId: null })
        .where(eq(users.id, seeded!.id))

      const rows = await getDb().execute(
        sql`SELECT * FROM public.app_bootstrap_user_from_clerk('ck_scrub_bootstrap')`,
      )
      expect(rows).toHaveLength(0)
    })
  })

  describe('app_resolve_user_for_stripe', () => {
    it('resolves via each of the 4 arms (id / clerkId / stripeCustomerId / scheduleId)', async () => {
      const owner = getFixtureOwnerDb()
      const [seeded] = await owner
        .insert(users)
        .values({
          clerkId: 'ck_stripe_arms',
          stripeCustomerId: 'cus_test_arms',
          scheduledDowngradeScheduleId: 'sub_sched_arms',
        })
        .returning({ id: users.id })
      const id = seeded!.id

      const byId = await getDb().execute<{ id: string; deleted_at: string | null }>(
        sql`SELECT * FROM public.app_resolve_user_for_stripe('id', ${id})`,
      )
      expect(byId).toHaveLength(1)
      expect(byId[0]?.id).toBe(id)
      expect(byId[0]?.deleted_at).toBeNull()

      const byClerk = await getDb().execute<{ id: string }>(
        sql`SELECT * FROM public.app_resolve_user_for_stripe('clerkId', 'ck_stripe_arms')`,
      )
      expect(byClerk[0]?.id).toBe(id)

      const byStripeCustomer = await getDb().execute<{ id: string }>(
        sql`SELECT * FROM public.app_resolve_user_for_stripe('stripeCustomerId', 'cus_test_arms')`,
      )
      expect(byStripeCustomer[0]?.id).toBe(id)

      const bySchedule = await getDb().execute<{ id: string }>(
        sql`SELECT * FROM public.app_resolve_user_for_stripe('scheduleId', 'sub_sched_arms')`,
      )
      expect(bySchedule[0]?.id).toBe(id)
    })

    it('rejects with P0RLS for an out-of-allowlist p_by', async () => {
      await assertRejectsWithP0RLS(() =>
        getDb().execute(
          sql`SELECT * FROM public.app_resolve_user_for_stripe('bogus', 'whatever')`,
        ),
      )
    })

    it('still resolves a deleted (deleted_at set) user, with deleted_at populated', async () => {
      const owner = getFixtureOwnerDb()
      const deletedAt = new Date('2026-07-01T00:00:00.000Z')
      const [seeded] = await owner
        .insert(users)
        .values({ clerkId: 'ck_stripe_deleted', deletedAt })
        .returning({ id: users.id })

      const rows = await getDb().execute<{ id: string; deleted_at: string | null }>(
        sql`SELECT * FROM public.app_resolve_user_for_stripe('clerkId', 'ck_stripe_deleted')`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(seeded?.id)
      expect(rows[0]?.deleted_at).not.toBeNull()
    })
  })

  describe('app_scrub_deleted_user', () => {
    it('scrubs the row when the arg matches the tenant context', async () => {
      const owner = getFixtureOwnerDb()
      const [seeded] = await owner
        .insert(users)
        .values({ clerkId: 'ck_scrub_ctx_match' })
        .returning({ id: users.id })
      const userId = seeded!.id

      await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`)
        await tx.execute(sql`SELECT public.app_scrub_deleted_user(${userId}::uuid)`)
      })

      const [after] = await owner
        .select({
          deletedAt: users.deletedAt,
          email: users.email,
          clerkId: users.clerkId,
        })
        .from(users)
        .where(eq(users.id, userId))
      expect(after?.deletedAt).not.toBeNull()
      expect(after?.email).toBeNull()
      expect(after?.clerkId).toBeNull()
    })

    it('rejects with P0RLS when the arg does not match the tenant context', async () => {
      const owner = getFixtureOwnerDb()
      const [seededX] = await owner
        .insert(users)
        .values({ clerkId: 'ck_scrub_ctx_x' })
        .returning({ id: users.id })
      const [seededY] = await owner
        .insert(users)
        .values({ clerkId: 'ck_scrub_ctx_y' })
        .returning({ id: users.id })

      await assertRejectsWithP0RLS(() =>
        getDb().transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.user_id', ${seededX!.id}, true)`,
          )
          await tx.execute(
            sql`SELECT public.app_scrub_deleted_user(${seededY!.id}::uuid)`,
          )
        }),
      )

      // negative control: Y は不変のまま (scrub が誤って走っていないこと)
      const [yAfter] = await owner
        .select({ clerkId: users.clerkId, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, seededY!.id))
      expect(yAfter?.clerkId).toBe('ck_scrub_ctx_y')
      expect(yAfter?.deletedAt).toBeNull()
    })

    it('is a no-op (0 rows) when context and arg match a nonexistent uuid', async () => {
      const z = randomUUID()

      await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${z}, true)`)
        await tx.execute(sql`SELECT public.app_scrub_deleted_user(${z}::uuid)`)
      })

      const owner = getFixtureOwnerDb()
      const rows = await owner.select({ id: users.id }).from(users).where(eq(users.id, z))
      expect(rows).toHaveLength(0)
    })
  })
})
