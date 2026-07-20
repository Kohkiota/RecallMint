// RLS-P2 Task 9 — item (1): RLS 単独防御 (spec §3.1-2)。
//
// 刺激は app-role + tenant context (asTenant) 内の「app 層 eq(userId) を意図的に
// 外した」直接クエリ。これで RLS policy 単独 (USING/WITH CHECK) が隔離を強制する
// ことを見る (app 層 WHERE の効果を混ぜない)。観測/seed は owner (RLS bypass)。
//
// 5 表 {cards, exams, tombstones, study_days, users} × read/write を代表で:
//   - read : WHERE user_id なしの select → A 行のみ・B 行を含まない (+ A 自身は返る)。
//   - write: user_id 述語なしで B の行を狙う → 0 行 (USING が B 行を A から不可視化)。
//            owner で B 不変を確認。positive control で A 自身への write 成功を確認。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards, exams, studyDays, tombstones, users } from '@/lib/db/schema'

import { asTenant } from './setup/as-tenant'
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

describe('RLS single-defense: eq(userId) omitted, policy alone isolates', () => {
  let fixture: TenantFixture
  // tombstones の id は TenantFixture に含まれないため owner で拾う (write 代表用)。
  let aTombstoneId: string
  let bTombstoneId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    const owner = getFixtureOwnerDb()
    const aTomb = await owner
      .select({ id: tombstones.id })
      .from(tombstones)
      .where(eq(tombstones.userId, fixture.a.userId))
    const bTomb = await owner
      .select({ id: tombstones.id })
      .from(tombstones)
      .where(eq(tombstones.userId, fixture.b.userId))
    aTombstoneId = aTomb[0]!.id
    bTombstoneId = bTomb[0]!.id
  })

  // ------------------------------------------------------------------ reads
  describe('read (SELECT with no user_id predicate)', () => {
    it('cards: A sees own row, not B (+ every returned row is A)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: cards.id, userId: cards.userId }).from(cards),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.cardId) // positive control
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.cardId) // negative
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('exams: A sees own row, not B', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: exams.id, userId: exams.userId }).from(exams),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.examId)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.examId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('tombstones: A sees own rows only, none belong to B', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: tombstones.userId }).from(tombstones),
      )
      expect(rows.length).toBeGreaterThan(0) // positive control (A has ≥1)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    })

    it('study_days: A sees own rows only, none belong to B', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: studyDays.userId }).from(studyDays),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    })

    it('users: A sees exactly its own row, not B', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: users.id }).from(users),
      )
      expect(rows.map((r) => r.id)).toEqual([fixture.a.userId])
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.userId)
    })

    it('users: a soft-deleted A (deleted_at set) sees 0 rows (deleted_at IS NULL clause)', async () => {
      // users_select USING = id=ctx AND deleted_at IS NULL。owner で A を soft-delete
      // すると、A 自身の context でも自 行が消える (deleted 除外)。
      await getFixtureOwnerDb()
        .update(users)
        .set({ deletedAt: new Date('2026-07-18T00:00:00.000Z') })
        .where(eq(users.id, fixture.a.userId))

      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: users.id }).from(users),
      )
      expect(rows).toHaveLength(0)
    })
  })

  // ----------------------------------------------------------------- writes
  describe('write (UPDATE with no user_id predicate, targeting B)', () => {
    it('cards: A cannot update B card (0 rows); A can update own (positive control)', async () => {
      const owner = getFixtureOwnerDb()

      // positive control: A 自身の card は書ける。
      const okRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(cards)
          .set({ title: 'A-own-updated' })
          .where(eq(cards.id, fixture.a.cardId))
          .returning({ id: cards.id }),
      )
      expect(okRows).toHaveLength(1)
      const aAfter = await owner
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(aAfter[0]?.title).toBe('A-own-updated')

      // negative: B の card を A context から狙う → 0 行 (USING が不可視化)。
      const hackRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(cards)
          .set({ title: 'HACKED' })
          .where(eq(cards.id, fixture.b.cardId))
          .returning({ id: cards.id }),
      )
      expect(hackRows).toHaveLength(0)
      const bAfter = await owner
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(bAfter[0]?.title).toBe('Card B')
    })

    it('exams: A cannot update B exam (0 rows); A can update own (positive control)', async () => {
      const owner = getFixtureOwnerDb()

      const okRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(exams)
          .set({ name: 'A-own-updated' })
          .where(eq(exams.id, fixture.a.examId))
          .returning({ id: exams.id }),
      )
      expect(okRows).toHaveLength(1)

      const hackRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(exams)
          .set({ name: 'HACKED' })
          .where(eq(exams.id, fixture.b.examId))
          .returning({ id: exams.id }),
      )
      expect(hackRows).toHaveLength(0)
      const bAfter = await owner
        .select({ name: exams.name })
        .from(exams)
        .where(eq(exams.id, fixture.b.examId))
      expect(bAfter[0]?.name).toBe('Exam B')
    })

    it('tombstones: A cannot update B tombstone (0 rows); A can update own (positive control)', async () => {
      const okRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(tombstones)
          .set({ deletedAt: new Date('2030-01-01T00:00:00.000Z') })
          .where(eq(tombstones.id, aTombstoneId))
          .returning({ id: tombstones.id }),
      )
      expect(okRows).toHaveLength(1)

      const hackRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(tombstones)
          .set({ deletedAt: new Date('2030-01-01T00:00:00.000Z') })
          .where(eq(tombstones.id, bTombstoneId))
          .returning({ id: tombstones.id }),
      )
      expect(hackRows).toHaveLength(0)
    })

    it('study_days: shared-day UPDATE hits only A row; B row untouched (RLS scopes)', async () => {
      // WHERE day='2026-07-18' は A/B 双方の行に一致するが、USING が A の行のみに
      // scope するため returning は A の 1 行だけ。B の行は owner で不変を確認。
      const owner = getFixtureOwnerDb()
      const day = '2026-07-18'

      const updated = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(studyDays)
          .set({ reviewCount: 42 })
          .where(eq(studyDays.day, day))
          .returning({ userId: studyDays.userId, reviewCount: studyDays.reviewCount }),
      )
      expect(updated).toHaveLength(1)
      expect(updated[0]?.userId).toBe(fixture.a.userId)
      expect(updated[0]?.reviewCount).toBe(42)

      const bAfter = await owner
        .select({ reviewCount: studyDays.reviewCount })
        .from(studyDays)
        .where(eq(studyDays.userId, fixture.b.userId))
      expect(bAfter[0]?.reviewCount).toBe(0)
    })
  })
})
