// owner-mismatch delete = silent no-op の app 層 pin(Sprint B の owner 規則の土台)。
//
// 対象 3 経路(いずれも「owner-scoped 存在 check → 0 行なら silent success」の同型):
//   - applyTagCategoryDelete(lib/tags/apply-tag-mutation.ts)
//   - applyTagOptionDelete(同 file)
//   - applyCardDelete(lib/cards/apply-card-mutation.ts。戻り値は void)
// 契約 = 「対象行が存在するが他 user 所有」のとき success 形で返り('applied' / void
// resolve)、行は削除されず、tombstone も挿入されない。この契約が壊れる(存在 check
// から owner 述語が落ちる / client 供給 owner を信用し始める)と越境削除が可能になる。
//
// 刺激はなぜ owner 接続(RLS bypass)か: asTenant(RLS on)だと policy USING が
// B 行を A から不可視化するため、app 層 owner 述語を外す変異が RLS に mask され
// red 不成立(= pin が変異を検出できない)。RLS 単独防御は rls-single-defense.test.ts
// が別途 pin 済。本 file は app 層述語**単独**の保証を pin する(二重防御の app 側)。
//
// red の担い手は「tombstone 不挿入」assertion: 存在 check の owner 述語だけを外すと
// 他 user 行が「発見」され tombstone INSERT(呼出側 userId + 他 user の entityId)まで
// 進むが、DELETE 自体は独立の owner 述語で 0 行 → 行残存 assertion は fail しない。
// tombstone assertion があって初めて存在 check の変異が検出される。
//
// mutating test ゆえ beforeEach で truncate→seed(write-isolation.test.ts と同方針)。
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { cards, tagCategories, tagOptions, tombstones } from '@/lib/db/schema'
import { applyCardDelete } from '@/lib/cards/apply-card-mutation'
import {
  applyTagCategoryDelete,
  applyTagOptionDelete,
} from '@/lib/tags/apply-tag-mutation'

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

// 観測 helper: entityId の tombstone 行(userId 付き)。unique index は
// (entity_type, entity_id) で id は全 fixture random UUID のため entityId 単独で一意。
function tombstonesFor(entityId: string) {
  return getFixtureOwnerDb()
    .select({ userId: tombstones.userId, entityType: tombstones.entityType })
    .from(tombstones)
    .where(eq(tombstones.entityId, entityId))
}

