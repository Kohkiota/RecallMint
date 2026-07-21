// RLS-P3 Wave 1 — 配線ゼロ 8 表の RLS 単独防御 + loud + review-ingest 特有ケース。
//
// 対象 8 表: reviews / answer_events / tag_categories / tag_options / card_tags /
//   entity_mutations / card_asset_refs / ai_usage_users。全て write/read path が既に
//   setTenantContext 済 (Step 0 §5.3 Wave 1)。本 file は policy 追加の behavioral 実効を
//   P2 (rls-single-defense.test.ts / rls-context.test.ts) と同型に pin する:
//   - read : eq(userId) を意図的に外した select → A 行のみ・B 非混在。
//   - write: user_id 述語なしで B を狙う → 0 行 (USING が B を A から不可視化)。
//   - loud : context 未設定で read/write → P0RLS RAISE (app_current_user_id が未設定で raise)。
//   刺激 = app-role + tenant context (asTenant)。観測/seed = owner (RLS bypass)。
//
// review-ingest 特有 (Step 0 §3.3 / §4.3):
//   - answer_events.event_id global UNIQUE は RLS 越しでも ON CONFLICT を従来どおり判定する
//     (同 tenant dup / cross-tenant dup とも挙動不変 = RLS 導入で idempotency は変わらない)。
//   - entity-mutations/bulk 経路: card_asset_refs + entity_mutations が同 tx で RLS 下でも
//     従来どおり書ける (cross-tenant user_id は WITH CHECK 42501)。
//
// mutating test ゆえ beforeEach で truncate→seed。TenantFixture に無い id (reviews /
// answer_events / entity_mutations) は owner で拾う。
import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'
import {
  aiUsageUsers,
  answerEvents,
  cardAssetRefs,
  cardTags,
  entityMutations,
  reviews,
  tagCategories,
  tagOptions,
} from '@/lib/db/schema'

import { asTenant } from './setup/as-tenant'
import {
  assertRejectsWithP0RLS,
  assertRejectsWithRlsViolation,
} from './setup/rls-assert'
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

const SEED_DAY = '2026-07-18'

