// RLS-P2 Task 9 — item (6): partial 残余の連鎖回帰 (spec §3.1-10)。
//
// 同一リクエストで RLS 表と非 RLS 表 (tag 3 表) を跨ぐ代表 2 経路が RLS-on でも
// 挙動不変であることを pin する:
//  - bulk mutation: CARD_FIELD_HANDLERS.tag_option_ids は 1 tx で cards[RLS] の
//    存在確認 + updated_at bump と、tag_options/tag_categories/card_tags[非RLS] の
//    検証・whole-set replace を行う。A の mutation は正常適用・B は不変。
//  - pull mixed 6 stream: /api/pull の withTenantTx ブロックと同型に 6 delta を
//    asTenant(A) で引く。cards/exams/tombstones[RLS] + tag_categories/tag_options/
//    card_tags[非RLS] の全 stream が A の行を返し B は 1 行も混ざらない。
//
// mutating (bulk) を含むため beforeEach で truncate→seed。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cardTags, tombstones } from '@/lib/db/schema'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { getCategoriesDelta } from '@/lib/db/tag-categories-pull'
import { getOptionsDelta } from '@/lib/db/tag-options-pull'
import { getCardTagsDelta } from '@/lib/db/card-tags-pull'

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

describe('RLS partial-chain regression (mixed RLS + non-RLS tables)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  describe('bulk mutation: tag_option_ids (cards[RLS] + tags[non-RLS] in one tx)', () => {
    it('A whole-set replace applies (clear then re-add); B card_tags unchanged', async () => {
      const owner = getFixtureOwnerDb()

      // clear: A の card_tags 全削除 (cards[RLS] SELECT + card_tags[非RLS] DELETE)。
      const cleared = await asTenant(fixture.a.userId, (tx) =>
        CARD_FIELD_HANDLERS.tag_option_ids(tx, fixture.a.cardId, fixture.a.userId, []),
      )
      expect(cleared).toBe('applied')
      const aAfterClear = await owner
        .select({ optionId: cardTags.optionId })
        .from(cardTags)
        .where(eq(cardTags.cardId, fixture.a.cardId))
      expect(aAfterClear).toHaveLength(0)

      // B は不変 (fixture の 1 行が残る)。
      const bTags = await owner
        .select({ optionId: cardTags.optionId })
        .from(cardTags)
        .where(eq(cardTags.cardId, fixture.b.cardId))
      expect(bTags).toHaveLength(1)

      // re-add: A の option を付け直す (tag_options[非RLS] 検証 + card_tags INSERT +
      // cards[RLS] updated_at bump)。
      const readded = await asTenant(fixture.a.userId, (tx) =>
        CARD_FIELD_HANDLERS.tag_option_ids(tx, fixture.a.cardId, fixture.a.userId, [
          fixture.a.tagOptionId,
        ]),
      )
      expect(readded).toBe('applied')
      const aAfterAdd = await owner
        .select({ optionId: cardTags.optionId })
        .from(cardTags)
        .where(eq(cardTags.cardId, fixture.a.cardId))
      expect(aAfterAdd.map((r) => r.optionId)).toEqual([fixture.a.tagOptionId])
    })

    it("A cannot mutate B's card via the mixed handler ('failed'); B card_tags unchanged", async () => {
      const owner = getFixtureOwnerDb()

      const result = await asTenant(fixture.a.userId, (tx) =>
        CARD_FIELD_HANDLERS.tag_option_ids(tx, fixture.b.cardId, fixture.a.userId, [
          fixture.a.tagOptionId,
        ]),
      )
      expect(result).toBe('failed')

      const bTags = await owner
        .select({ optionId: cardTags.optionId })
        .from(cardTags)
        .where(eq(cardTags.cardId, fixture.b.cardId))
      expect(bTags).toHaveLength(1)
      expect(bTags[0]?.optionId).toBe(fixture.b.tagOptionId)
    })
  })

  describe('pull mixed 6-stream (asTenant, mirrors /api/pull withTenantTx block)', () => {
    const since = new Date('2020-01-01T00:00:00.000Z')

    it('every stream returns A rows and excludes B (RLS + non-RLS tables)', async () => {
      const owner = getFixtureOwnerDb()
      // tombstones の entity_id は fixture 追跡外ゆえ owner で拾う。
      const aTomb = await owner
        .select({ entityId: tombstones.entityId })
        .from(tombstones)
        .where(eq(tombstones.userId, fixture.a.userId))
      const bTomb = await owner
        .select({ entityId: tombstones.entityId })
        .from(tombstones)
        .where(eq(tombstones.userId, fixture.b.userId))
      const aTombEntityId = aTomb[0]!.entityId
      const bTombEntityId = bTomb[0]!.entityId

      const streams = await asTenant(fixture.a.userId, async (tx) => {
        const c = await getCardsDelta(fixture.a.userId, tx, since)
        const e = await getExamsDelta(fixture.a.userId, tx, since)
        const t = await getTombstonesDelta(fixture.a.userId, tx, since)
        const tc = await getCategoriesDelta(fixture.a.userId, tx, since)
        const to = await getOptionsDelta(fixture.a.userId, tx, since)
        const ct = await getCardTagsDelta(fixture.a.userId, tx, since)
        return { c, e, t, tc, to, ct }
      })

      // cards[RLS]
      expect(streams.c.rows.map((r) => r.id)).toContain(fixture.a.cardId)
      expect(streams.c.rows.map((r) => r.id)).not.toContain(fixture.b.cardId)
      // exams[RLS]
      expect(streams.e.rows.map((r) => r.id)).toContain(fixture.a.examId)
      expect(streams.e.rows.map((r) => r.id)).not.toContain(fixture.b.examId)
      // tombstones[RLS]
      expect(streams.t.rows.map((r) => r.entity_id)).toContain(aTombEntityId)
      expect(streams.t.rows.map((r) => r.entity_id)).not.toContain(bTombEntityId)
      // tag_categories[non-RLS]
      expect(streams.tc.rows.map((r) => r.id)).toContain(fixture.a.tagCategoryId)
      expect(streams.tc.rows.map((r) => r.id)).not.toContain(fixture.b.tagCategoryId)
      // tag_options[non-RLS]
      expect(streams.to.rows.map((r) => r.id)).toContain(fixture.a.tagOptionId)
      expect(streams.to.rows.map((r) => r.id)).not.toContain(fixture.b.tagOptionId)
      // card_tags[non-RLS]
      expect(streams.ct.rows.map((r) => r.card_id)).toContain(fixture.a.cardId)
      expect(streams.ct.rows.map((r) => r.card_id)).not.toContain(fixture.b.cardId)
    })
  })
})
