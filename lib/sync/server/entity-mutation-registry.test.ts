// entity-mutation-registry envelope schema の reject case を pin する test。
//
// T5: server registry の patch zod 群と envelope schema は `lib/sync/shared/mutation-schemas.ts`
// に集約。 本 test は envelope の `z.discriminatedUnion` 設定 (entity_type 不正 / op 不正)
// が `safeParse` で fail することを構造的に保証する (registry / outbox / bulk 受領経路に
// 未知 entity_type / op が紛れ込むことを最上流で拒否)。
//
// runtime behavior は不変 — schema 単体の validity check のみで、 DB / Dexie には触れない。

import { describe, it, expect } from 'vitest'
import { entityMutationEnvelopeSchema } from '@/lib/sync/shared/mutation-schemas'
import { lookupRegistryEntry } from '@/lib/sync/server/entity-mutation-registry'

describe('entityMutationEnvelopeSchema — envelope reject', () => {
  it('envelope reject: untrusted entity_type → safeParse failure', () => {
    // 'unknown_entity' は entity_type discriminated union の literal 集合外。
    const result = entityMutationEnvelopeSchema.safeParse({
      entity_type: 'unknown_entity',
      op: 'create',
      entity_id: 'abc',
      patch: {},
    })
    expect(result.success).toBe(false)
  })

  it('envelope reject: untrusted op → safeParse failure', () => {
    // 'unknown_op' は card 内側 envelope の op discriminated union literal 集合外。
    const result = entityMutationEnvelopeSchema.safeParse({
      entity_type: 'card',
      op: 'unknown_op',
      entity_id: 'abc',
      patch: {},
    })
    expect(result.success).toBe(false)
  })
})

// Y-2 T-B3 #1b: cascadeLike flag を 9 件すべて enumerate して assert する。
// step 0 doc §1.2 / §4.2 確定の 4 件 (= `card.create` / `card.delete` /
// `tag_category.delete` / `tag_option.delete`) のみ true、 残り 5 件は undefined
// (= false 同等)。 1 件でも漏れたら test 失敗 = 新 op 追加時に flag 立て忘れを
// 物理的に検出する gate。
describe('ENTITY_MUTATION_REGISTRY — cascadeLike flag (Y-2 T-B3 #1b)', () => {
  const expected: Record<string, Record<string, boolean>> = {
    card: { create: true, update_field: false, delete: true },
    tag_category: { create: false, update_field: false, delete: true },
    tag_option: { create: false, update_field: false, delete: true },
  }

  for (const [entityType, ops] of Object.entries(expected)) {
    for (const [op, cascadeLike] of Object.entries(ops)) {
      it(`${entityType}.${op} → cascadeLike=${cascadeLike}`, () => {
        const entry = lookupRegistryEntry(entityType, op)
        expect(entry).toBeDefined()
        // undefined と false を同一視 (= flag 立てていない = false 同等)
        expect(entry!.cascadeLike === true).toBe(cascadeLike)
      })
    }
  }
})
