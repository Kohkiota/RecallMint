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
import {
  ENTITY_MUTATION_REGISTRY,
  lookupRegistryEntry,
} from '@/lib/sync/server/entity-mutation-registry'

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

  // Grid-3: card_move は entity_type union の新メンバー。 outbox row / apply dispatch の
  // 両側で patch 型が narrow されることを、 accept / reject の対で確かめる。
  it('envelope accept: card_move.move + 割当列の patch', () => {
    const result = entityMutationEnvelopeSchema.safeParse({
      entity_type: 'card_move',
      op: 'move',
      entity_id: '99999999-9999-4999-a999-999999999999',
      patch: {
        exam_id: 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee',
        cards: [{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', base_order: 1024 }],
      },
    })
    expect(result.success).toBe(true)
  })

  it('envelope reject: card_move に move 以外の op → safeParse failure', () => {
    const result = entityMutationEnvelopeSchema.safeParse({
      entity_type: 'card_move',
      op: 'update_field',
      entity_id: '99999999-9999-4999-a999-999999999999',
      patch: { field: 'base_order', value: 1024 },
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

// Y-2 T-B3 #1b: cascadeLike flag を 10 件すべて enumerate して assert する。
// step 0 doc §1.2 / §4.2 確定の 4 件 (= `card.create` / `card.delete` /
// `tag_category.delete` / `tag_option.delete`) + Grid-3 の `card_move.move`
// (1 mutation が N 枚の card 行を書く) のみ true、 残り 5 件は undefined
// (= false 同等)。 1 件でも漏れたら test 失敗 = 新 op 追加時に flag 立て忘れを
// 物理的に検出する gate。
describe('ENTITY_MUTATION_REGISTRY — cascadeLike flag (Y-2 T-B3 #1b)', () => {
  const expected: Record<string, Record<string, boolean>> = {
    card: { create: true, update_field: false, delete: true },
    tag_category: { create: false, update_field: false, delete: true },
    tag_option: { create: false, update_field: false, delete: true },
    card_move: { move: true },
  }

  // 上の表は「列挙した entry の flag」しか見ない。 registry 側に op を足して表への
  // 追記を忘れると素通りするため、 集合一致をここで別建てに pin する
  // (= 新 op の enumerate 漏れ自体を落とす)。
  it('registry の (entity_type, op) 集合が expected 表と一致する (10 件)', () => {
    const flatten = (table: Record<string, Record<string, unknown> | undefined>) =>
      Object.entries(table)
        .flatMap(([entityType, ops]) =>
          Object.keys(ops ?? {}).map((op) => `${entityType}.${op}`),
        )
        .sort()

    const actual = flatten(ENTITY_MUTATION_REGISTRY)
    expect(actual).toEqual(flatten(expected))
    expect(actual).toHaveLength(10)
  })

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
