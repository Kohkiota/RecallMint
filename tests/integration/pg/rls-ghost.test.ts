// RLS-P2 Task 9 — item (4): ghost JWT (spec §3.1-5)。
//
// scrub 済み user = deleted_at set かつ child data 削除済 (GDPR)。60s JWT window
// でその UUID を context に持つ「亡霊」リクエストが、5 表を一切読めず・live tenant
// を書けないことを pin する。
//
// 構成: seed 済みテナント B を owner で scrub して ghost 化する (exam DELETE の
// FK cascade で cards/source_docs を落とし、tombstone/study_day を明示 delete、
// users は deleted_at を set = 行は残す)。A は live tenant のまま。owner ground-
// truth で「child 行が実在しない」ことを確認し、RLS 不可視と削除漏れを混同しない。
//
// WITH CHECK の機微 (brief §4): ghost が「自 user_id」で insert する行は WITH CHECK
// (user_id=ctx=ghost) を通る = policy 上は正当。ゆえに ghost の INSERT 拒否は
// 「他 tenant の user_id 宛」でのみ試す (自 id 宛が拒否されないことも明示 assert)。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards, exams, studyDays, tombstones, users } from '@/lib/db/schema'

import { asTenant } from './setup/as-tenant'
import { assertRejectsWithRlsViolation } from './setup/rls-assert'
import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

describe('RLS ghost (scrubbed user context)', () => {
  let fixture: TenantFixture
  // ghost = scrub 後の B。live = A。
  let ghostId: string

  // B を scrub して ghost 化する。owner (RLS bypass) で実行。
  async function scrubTenantB(): Promise<void> {
    const owner = getFixtureOwnerDb()
    // scrub 前: child 行が実在することを確認 (削除の非 vacuous 性)。
    const beforeCards = await owner
      .select({ id: cards.id })
      .from(cards)
      .where(eq(cards.userId, fixture.b.userId))
    expect(beforeCards.length).toBeGreaterThan(0)

    // exam DELETE → FK cascade で cards / source_documents / card_tags 等を落とす。
    await owner.delete(exams).where(eq(exams.userId, fixture.b.userId))
    // tombstones / study_days は users 直参照 (exam cascade 対象外) ゆえ明示 delete。
    await owner.delete(tombstones).where(eq(tombstones.userId, fixture.b.userId))
    await owner.delete(studyDays).where(eq(studyDays.userId, fixture.b.userId))
    // users 行は残し deleted_at set + PII null (scrub)。
    await owner
      .update(users)
      .set({ deletedAt: new Date('2026-07-01T00:00:00.000Z'), email: null, clerkId: null })
      .where(eq(users.id, fixture.b.userId))
  }

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    await scrubTenantB()
    ghostId = fixture.b.userId
  })

  it('owner ground-truth: scrubbed child rows are truly absent (not RLS-hidden)', async () => {
    const owner = getFixtureOwnerDb()
    const [ex, cd, tb, sd] = await Promise.all([
      owner.select({ id: exams.id }).from(exams).where(eq(exams.userId, ghostId)),
      owner.select({ id: cards.id }).from(cards).where(eq(cards.userId, ghostId)),
      owner.select({ id: tombstones.id }).from(tombstones).where(eq(tombstones.userId, ghostId)),
      owner.select({ userId: studyDays.userId }).from(studyDays).where(eq(studyDays.userId, ghostId)),
    ])
    expect(ex).toHaveLength(0)
    expect(cd).toHaveLength(0)
    expect(tb).toHaveLength(0)
    expect(sd).toHaveLength(0)

    // users 行は残存 (deleted_at set) — RLS が隠す対象がそこに実在することの確認。
    const u = await owner
      .select({ id: users.id, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, ghostId))
    expect(u).toHaveLength(1)
    expect(u[0]?.deletedAt).not.toBeNull()
  })

  it('ghost context reads 0 rows from all 5 tables', async () => {
    // users は行が実在するが deleted_at IS NULL clause で不可視 (RLS 単独防御)。
    // 他 4 表は行が存在しない (cascade 削除済)。
    const [u, ex, cd, tb, sd] = await asTenant(ghostId, async (tx) => [
      await tx.select({ id: users.id }).from(users),
      await tx.select({ id: exams.id }).from(exams),
      await tx.select({ id: cards.id }).from(cards),
      await tx.select({ id: tombstones.id }).from(tombstones),
      await tx.select({ userId: studyDays.userId }).from(studyDays),
    ])
    expect(u).toHaveLength(0)
    expect(ex).toHaveLength(0)
    expect(cd).toHaveLength(0)
    expect(tb).toHaveLength(0)
    expect(sd).toHaveLength(0)
  })

  it('ghost cannot write a live tenant (A) row (0 rows); A can (positive control)', async () => {
    const owner = getFixtureOwnerDb()

    const ghostRows = await asTenant(ghostId, (tx) =>
      tx
        .update(cards)
        .set({ title: 'GHOSTED' })
        .where(eq(cards.id, fixture.a.cardId))
        .returning({ id: cards.id }),
    )
    expect(ghostRows).toHaveLength(0)
    const aAfter = await owner
      .select({ title: cards.title })
      .from(cards)
      .where(eq(cards.id, fixture.a.cardId))
    expect(aAfter[0]?.title).toBe('Card A')

    // positive control: 同じ行を A context なら更新できる (行は writable、ghost が不可なだけ)。
    const aRows = await asTenant(fixture.a.userId, (tx) =>
      tx
        .update(cards)
        .set({ title: 'A own updated' })
        .where(eq(cards.id, fixture.a.cardId))
        .returning({ id: cards.id }),
    )
    expect(aRows).toHaveLength(1)
  })

  it('ghost INSERT is rejected for a DIFFERENT tenant user_id, but allowed for its own', async () => {
    const owner = getFixtureOwnerDb()

    // 他 tenant (A) の user_id 宛 INSERT → WITH CHECK 違反で reject。
    await assertRejectsWithRlsViolation(() =>
      asTenant(ghostId, (tx) =>
        tx.insert(exams).values({ userId: fixture.a.userId, name: 'planted for A' }),
      ),
    )
    const planted = await owner
      .select({ id: exams.id })
      .from(exams)
      .where(eq(exams.userId, fixture.a.userId))
    // A の元 exam のみ (ghost の planted 行は入っていない)。
    expect(planted.map(() => 'exists')).toEqual(['exists'])

    // 自 user_id (ghost) 宛 INSERT は WITH CHECK (user_id=ctx=ghost) を通る =
    // policy 上は正当。これを「拒否されるべき」と誤解して assert しない。
    const [inserted] = await asTenant(ghostId, (tx) =>
      tx
        .insert(exams)
        .values({ userId: ghostId, name: 'ghost own exam' })
        .returning({ id: exams.id }),
    )
    expect(inserted?.id).toBeDefined()
    const ownRow = await owner
      .select({ id: exams.id })
      .from(exams)
      .where(eq(exams.userId, ghostId))
    expect(ownRow).toHaveLength(1)
  })
})
