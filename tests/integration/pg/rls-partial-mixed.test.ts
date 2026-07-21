// RLS-P3 Wave 2 — partial-RLS (RLS-on 表 × RLS-off 表が 1 tx に同居) の intentional 証明。
//
// 主張範囲(限定): 「**global-off 表 × tenant-on 表** が 1 tx に同居しても、on 表は隔離が
// 効き、off 表は従来どおり書け、かつ on 側違反時は tx 全体が原子的に rollback する」。
// これは Phase 3 の wave 分割成立(= partial-RLS が安全)の behavioral 担保。
// ※本 file は「移行期に tenant 表が一時的に off である安全性」や「off 側の tenant 隔離」は
//   証明しない(off = global ゆえ隔離対象外)。Step 0 追補2 の想定 (study_sessions off × on) は
//   Wave 2 が study_sessions を on 化するため無効化 → 恒久 off の global 表へ置換した。
//
// 実経路: incrementAiUsage (lib/ai-usage-counter.ts) は 1 tenant tx (setTenantContext 済) で
//   ai_usage(**off**・global・PK=date・user_id 無) + ai_usage_users(**on**・PK=user_id+date) を
//   UPSERT する = Wave 2 後も残る stable な mixed tx。off 書込は実業務経路 (incrementAiUsage) で
//   行い、raw 任意 insert で「off 自由」を過剰仕様化しない。
//
// cleanup: ai_usage は user_id を持たず truncateAllUserTables の対象外ゆえ、owner で対象 date を
//   beforeEach/afterEach 掃除 + now 注入で決定化する。test:iso は単一 fork 直列で worker 競合なし。
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { aiUsage, aiUsageUsers } from '@/lib/db/schema'
import { incrementAiUsage } from '@/lib/ai-usage-counter'

import { asTenant } from './setup/as-tenant'
import { assertRejectsWithRlsViolation } from './setup/rls-assert'
import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

// fixture が ai_usage_users を seed する日付 (fixture.ts の day) と揃える。
const TEST_DATE = '2026-07-18'
// todayInJst(TEST_NOW) = '2026-07-18' (UTC 00:00 → JST 09:00 同日)。incrementAiUsage の
// 日付を決定化する。
const TEST_NOW = new Date('2026-07-18T00:00:00.000Z')

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

describe('RLS Wave 2 partial-RLS (global-off ai_usage × tenant-on ai_usage_users, one tx)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    // ai_usage は truncate 対象外ゆえ owner で対象 date を掃除 (test 間 leak 防止)。
    await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, TEST_DATE))
  })

  afterEach(async () => {
    await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, TEST_DATE))
  })

  it('incrementAiUsage: 混在 tx が RLS-on 下で成立 (off=ai_usage 加算 + on=ai_usage_users 加算)', async () => {
    const owner = getFixtureOwnerDb()
    // 実業務経路。A の context で ai_usage(off) と ai_usage_users(on) を同 tx UPSERT。
    await incrementAiUsage(fixture.a.userId, 1, TEST_NOW)

    // off: global ai_usage[date] が新規 insert (count=1)。
    const off = await owner
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(eq(aiUsage.date, TEST_DATE))
    expect(off[0]?.count).toBe(1)

    // on: A の ai_usage_users[A,date] が seed(1) + 1 = 2。
    const onA = await owner
      .select({ count: aiUsageUsers.count })
      .from(aiUsageUsers)
      .where(eq(aiUsageUsers.userId, fixture.a.userId))
    expect(onA[0]?.count).toBe(2)

    // 隔離: B の ai_usage_users は不変 (seed の 1)。
    const onB = await owner
      .select({ count: aiUsageUsers.count })
      .from(aiUsageUsers)
      .where(eq(aiUsageUsers.userId, fixture.b.userId))
    expect(onB[0]?.count).toBe(1)
  })

  it('mixed tx 内: on 表 (ai_usage_users) は A に隔離 / off 表 (ai_usage global) は非スコープで可視', async () => {
    const owner = getFixtureOwnerDb()
    // off の global 行を用意 (A context で可視になることを見る)。
    await owner.insert(aiUsage).values({ date: TEST_DATE, count: 3 })

    const probe = await asTenant(fixture.a.userId, async (tx) => {
      // on: user_id 述語なし read → A のみ (B decoy 不可視)。
      const onRows = await tx.select({ userId: aiUsageUsers.userId }).from(aiUsageUsers)
      // off: global ai_usage は tenant scope 対象外 → A context でも可視。
      const offRows = await tx.select({ date: aiUsage.date }).from(aiUsage)
      // on: B を狙う write は 0 行 (USING が不可視化)。
      const bWrite = await tx
        .update(aiUsageUsers)
        .set({ count: 999 })
        .where(eq(aiUsageUsers.userId, fixture.b.userId))
        .returning({ userId: aiUsageUsers.userId })
      return { onRows, offRows, bWrite }
    })

    expect(probe.onRows.length).toBeGreaterThan(0)
    expect(probe.onRows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    expect(probe.onRows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    expect(probe.offRows.map((r) => r.date)).toContain(TEST_DATE)
    expect(probe.bWrite).toHaveLength(0)

    // owner: B の ai_usage_users は不変。
    const bAfter = await owner
      .select({ count: aiUsageUsers.count })
      .from(aiUsageUsers)
      .where(eq(aiUsageUsers.userId, fixture.b.userId))
    expect(bAfter[0]?.count).toBe(1)
  })

  it('atomicity: mixed tx で on 違反 (user_id=B) → off (ai_usage) 書込も rollback (partial commit を作らない)', async () => {
    const owner = getFixtureOwnerDb()
    // mixed tx: ai_usage(off) を UPSERT した後に ai_usage_users を user_id=B で insert →
    // WITH CHECK 42501 で throw → tx 全体 rollback。off の ai_usage 書込も巻き戻る。
    await assertRejectsWithRlsViolation(() =>
      asTenant(fixture.a.userId, async (tx) => {
        await tx
          .insert(aiUsage)
          .values({ date: TEST_DATE, count: 1 })
          .onConflictDoUpdate({
            target: aiUsage.date,
            set: { count: sql`${aiUsage.count} + 1` },
          })
        await tx
          .insert(aiUsageUsers)
          .values({ userId: fixture.b.userId, date: TEST_DATE, count: 1 }) // cross-tenant → 42501
      }),
    )

    // off (ai_usage[date]) は on 違反の rollback で書かれていない = 原子的失敗。
    const off = await owner
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(eq(aiUsage.date, TEST_DATE))
    expect(off).toHaveLength(0)
  })
})
