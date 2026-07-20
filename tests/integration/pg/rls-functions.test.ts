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

import { and, eq, isNull, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
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

// getCurrentUser の claim-present 読み (lib/auth/ensure-user.ts) の query semantics を
// 実 PG で pin する。scrub(webhook)は clerk_id/email を NULL 化しつつ users 行と id を
// 残し deleted_at を set するため、id で読むと 60s JWT window に ghost 行が返り得る。
// 修正 = WHERE に isNull(deletedAt) を加え ghost を 0 行 → null にすること。ここでは
// getCurrentUser 本体は auth()(Clerk)依存で iso から直接叩けないため、本体と同一の
// withTenantTx(getDb(), id, ...) 読みを raw に再現して predicate の load-bearing 性を pin する。
describe('getCurrentUser claim-present read excludes soft-deleted (ghost) users', () => {
  it('returns 0 rows for a soft-deleted user with the isNull(deletedAt) predicate, and 1 row without it (predicate is load-bearing)', async () => {
    const owner = getFixtureOwnerDb()
    // scrub 済み ghost を owner 接続で seed (deleted_at set + PII NULL、webhook 相当)。
    const [seeded] = await owner
      .insert(users)
      .values({ deletedAt: new Date(), email: null, clerkId: null })
      .returning({ id: users.id })
    const ghostId = seeded!.id

    // (1) getCurrentUser の claim-present 読みの正確な複製 (isNull 付き) → 0 行 → null 契約。
    const withFilter = await withTenantTx(getDb(), ghostId, (tx) =>
      tx
        .select()
        .from(users)
        .where(and(eq(users.id, ghostId), isNull(users.deletedAt)))
        .limit(1),
    )
    expect(withFilter).toHaveLength(0)

    // (2) control: isNull を外すと同じ id で ghost 行が 1 行返る = predicate が
    // load-bearing。この 1 行は非 null かつ deletedAt set ゆえ、呼出側の `!user`
    // ガードを素通りし ghost 書込を許す (= 本 fix が塞ぐ regression の実証)。
    const withoutFilter = await withTenantTx(getDb(), ghostId, (tx) =>
      tx.select().from(users).where(eq(users.id, ghostId)).limit(1),
    )
    expect(withoutFilter).toHaveLength(1)
    expect(withoutFilter[0]?.id).toBe(ghostId)
    expect(withoutFilter[0]?.deletedAt).not.toBeNull()
  })

  it('still returns a live (deletedAt IS NULL) user under the same isNull-filtered read', async () => {
    // positive control: filter が生存 user を誤って弾かないこと (両向き pin)。
    const owner = getFixtureOwnerDb()
    const [seeded] = await owner
      .insert(users)
      .values({ clerkId: 'ck_live_claim_present' })
      .returning({ id: users.id })
    const liveId = seeded!.id

    const rows = await withTenantTx(getDb(), liveId, (tx) =>
      tx
        .select()
        .from(users)
        .where(and(eq(users.id, liveId), isNull(users.deletedAt)))
        .limit(1),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(liveId)
  })
})
