// RLS-P3 hardening (Task 5): RLS 非対象 5 表 (ai_usage / stripe_events / clerk_events /
// contact_messages / integration_failures) の app-role grant 縮小を実 PG で pin する。
// これらは tenant RLS を張らないため **command-level GRANT が唯一の防壁** — grant を
// 実経路が使うコマンドだけに絞り、他コマンドが app-role で 42501 (insufficient_privilege)
// になることを証明する。
//
// grant 縮小 SQL の正本 = db/roles/recallmint_app-grants-phase3.sql。global-setup が
// base grants (blanket ON ALL TABLES) の直後に適用するため、本 test は縮小後の grant で走る。
//
// 接続: code-under-test と同じ getDb() (app role = recallmint_app)。非 RLS 表ゆえ
// setTenantContext は不要 (tenant context を張らない)。seed / 観測 / cleanup は owner
// (getFixtureOwnerDb・grant を bypass) で行う (app-role は SELECT/TRUNCATE を持たない前提)。
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import {
  aiUsage,
  clerkEvents,
  contactMessages,
  integrationFailures,
  stripeEvents,
  users,
} from '@/lib/db/schema'

import { closeFixtureOwnerDb, getFixtureOwnerDb } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// negative op が「権限拒否」で reject したことを判定する。SQLSTATE 42501
// (insufficient_privilege) を優先し、環境差 (message 文言のゆらぎ) に message 正規表現も
// OR で許容する。op が reject しない場合はこの helper 自体が throw して test を落とす
// (vacuous pass を防ぐ)。drizzle-orm postgres-js driver は PostgresError を
// DrizzleQueryError でラップし元 error を `.cause` に載せるため .cause chain を walk する。
// (role-privilege.test.ts の同名 helper を mirror。export されていないため複製する。)
function permissionSemanticsIn(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === '42501') return true
  if (/permission denied|must be owner|insufficient/i.test(message)) return true
  const cause = (err as { cause?: unknown } | undefined)?.cause
  return cause !== undefined && cause !== err ? permissionSemanticsIn(cause) : false
}

async function assertRejectsWithPermissionDenied(
  op: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown
  try {
    await op()
  } catch (e) {
    caught = e
  }
  expect(caught, 'expected the operation to reject').toBeDefined()
  expect(
    permissionSemanticsIn(caught),
    `expected permission-denied semantics, got ${String(caught)}`,
  ).toBe(true)
}

// 縮小後に app-role が失えたコマンド (= 42501 になるべき) の完全 matrix。
// contact_messages は SELECT を保持 (退会 DELETE の WHERE user_id が SELECT を要するため
// — grants-phase3.sql の根拠コメント参照) ため revoke は UPDATE のみ。
const REVOKED_MATRIX: ReadonlyArray<{
  table: string
  cmd: string
  run: () => Promise<unknown>
}> = [
  {
    table: 'contact_messages',
    cmd: 'UPDATE',
    run: () => getDb().execute(sql`UPDATE contact_messages SET subject = 'x'`),
  },
  {
    table: 'integration_failures',
    cmd: 'SELECT',
    run: () => getDb().execute(sql`SELECT id FROM integration_failures LIMIT 1`),
  },
  {
    table: 'integration_failures',
    cmd: 'UPDATE',
    run: () =>
      getDb().execute(sql`UPDATE integration_failures SET workflow = 'x'`),
  },
  {
    table: 'integration_failures',
    cmd: 'DELETE',
    run: () => getDb().execute(sql`DELETE FROM integration_failures`),
  },
  {
    table: 'stripe_events',
    cmd: 'UPDATE',
    run: () => getDb().execute(sql`UPDATE stripe_events SET type = 'x'`),
  },
  {
    table: 'stripe_events',
    cmd: 'DELETE',
    run: () => getDb().execute(sql`DELETE FROM stripe_events`),
  },
  {
    table: 'clerk_events',
    cmd: 'UPDATE',
    run: () => getDb().execute(sql`UPDATE clerk_events SET type = 'x'`),
  },
  {
    table: 'clerk_events',
    cmd: 'DELETE',
    run: () => getDb().execute(sql`DELETE FROM clerk_events`),
  },
  {
    table: 'ai_usage',
    cmd: 'DELETE',
    run: () => getDb().execute(sql`DELETE FROM ai_usage`),
  },
]