describe('owner-mismatch delete silent no-op (app 層 owner 述語単独)', () => {
  let fixture: TenantFixture

  beforeEach(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  describe('applyTagCategoryDelete', () => {
    it('deletes tenant A own category + cascades child option, with tombstones (positive control)', async () => {
      // positive control: owner 接続の刺激配線がこの経路で実削除できることを示す
      // (negative の vacuous 回避)。
      const result = await applyTagCategoryDelete(
        getFixtureOwnerDb(),
        fixture.a.userId,
        fixture.a.tagCategoryId,
      )
      expect(result).toBe('applied')

      const catRows = await getFixtureOwnerDb()
        .select({ id: tagCategories.id })
        .from(tagCategories)
        .where(eq(tagCategories.id, fixture.a.tagCategoryId))
      expect(catRows).toHaveLength(0)

      // FK CASCADE で配下 option も消える + 双方 tombstone(mirror 削除反映の不変条件)。
      const optRows = await getFixtureOwnerDb()
        .select({ id: tagOptions.id })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.a.tagOptionId))
      expect(optRows).toHaveLength(0)

      const catTomb = await tombstonesFor(fixture.a.tagCategoryId)
      expect(catTomb).toHaveLength(1)
      expect(catTomb[0]).toMatchObject({
        userId: fixture.a.userId,
        entityType: 'tag_category',
      })
      const optTomb = await tombstonesFor(fixture.a.tagOptionId)
      expect(optTomb).toHaveLength(1)
      expect(optTomb[0]?.userId).toBe(fixture.a.userId)
    })

    it('B category via A userId → silent no-op: applied + B 行残存 + tombstone 不挿入 (negative)', async () => {
      const result = await applyTagCategoryDelete(
        getFixtureOwnerDb(),
        fixture.a.userId,
        fixture.b.tagCategoryId,
      )
      // 契約 1: success 形(silent success — 'failed' にしない)
      expect(result).toBe('applied')

      // 契約 2: B の category / 配下 option は残る
      const catRows = await getFixtureOwnerDb()
        .select({ name: tagCategories.name })
        .from(tagCategories)
        .where(eq(tagCategories.id, fixture.b.tagCategoryId))
      expect(catRows).toHaveLength(1)
      expect(catRows[0]?.name).toBe('Cat B')
      const optRows = await getFixtureOwnerDb()
        .select({ id: tagOptions.id })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.b.tagOptionId))
      expect(optRows).toHaveLength(1)

      // 契約 3: tombstone 不挿入。red の担い手は category 自身の assertion(1 行目)
      // のみ — 存在 check の owner 述語が落ちる変異はここで fail する(header 参照)。
      // 配下 option 側(2 行目)は defense-in-depth: 単一変異下では step 2 の配下
      // option 列挙(apply-tag-mutation.ts の childOptions select)が自前の owner
      // 述語を保つため変異前後とも 0 件(= 非判別)。step 2 の述語まで同時に失われた
      // 場合に初めて検出を担う。
      expect(await tombstonesFor(fixture.b.tagCategoryId)).toHaveLength(0)
      expect(await tombstonesFor(fixture.b.tagOptionId)).toHaveLength(0)
    })
  })

  describe('applyTagOptionDelete', () => {
    it('deletes tenant A own option with tombstone (positive control)', async () => {
      const result = await applyTagOptionDelete(
        getFixtureOwnerDb(),
        fixture.a.userId,
        fixture.a.tagOptionId,
      )
      expect(result).toBe('applied')

      const optRows = await getFixtureOwnerDb()
        .select({ id: tagOptions.id })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.a.tagOptionId))
      expect(optRows).toHaveLength(0)

      const tomb = await tombstonesFor(fixture.a.tagOptionId)
      expect(tomb).toHaveLength(1)
      expect(tomb[0]).toMatchObject({
        userId: fixture.a.userId,
        entityType: 'tag_option',
      })
    })

    it('B option via A userId → silent no-op: applied + B 行残存 + tombstone 不挿入 (negative)', async () => {
      const result = await applyTagOptionDelete(
        getFixtureOwnerDb(),
        fixture.a.userId,
        fixture.b.tagOptionId,
      )
      expect(result).toBe('applied')

      const optRows = await getFixtureOwnerDb()
        .select({ name: tagOptions.name })
        .from(tagOptions)
        .where(eq(tagOptions.id, fixture.b.tagOptionId))
      expect(optRows).toHaveLength(1)
      expect(optRows[0]?.name).toBe('Option')

      expect(await tombstonesFor(fixture.b.tagOptionId)).toHaveLength(0)
    })
  })

  describe('applyCardDelete', () => {
    it('deletes tenant A own card with tombstone (positive control)', async () => {
      // 引数順は (tx, cardId, userId) — tag 2 経路の (tx, userId, id) と逆。
      const result = await applyCardDelete(
        getFixtureOwnerDb(),
        fixture.a.cardId,
        fixture.a.userId,
      )
      expect(result).toBeUndefined()

      const cardRows = await getFixtureOwnerDb()
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.id, fixture.a.cardId))
      expect(cardRows).toHaveLength(0)

      const tomb = await tombstonesFor(fixture.a.cardId)
      expect(tomb).toHaveLength(1)
      expect(tomb[0]).toMatchObject({
        userId: fixture.a.userId,
        entityType: 'card',
      })
    })

    it('B card via A userId → silent no-op: void resolve + B 行残存 + tombstone 不挿入 (negative)', async () => {
      // 契約 1: success 形 = clean void resolve(throw も 'failed' 相当も無い)
      const result = await applyCardDelete(
        getFixtureOwnerDb(),
        fixture.b.cardId,
        fixture.a.userId,
      )
      expect(result).toBeUndefined()

      // 契約 2: B の card は残る
      const cardRows = await getFixtureOwnerDb()
        .select({ title: cards.title })
        .from(cards)
        .where(eq(cards.id, fixture.b.cardId))
      expect(cardRows).toHaveLength(1)
      expect(cardRows[0]?.title).toBe('Card B')

      // 契約 3: tombstone 不挿入(存在 check の owner 述語変異の検出点)
      expect(await tombstonesFor(fixture.b.cardId)).toHaveLength(0)
    })
  })
})
