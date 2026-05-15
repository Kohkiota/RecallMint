import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest'
import { sql } from 'drizzle-orm'

// Use a fixed test date far in the future so we don't collide with real
// production counters if anyone runs this against a live DB.
const TEST_DATE = '2099-12-31'
vi.mock('@/lib/jst', () => ({
  todayInJst: () => TEST_DATE,
}))

// Opt-in: only runs when RUN_INTEGRATION_TESTS=1 is set AND DATABASE_URL is real.
const RUN = process.env.RUN_INTEGRATION_TESTS === '1'

describe.skipIf(!RUN)('reserveAiGenSlot (concurrent integration)', () => {
  let reserveAiGenSlot: typeof import('@/lib/ai-usage').reserveAiGenSlot
  let LimitExceededError: typeof import('@/lib/ai-usage').LimitExceededError
  let getDb: typeof import('@/lib/db').getDb

  // Clerk userId は users.clerk_id 用の seed key、TEST_USER_ID は F-3 で uuid 化した
  // ai_usage_users.user_id 等の FK 列に渡す内部 UUID。INSERT RETURNING で取得する。
  const TEST_USER_CLERK = `test_race_${Date.now()}`
  let TEST_USER_ID: string

  beforeAll(async () => {
    // Dynamically import AFTER vi.mock for jst is in effect.
    ;({ reserveAiGenSlot, LimitExceededError } = await import('@/lib/ai-usage'))
    ;({ getDb } = await import('@/lib/db'))

    // Seed test user (users.clerkId は Clerk session key、id は内部 UUID FK target)。
    const db = getDb()
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO users (clerk_id, email, plan)
      VALUES (${TEST_USER_CLERK}, ${TEST_USER_CLERK + '@test.local'}, 'free')
      ON CONFLICT (clerk_id) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `)
    TEST_USER_ID = inserted.rows[0]!.id
  })

  afterAll(async () => {
    const db = getDb()
    // Clean up in FK-safe order. ai_usage_users.user_id is uuid post-F-3.
    await db.execute(
      sql`DELETE FROM ai_usage_users WHERE user_id = ${TEST_USER_ID}::uuid`,
    )
    await db.execute(sql`DELETE FROM ai_usage WHERE date = ${TEST_DATE}`)
    await db.execute(sql`DELETE FROM users WHERE clerk_id = ${TEST_USER_CLERK}`)
  })

  beforeEach(async () => {
    const db = getDb()
    // Clean counter rows for TEST_DATE before each test.
    await db.execute(
      sql`DELETE FROM ai_usage_users WHERE user_id = ${TEST_USER_ID}::uuid`,
    )
    await db.execute(sql`DELETE FROM ai_usage WHERE date = ${TEST_DATE}`)
  })

  it('Promise.all 5 並行、global cap=3 → 3 件成功、2 件 LimitExceededError', async () => {
    process.env.GEMINI_DAILY_LIMIT = '3'

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserveAiGenSlot(TEST_USER_ID, 'free')),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled.length).toBe(3)
    expect(rejected.length).toBe(2)
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(LimitExceededError)
      expect((r.reason as { code: string }).code).toBe('GLOBAL_LIMIT')
    }

    // Final DB state: global count == 3 (rolled-back attempts don't persist).
    const db = getDb()
    const globalRow = await db.execute<{ count: number }>(sql`
      SELECT count FROM ai_usage WHERE date = ${TEST_DATE}
    `)
    expect(Number(globalRow.rows[0]!.count)).toBe(3)
  })

  // Fix 1.1: USER_LIMIT concurrent path. Free plan aiGenPerDay = 10 (see
  // lib/auth/plan-limits.ts). GLOBAL を十分に高く (999) 設定し、USER cap に
  // 先に当たるシナリオを強制する。global 側も同じ tx 内の UPSERT なので、
  // user-rollback 時に global 側も一緒に rollback されることを裏取り。
  it('Promise.all 12 並行、global cap=999 / user cap=10 → 10 件成功、2 件 LimitExceededError(USER_LIMIT)', { timeout: 30_000 }, async () => {
    process.env.GEMINI_DAILY_LIMIT = '999'

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => reserveAiGenSlot(TEST_USER_ID, 'free')),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled.length).toBe(10)
    expect(rejected.length).toBe(2)
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(LimitExceededError)
      expect((r.reason as { code: string }).code).toBe('USER_LIMIT')
    }

    // Final DB state: user count == 10 (rolled-back attempts don't persist)
    const db = getDb()
    const userRow = await db.execute<{ count: number }>(sql`
      SELECT count FROM ai_usage_users
      WHERE user_id = ${TEST_USER_ID}::uuid AND date = ${TEST_DATE}
    `)
    expect(Number(userRow.rows[0]!.count)).toBe(10)

    // Global counter also 10 — critical evidence that the tx is atomic:
    // if user-side rollback didn't also revert global's UPSERT, global
    // would be 12 here. Having global==10 proves both UPSERTs are
    // inside the same transaction and rollback together.
    const globalRow = await db.execute<{ count: number }>(sql`
      SELECT count FROM ai_usage WHERE date = ${TEST_DATE}
    `)
    expect(Number(globalRow.rows[0]!.count)).toBe(10)
  })
})