describe('grant narrowing (non-RLS 5 tables: GRANT is the only defense)', () => {
  // 各 test を独立させるため owner で 5 表 (+ users) を全掃してから走る。users CASCADE は
  // 他 user_id 表も掃くが本 file は該当 5 表しか触らないため無害。app-role は TRUNCATE を
  // 持たないため owner 接続で実行する。
  beforeEach(async () => {
    await getFixtureOwnerDb().execute(
      sql.raw(
        'TRUNCATE TABLE users, contact_messages, integration_failures, stripe_events, clerk_events, ai_usage RESTART IDENTITY CASCADE',
      ),
    )
  })

  // --- negative: 縮小で失ったコマンドは全て 42501 (5 表 × 全 revoke コマンドの完全 matrix) ---
  describe('revoked commands are rejected for the app-role (42501 matrix)', () => {
    for (const { table, cmd, run } of REVOKED_MATRIX) {
      it(`${table}: ${cmd} is permission-denied`, async () => {
        await assertRejectsWithPermissionDenied(run)
      })
    }
  })

  // --- positive control: 残したコマンドは実コードと同じ query 形で従来どおり動く ---
  describe('kept commands still work with the real query shapes', () => {
    // stripe_events: INSERT ... ON CONFLICT DO NOTHING RETURNING event_id。
    // RETURNING は返す列 (event_id) の読取に SELECT 権限を要する — この positive control が
    // 「SELECT grant が十分」+「INSERT が default (無 sequence) で通る」を同時に証明する。
    it('stripe_events: INSERT ON CONFLICT DO NOTHING RETURNING works', async () => {
      const eventId = `evt_${randomUUID()}`
      const rows = await getDb()
        .insert(stripeEvents)
        .values({ eventId, type: 'checkout.session.completed' })
        .onConflictDoNothing({ target: stripeEvents.eventId })
        .returning({ id: stripeEvents.eventId })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(eventId)
    })

    it('clerk_events: INSERT ON CONFLICT DO NOTHING RETURNING works', async () => {
      const eventId = `evt_${randomUUID()}`
      const rows = await getDb()
        .insert(clerkEvents)
        .values({ eventId, type: 'user.created' })
        .onConflictDoNothing({ target: clerkEvents.eventId })
        .returning({ id: clerkEvents.eventId })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(eventId)
    })

    // ai_usage: INSERT ... ON CONFLICT DO UPDATE SET count = count + N (UPSERT)。
    // DO UPDATE 式が既存 count を読むため SELECT (kept) が要り、書込に UPDATE (kept) が要る。
    // 1 回目 = 新規 INSERT (count=3)、2 回目 = 衝突 → DO UPDATE で +5 = 8 になることを owner で観測。
    it('ai_usage: INSERT ON CONFLICT DO UPDATE (UPSERT) works', async () => {
      const date = '2026-07-22'
      const upsert = (count: number) =>
        getDb()
          .insert(aiUsage)
          .values({ date, count })
          .onConflictDoUpdate({
            target: aiUsage.date,
            set: { count: sql`${aiUsage.count} + ${count}` },
          })
      await upsert(3) // insert path
      await upsert(5) // conflict → DO UPDATE path (reads count, writes count)

      const observed = await getFixtureOwnerDb().execute<{ count: number }>(
        sql`SELECT count FROM ai_usage WHERE date = ${date}`,
      )
      expect(observed[0]?.count).toBe(8)
    })

    // contact_messages: INSERT + DELETE ... WHERE user_id= (退会 lifecycle の実 query 形)。
    // この positive control が pin するのは「SELECT 保持下で退会 DELETE が成功する」= 十分性。
    // SELECT を残す必然性 (剥奪すると DELETE の WHERE user_id 読取が 42501) は PG の
    // 「WHERE 参照列に SELECT 要求」規則 + 手動 PG17 実験由来であり、本 test は単一 grant 状態
    // ゆえ counterfactual (SELECT 剥奪 → 42501) 自体は pin しない。
    it('contact_messages: INSERT + DELETE WHERE user_id= works', async () => {
      const userId = randomUUID()
      // FK 先 users を owner で用意 (app-role は users を触らない)。
      await getFixtureOwnerDb()
        .insert(users)
        .values({ id: userId, clerkId: `clerk_grant_${userId}` })

      await getDb()
        .insert(contactMessages)
        .values({ userId, email: 'x@example.test', subject: 'S', body: 'B' })

      const afterInsert = await getFixtureOwnerDb().execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM contact_messages WHERE user_id = ${userId}`,
      )
      expect(afterInsert[0]?.n).toBe(1)

      await getDb()
        .delete(contactMessages)
        .where(eq(contactMessages.userId, userId))

      const afterDelete = await getFixtureOwnerDb().execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM contact_messages WHERE user_id = ${userId}`,
      )
      expect(afterDelete[0]?.n).toBe(0)
    })

    // integration_failures: audit INSERT のみ (recordIntegrationFailure の実 query 形)。
    it('integration_failures: audit INSERT works', async () => {
      await getDb().insert(integrationFailures).values({
        service: 'stripe',
        operation: 'grant_probe',
        failureCode: 'probe',
        context: {},
      })

      const observed = await getFixtureOwnerDb().execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM integration_failures WHERE failure_code = 'probe'`,
      )
      expect(observed[0]?.n).toBe(1)
    })
  })
})
