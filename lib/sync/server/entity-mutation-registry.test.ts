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
