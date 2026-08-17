// pull 6-stream + tag-mutation isolation under full RLS。
//
// 旧: RLS-P2 Task 9 item (6) = partial 残余の連鎖回帰(RLS 表 + 非 RLS の tag 3 表を跨ぐ
// mixed chain)。RLS-P3 Wave 1 で tag_categories/tag_options/card_tags も RLS 化されたため、
// 下記 2 経路は **全表 RLS** となり mixed(partial)ではなくなった。assertion は不変
// (隔離: A の行のみ・B 非混在)ゆえ、pull の 6 delta + tag mutation が全表 RLS 下でも
// 挙動不変であることの regression として維持し、名称を実態に追従させる。
// ※「partial-RLS(RLS 表 + off 表の混在 tx)が安全」の intentional な behavioral 証明は
//   本 file から外れた(off 表を触らなくなったため)。その証明は Wave 2 で新設する
//   (Step 0 factfinding 追補2 の follow-up 台帳・恒久 off の global 表 × RLS 表)。
//
//  - bulk mutation: CARD_FIELD_HANDLERS.tag_option_ids は 1 tx で cards[RLS] の存在確認 +
//    updated_at bump と、tag_options/tag_categories/card_tags[RLS] の検証・whole-set
//    replace を行う。A の mutation は正常適用・B は不変。
//  - pull 6 delta: /api/pull の withTenantTx ブロックのうち **6 delta ぶん**を asTenant(A)
//    で引く。cards/exams/tombstones + tag_categories/tag_options/card_tags[全て RLS] の
//    全 stream が A の行を返し B は 1 行も混ざらない。
//    ※ 同ブロックの read は 2026-08-17 以降 7 本(6 delta + 変更 card ぶんの
//      getCardTagsByCardIds)。7 本目の隔離は delta-isolation.test.ts の
//      「getCardTagsByCardIds」3 describe(owner 接続 = RLS bypass / asTenant / RLS
//      backstop)が pin 済ゆえ、本 file には足さない(同じ隔離の二重 pin を避ける)。
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

describe('RLS isolation: pull 6-stream + tag-mutation (all RLS after Wave 1)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  describe('bulk mutation: tag_option_ids (cards + tags, all RLS, one tx)', () => {
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

  // 7 本目の by-card read は含まない(冒頭 header 参照 — delta-isolation.test.ts が pin)。
  describe('pull 6-stream (asTenant, /api/pull withTenantTx block の 6 delta ぶん; all RLS)', () => {
    const since = new Date('2020-01-01T00:00:00.000Z')

    it('every stream returns A rows and excludes B (all RLS tables)', async () => {
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
      // tag_categories[RLS]
      expect(streams.tc.rows.map((r) => r.id)).toContain(fixture.a.tagCategoryId)
      expect(streams.tc.rows.map((r) => r.id)).not.toContain(fixture.b.tagCategoryId)
      // tag_options[RLS]
      expect(streams.to.rows.map((r) => r.id)).toContain(fixture.a.tagOptionId)
      expect(streams.to.rows.map((r) => r.id)).not.toContain(fixture.b.tagOptionId)
      // card_tags[RLS]
      expect(streams.ct.rows.map((r) => r.card_id)).toContain(fixture.a.cardId)
      expect(streams.ct.rows.map((r) => r.card_id)).not.toContain(fixture.b.cardId)
    })
  })
})
