// RLS-P2 Task 9 — item (2): per-command policy (spec §3.1-3)。
//
// cards 代表 4 操作 (INSERT WITH CHECK / UPDATE USING / UPDATE WITH CHECK /
// DELETE) と users 6 項目 (SELECT/UPDATE/INSERT/UPDATE-id/DELETE + definer
// cross-ref) を per-command で pin する。刺激 = asTenant + app 層 eq(userId) を
// 外した直接クエリ。観測/seed = owner。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards, users } from '@/lib/db/schema'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'

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

const CARD_OPTIONS = [
  { id: 'a', uid: '00000000-0000-4000-8000-000000000001', text: 'opt a', is_correct: true },
  { id: 'b', uid: '00000000-0000-4000-8000-000000000002', text: 'opt b', is_correct: false },
]

describe('RLS per-command', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  // ------------------------------------------------------------ cards 4 ops
  describe('cards', () => {
    it('INSERT WITH CHECK: A cannot insert a row owned by B; A can insert its own (positive control)', async () => {
      const owner = getFixtureOwnerDb()

      // positive control: A が自 user_id で insert → 成功。
      const ownCardId = randomUUID()
      await asTenant(fixture.a.userId, (tx) =>
        tx.insert(cards).values({
          id: ownCardId,
          userId: fixture.a.userId,
          examId: fixture.a.examId,
          sourceDocumentId: fixture.a.sourceDocumentId,
          title: 'A own insert',
          questionText: 'Q?',
          options: CARD_OPTIONS,
          correctAnswerIds: ['a'],
          ...initialFsrsState(new Date()),
        }),
      )
      const inserted = await owner
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, ownCardId))
      expect(inserted).toHaveLength(1)

      // negative: A context で user_id=B の行を insert → WITH CHECK 違反 (FK は
      // RLS を bypass するため B の exam/source_document は valid、弾くのは policy)。
      const hackCardId = randomUUID()
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(cards).values({
            id: hackCardId,
            userId: fixture.b.userId,
            examId: fixture.b.examId,
            sourceDocumentId: fixture.b.sourceDocumentId,
            title: 'planted for B',
            questionText: 'Q?',
            options: CARD_OPTIONS,
            correctAnswerIds: ['a'],
            ...initialFsrsState(new Date()),
          }),
        ),
      )
      const planted = await owner
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, hackCardId))
      expect(planted).toHaveLength(0)
    })

    it('UPDATE USING: A cannot update B card (0 rows); A can update own (positive control)', async () => {
      const okRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(cards)
          .set({ title: 'A own updated' })
          .where(eq(cards.id, fixture.a.cardId))
          .returning({ id: cards.id }),
      )
      expect(okRows).toHaveLength(1)

      const hackRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(cards)
          .set({ title: 'HACKED' })
          .where(eq(cards.id, fixture.b.cardId))
          .returning({ id: cards.id }),
      )
      expect(hackRows).toHaveLength(0)
    })

    it('UPDATE WITH CHECK: A cannot re-assign its own card to B (rejected); B userid unchanged', async () => {
      // 旧行は USING を満たし可視 (user_id=A=ctx) だが、new row の user_id=B が
      // WITH CHECK に違反 → reject (0 行 silent update ではない)。
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx
            .update(cards)
            .set({ userId: fixture.b.userId })
            .where(eq(cards.id, fixture.a.cardId)),
        ),
      )
      const after = await getFixtureOwnerDb()
        .select({ userId: cards.userId })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(after[0]?.userId).toBe(fixture.a.userId)
    })

    it('DELETE: A cannot delete B card (0 rows, B survives); A can delete own (positive control)', async () => {
      const owner = getFixtureOwnerDb()

      const hackRows = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(cards).where(eq(cards.id, fixture.b.cardId)).returning({ id: cards.id }),
      )
      expect(hackRows).toHaveLength(0)
      const bSurvives = await owner
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(bSurvives).toHaveLength(1)

      const okRows = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(cards).where(eq(cards.id, fixture.a.cardId)).returning({ id: cards.id }),
      )
      expect(okRows).toHaveLength(1)
      const aGone = await owner
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(aGone).toHaveLength(0)
    })
  })

  // ----------------------------------------------------------- users 6 items
  // 6項目め (definer scrub のみ成功 = context 一致で app_scrub_deleted_user が
  // 走る) は既存 rls-functions.test.ts の 'app_scrub_deleted_user > scrubs the
  // row when the arg matches the tenant context' が behavioral に pin 済のため
  // cross-ref に留める (重複回避)。
  describe('users', () => {
    // owner で scrub 済み ghost (deleted_at set) を作り id を返す。
    async function seedGhost(): Promise<string> {
      const [row] = await getFixtureOwnerDb()
        .insert(users)
        .values({ deletedAt: new Date('2026-07-01T00:00:00.000Z'), clerkId: null, email: null })
        .returning({ id: users.id })
      return row!.id
    }

    it('(1) SELECT: scrubbed user is invisible to its own context (0 rows); live A visible (positive control)', async () => {
      const ghostId = await seedGhost()

      const ghostRows = await asTenant(ghostId, (tx) =>
        tx.select({ id: users.id }).from(users),
      )
      expect(ghostRows).toHaveLength(0)

      const liveRows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: users.id }).from(users),
      )
      expect(liveRows.map((r) => r.id)).toEqual([fixture.a.userId])
    })

    it('(2) UPDATE: scrubbed user cannot be updated by its own context (0 rows); live A can (positive control)', async () => {
      const ghostId = await seedGhost()

      const ghostRows = await asTenant(ghostId, (tx) =>
        tx
          .update(users)
          .set({ email: 'revived@example.test' })
          .where(eq(users.id, ghostId))
          .returning({ id: users.id }),
      )
      expect(ghostRows).toHaveLength(0)
      const ghostAfter = await getFixtureOwnerDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, ghostId))
      expect(ghostAfter[0]?.email).toBeNull()

      const liveRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(users)
          .set({ email: 'a@example.test' })
          .where(eq(users.id, fixture.a.userId))
          .returning({ id: users.id }),
      )
      expect(liveRows).toHaveLength(1)
    })

    it('(3) INSERT: A cannot insert a user whose id != context (rejected); own-id insert succeeds (positive control)', async () => {
      const owner = getFixtureOwnerDb()

      const foreignId = randomUUID()
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(users).values({ id: foreignId, clerkId: `ck_foreign_${foreignId}` }),
        ),
      )
      const planted = await owner
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, foreignId))
      expect(planted).toHaveLength(0)

      // positive control: id = context の insert は WITH CHECK を通る。
      const selfId = randomUUID()
      await asTenant(selfId, (tx) =>
        tx.insert(users).values({ id: selfId, clerkId: `ck_self_${selfId}` }),
      )
      const created = await owner
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, selfId))
      expect(created).toHaveLength(1)
    })

    it('(4) UPDATE id: A cannot re-key its own row to a different id (rejected); id-preserving update succeeds (positive control)', async () => {
      const newId = randomUUID()
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.update(users).set({ id: newId }).where(eq(users.id, fixture.a.userId)),
        ),
      )
      const after = await getFixtureOwnerDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, fixture.a.userId))
      expect(after).toHaveLength(1)

      // positive control: id を変えない UPDATE (email 更新) は WITH CHECK を通る。
      const okRows = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(users)
          .set({ email: 'still-a@example.test' })
          .where(eq(users.id, fixture.a.userId))
          .returning({ id: users.id }),
      )
      expect(okRows).toHaveLength(1)
    })

    it('(5) DELETE: no DELETE policy → app-role delete of own row affects 0 rows; row survives', async () => {
      // users には DELETE policy が無い = default-deny。RLS 有効表への policy 無し
      // command は「全行不可視」として扱われ、DELETE は 0 行 (error ではなく silent)。
      const deleted = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(users).where(eq(users.id, fixture.a.userId)).returning({ id: users.id }),
      )
      expect(deleted).toHaveLength(0)

      const survives = await getFixtureOwnerDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, fixture.a.userId))
      expect(survives).toHaveLength(1)
    })
  })
})