describe('RLS Wave 1 single-defense (8 zero-wiring tables)', () => {
  let fixture: TenantFixture
  // TenantFixture に含まれない decoy id を owner で拾う (write 代表 + ON CONFLICT 用)。
  let aReviewId: string
  let bReviewId: string
  let aAnswerEventId: string // answer_events.id (PK)
  let bAnswerEventId: string
  let aEventId: string // answer_events.event_id (global UNIQUE)
  let bEventId: string
  let aEntityMutationId: string
  let bEntityMutationId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
    const owner = getFixtureOwnerDb()

    const [aRev] = await owner
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.userId, fixture.a.userId))
    const [bRev] = await owner
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.userId, fixture.b.userId))
    aReviewId = aRev!.id
    bReviewId = bRev!.id

    const [aAe] = await owner
      .select({ id: answerEvents.id, eventId: answerEvents.eventId })
      .from(answerEvents)
      .where(eq(answerEvents.userId, fixture.a.userId))
    const [bAe] = await owner
      .select({ id: answerEvents.id, eventId: answerEvents.eventId })
      .from(answerEvents)
      .where(eq(answerEvents.userId, fixture.b.userId))
    aAnswerEventId = aAe!.id
    bAnswerEventId = bAe!.id
    aEventId = aAe!.eventId
    bEventId = bAe!.eventId

    const [aEm] = await owner
      .select({ id: entityMutations.id })
      .from(entityMutations)
      .where(eq(entityMutations.userId, fixture.a.userId))
    const [bEm] = await owner
      .select({ id: entityMutations.id })
      .from(entityMutations)
      .where(eq(entityMutations.userId, fixture.b.userId))
    aEntityMutationId = aEm!.id
    bEntityMutationId = bEm!.id
  })

  // ------------------------------------------------------------------ reads
  describe('read (SELECT with no user_id predicate): A sees own only, never B', () => {
    it('reviews', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: reviews.userId }).from(reviews),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    })

    it('answer_events', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: answerEvents.userId }).from(answerEvents),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    })

    it('tag_categories (id-level positive/negative)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: tagCategories.id, userId: tagCategories.userId }).from(tagCategories),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.tagCategoryId)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.tagCategoryId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('tag_options (id-level positive/negative)', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ id: tagOptions.id, userId: tagOptions.userId }).from(tagOptions),
      )
      expect(rows.map((r) => r.id)).toContain(fixture.a.tagOptionId)
      expect(rows.map((r) => r.id)).not.toContain(fixture.b.tagOptionId)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
    })

    it('card_tags', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: cardTags.userId, cardId: cardTags.cardId }).from(cardTags),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.cardId)).not.toContain(fixture.b.cardId)
    })

    it('entity_mutations', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: entityMutations.userId }).from(entityMutations),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    })

    it('card_asset_refs', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: cardAssetRefs.userId, cardId: cardAssetRefs.cardId }).from(cardAssetRefs),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.cardId)).not.toContain(fixture.b.cardId)
    })

    it('ai_usage_users', async () => {
      const rows = await asTenant(fixture.a.userId, (tx) =>
        tx.select({ userId: aiUsageUsers.userId }).from(aiUsageUsers),
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.userId === fixture.a.userId)).toBe(true)
      expect(rows.map((r) => r.userId)).not.toContain(fixture.b.userId)
    })
  })

  // ----------------------------------------------------------------- writes
  // negative: B の行を A context から狙う → 0 行 (USING が不可視化)・owner で B 不変。
  // positive control: A 自身の行への write は成功する。
  describe('write (targeting B → 0 rows; A own → applied)', () => {
    it('reviews UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx.update(reviews).set({ rating: 1 }).where(eq(reviews.id, bReviewId)).returning({ id: reviews.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner.select({ rating: reviews.rating }).from(reviews).where(eq(reviews.id, bReviewId))
      expect(bAfter[0]?.rating).toBe(3)

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx.update(reviews).set({ rating: 1 }).where(eq(reviews.id, aReviewId)).returning({ id: reviews.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('answer_events UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(answerEvents)
          .set({ isCorrect: false })
          .where(eq(answerEvents.id, bAnswerEventId))
          .returning({ id: answerEvents.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ isCorrect: answerEvents.isCorrect })
        .from(answerEvents)
        .where(eq(answerEvents.id, bAnswerEventId))
      expect(bAfter[0]?.isCorrect).toBe(true)

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(answerEvents)
          .set({ isCorrect: false })
          .where(eq(answerEvents.id, aAnswerEventId))
          .returning({ id: answerEvents.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('tag_categories UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(tagCategories)
          .set({ name: 'HACKED' })
          .where(eq(tagCategories.id, fixture.b.tagCategoryId))
          .returning({ id: tagCategories.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ name: tagCategories.name })
        .from(tagCategories)
        .where(eq(tagCategories.id, fixture.b.tagCategoryId))
      expect(bAfter[0]?.name).toBe('Cat B')

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(tagCategories)
          .set({ name: 'A-renamed' })
          .where(eq(tagCategories.id, fixture.a.tagCategoryId))
          .returning({ id: tagCategories.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('tag_options UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(tagOptions)
          .set({ name: 'HACKED' })
          .where(eq(tagOptions.id, fixture.b.tagOptionId))
          .returning({ id: tagOptions.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ name: tagOptions.name })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.b.tagOptionId))
      expect(bAfter[0]?.name).toBe('Option')

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(tagOptions)
          .set({ name: 'A-opt' })
          .where(eq(tagOptions.id, fixture.a.tagOptionId))
          .returning({ id: tagOptions.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('card_tags DELETE (junction)', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(cardTags).where(eq(cardTags.cardId, fixture.b.cardId)).returning({ cardId: cardTags.cardId }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner.select({ cardId: cardTags.cardId }).from(cardTags).where(eq(cardTags.cardId, fixture.b.cardId))
      expect(bAfter).toHaveLength(1)

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(cardTags).where(eq(cardTags.cardId, fixture.a.cardId)).returning({ cardId: cardTags.cardId }),
      )
      expect(ok).toHaveLength(1)
    })

    it('entity_mutations UPDATE', async () => {
      const owner = getFixtureOwnerDb()
      const marker = new Date('2030-01-01T00:00:00.000Z')
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(entityMutations)
          .set({ appliedAt: marker })
          .where(eq(entityMutations.id, bEntityMutationId))
          .returning({ id: entityMutations.id }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ appliedAt: entityMutations.appliedAt })
        .from(entityMutations)
        .where(eq(entityMutations.id, bEntityMutationId))
      expect(bAfter[0]?.appliedAt).toBeNull()

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(entityMutations)
          .set({ appliedAt: marker })
          .where(eq(entityMutations.id, aEntityMutationId))
          .returning({ id: entityMutations.id }),
      )
      expect(ok).toHaveLength(1)
    })

    it('card_asset_refs DELETE (composite PK)', async () => {
      const owner = getFixtureOwnerDb()
      const hack = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(cardAssetRefs).where(eq(cardAssetRefs.cardId, fixture.b.cardId)).returning({ cardId: cardAssetRefs.cardId }),
      )
      expect(hack).toHaveLength(0)
      const bAfter = await owner
        .select({ cardId: cardAssetRefs.cardId })
        .from(cardAssetRefs)
        .where(eq(cardAssetRefs.cardId, fixture.b.cardId))
      expect(bAfter).toHaveLength(1)

      const ok = await asTenant(fixture.a.userId, (tx) =>
        tx.delete(cardAssetRefs).where(eq(cardAssetRefs.cardId, fixture.a.cardId)).returning({ cardId: cardAssetRefs.cardId }),
      )
      expect(ok).toHaveLength(1)
    })

    it('ai_usage_users shared-day UPDATE hits only A; B row untouched', async () => {
      // date=SEED_DAY は A/B 双方に一致するが USING が A に scope → returning は A の 1 行だけ。
      const owner = getFixtureOwnerDb()
      const updated = await asTenant(fixture.a.userId, (tx) =>
        tx
          .update(aiUsageUsers)
          .set({ count: 99 })
          .where(eq(aiUsageUsers.date, SEED_DAY))
          .returning({ userId: aiUsageUsers.userId, count: aiUsageUsers.count }),
      )
      expect(updated).toHaveLength(1)
      expect(updated[0]?.userId).toBe(fixture.a.userId)
      expect(updated[0]?.count).toBe(99)

      const bAfter = await owner
        .select({ count: aiUsageUsers.count })
        .from(aiUsageUsers)
        .where(eq(aiUsageUsers.userId, fixture.b.userId))
      expect(bAfter[0]?.count).toBe(1)
    })
  })

  // ------------------------------------------------------------ loud (P0RLS)
  // context 未設定で当該表を触ると policy 述語 app_current_user_id() が RAISE する。
  // read = bare SELECT (全 scan・曖昧さなく RAISE を保証する主証明) / write = user_id 述語つき
  // DELETE。write は seed が 2-4 行で seqscan 確定ゆえ security-qual が先頭 tuple で必ず発火する
  // (巨大表で index scan が選ばれると 0 行短絡の理論余地があるが本 suite では非該当。read-loud が
  // 全 scan で無条件に RAISE を証明するため write-loud は補強)。
  describe('loud on missing context (P0RLS) — read + write per table', () => {
    const decoyUser = '00000000-0000-4000-8000-0000000000ff'

    it('reviews: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: reviews.id }).from(reviews))
      await assertRejectsWithP0RLS(() => getDb().delete(reviews).where(eq(reviews.userId, decoyUser)))
    })
    it('answer_events: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: answerEvents.id }).from(answerEvents))
      await assertRejectsWithP0RLS(() => getDb().delete(answerEvents).where(eq(answerEvents.userId, decoyUser)))
    })
    it('tag_categories: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: tagCategories.id }).from(tagCategories))
      await assertRejectsWithP0RLS(() => getDb().delete(tagCategories).where(eq(tagCategories.userId, decoyUser)))
    })
    it('tag_options: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: tagOptions.id }).from(tagOptions))
      await assertRejectsWithP0RLS(() => getDb().delete(tagOptions).where(eq(tagOptions.userId, decoyUser)))
    })
    it('card_tags: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ cardId: cardTags.cardId }).from(cardTags))
      await assertRejectsWithP0RLS(() => getDb().delete(cardTags).where(eq(cardTags.userId, decoyUser)))
    })
    it('entity_mutations: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ id: entityMutations.id }).from(entityMutations))
      await assertRejectsWithP0RLS(() => getDb().delete(entityMutations).where(eq(entityMutations.userId, decoyUser)))
    })
    it('card_asset_refs: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ cardId: cardAssetRefs.cardId }).from(cardAssetRefs))
      await assertRejectsWithP0RLS(() => getDb().delete(cardAssetRefs).where(eq(cardAssetRefs.userId, decoyUser)))
    })
    it('ai_usage_users: SELECT + DELETE without context raise P0RLS', async () => {
      await assertRejectsWithP0RLS(() => getDb().select({ userId: aiUsageUsers.userId }).from(aiUsageUsers))
      await assertRejectsWithP0RLS(() => getDb().delete(aiUsageUsers).where(eq(aiUsageUsers.userId, decoyUser)))
    })
  })

  // -------------------------------------------- review-ingest 特有 (Step 0 §3.3/§4.3)
  describe('answer_events event_id ON CONFLICT is unchanged by RLS', () => {
    it('same-tenant duplicate event_id → DO NOTHING (0 inserted); fresh → 1 inserted', async () => {
      // A context で A の既存 event_id を再 insert → ON CONFLICT DO NOTHING で 0 行。
      const dup = await asTenant(fixture.a.userId, (tx) =>
        tx
          .insert(answerEvents)
          .values({
            eventId: aEventId,
            cardId: fixture.a.cardId,
            userId: fixture.a.userId,
            isCorrect: true,
            answeredAt: new Date(SEED_DAY),
          })
          .onConflictDoNothing({ target: answerEvents.eventId })
          .returning({ id: answerEvents.id }),
      )
      expect(dup).toHaveLength(0)

      // fresh event_id は通常どおり 1 行 insert (RLS 下でも新規は通る)。
      const fresh = await asTenant(fixture.a.userId, (tx) =>
        tx
          .insert(answerEvents)
          .values({
            eventId: randomUUID(),
            cardId: fixture.a.cardId,
            userId: fixture.a.userId,
            isCorrect: true,
            answeredAt: new Date(SEED_DAY),
          })
          .onConflictDoNothing({ target: answerEvents.eventId })
          .returning({ id: answerEvents.id }),
      )
      expect(fresh).toHaveLength(1)
    })

    it('cross-tenant duplicate event_id → still DO NOTHING (global UNIQUE is RLS-transparent); B row intact', async () => {
      // A context で B の event_id を DO NOTHING insert → global UNIQUE が RLS 越しで衝突判定 →
      // conflict で DO NOTHING = 何も insert されない (0 行)。B の元行は不変 = idempotency は
      // RLS 導入で変わらない(挿入値 user_id=A 自体は WITH CHECK を満たすが、conflict path ゆえ
      // そもそも書込・check に到達しない)。
      const owner = getFixtureOwnerDb()
      const res = await asTenant(fixture.a.userId, (tx) =>
        tx
          .insert(answerEvents)
          .values({
            eventId: bEventId,
            cardId: fixture.a.cardId,
            userId: fixture.a.userId,
            isCorrect: true,
            answeredAt: new Date(SEED_DAY),
          })
          .onConflictDoNothing({ target: answerEvents.eventId })
          .returning({ id: answerEvents.id }),
      )
      expect(res).toHaveLength(0)

      const bRow = await owner
        .select({ userId: answerEvents.userId })
        .from(answerEvents)
        .where(eq(answerEvents.eventId, bEventId))
      expect(bRow).toHaveLength(1)
      expect(bRow[0]?.userId).toBe(fixture.b.userId)
    })
  })

  describe('entity-mutations dual-table write under RLS (card_asset_refs + entity_mutations, one tx)', () => {
    it('A can write both tables in one tenant tx; owner sees both', async () => {
      const owner = getFixtureOwnerDb()
      const newMutationId = randomUUID()
      await asTenant(fixture.a.userId, async (tx) => {
        await tx.insert(cardAssetRefs).values({
          cardId: fixture.a.cardId,
          assetId: fixture.a.assetId,
          userId: fixture.a.userId,
          fieldKey: 'explanation',
          ordinal: 0,
        })
        await tx.insert(entityMutations).values({
          mutationId: newMutationId,
          entityType: 'card',
          entityId: fixture.a.cardId,
          userId: fixture.a.userId,
          op: 'update_field',
          patch: {},
          editedAt: new Date(SEED_DAY),
        })
      })

      const ref = await owner
        .select({ fieldKey: cardAssetRefs.fieldKey })
        .from(cardAssetRefs)
        .where(and(eq(cardAssetRefs.cardId, fixture.a.cardId), eq(cardAssetRefs.fieldKey, 'explanation')))
      expect(ref).toHaveLength(1)
      const em = await owner
        .select({ id: entityMutations.id })
        .from(entityMutations)
        .where(eq(entityMutations.mutationId, newMutationId))
      expect(em).toHaveLength(1)
    })

    it("A context writing B's user_id into either table → WITH CHECK violation (42501)", async () => {
      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(entityMutations).values({
            mutationId: randomUUID(),
            entityType: 'card',
            entityId: fixture.a.cardId,
            userId: fixture.b.userId, // cross-tenant → WITH CHECK fails
            op: 'update_field',
            patch: {},
            editedAt: new Date(SEED_DAY),
          }),
        ),
      )

      await assertRejectsWithRlsViolation(() =>
        asTenant(fixture.a.userId, (tx) =>
          tx.insert(cardAssetRefs).values({
            cardId: fixture.a.cardId,
            assetId: fixture.a.assetId,
            userId: fixture.b.userId, // cross-tenant → WITH CHECK fails
            fieldKey: 'memo',
            ordinal: 0,
          }),
        ),
      )
    })
  })
})
