// lib/sync/shared/mutation-schemas.ts — entity mutation envelope の patch zod 群と
// discriminated union envelope schema を集約する共有 module。 server-only **不付**:
// `lib/validation/card.ts` / `lib/validation/tag.ts` の precedent と同じく、 server
// (entity-mutation-registry / bulk endpoint) + client (ClientEntityMutation /
// EnqueueEntityMutationInput) + test (envelope reject) の 3 sink から共有される。
//
// 設計判断:
// - 10 patch schema (card / tag_category / tag_option × create / update_field / delete
//   + card_move.move) を 1 module に集約することで、 server registry と client outbox の
//   wire 契約を single source of truth に固定する (drift 防止 = audit #13 解消)。
// - envelope は `z.discriminatedUnion('entity_type', [...])` で entity_type を gate、
//   その内側で `z.discriminatedUnion('op', [...])` で op を gate する 2 段構造。
//   apply dispatch (registry) と outbox row (Dexie) の両方で「entity_type→op→patch」
//   の組合せのみが型として valid と narrow される。
// - `entity_id` は z.string() (bulk endpoint envelope は z.uuid() で別途 gate しており、
//   apply-dispatch 視点の envelope は patch 型 narrowing が主目的のため緩めて十分)。
// - mutation_id / edited_at は本 envelope に含めない: 前者は outbox row / bulk payload の
//   metadata、 後者は outbox row の coalesce 用 timestamp。 いずれも apply 視点の domain
//   payload ではないため、 EnqueueEntityMutationInput / ClientEntityMutation 側で
//   intersection で乗せる。

import { z } from 'zod'
import {
  titleSchema,
  questionLabelSchema,
  questionTextSchema,
  explanationTextSchema,
  memoSchema,
  optionsSchema,
} from '@/lib/validation/card'
import {
  tagNameSchema,
  tagColorSchema,
  tagSortKeySchema,
  tagCategoryIdSchema,
} from '@/lib/validation/tag'

// ---------------------------------------------------------------------------
// card entity — patch zod
// ---------------------------------------------------------------------------

// update_field の patch envelope: { field: string, value: unknown }
//
// field allowlist は CARD_FIELD_HANDLERS (card-field-handlers.ts) の map key で
// 自然に決まる。 ここで enum 固定すると新 field 追加時に 2 箇所書換になるため、
// envelope は `field: z.string().min(1)` まで緩和し、 未知 field は dispatch 段
// (`if (!handler) return 'failed'`) で per-mutation failed として弾く。
// 値の内容検証は各 handler 内に閉じる (drift 防止)。
export const cardUpdateFieldPatchSchema = z.object({
  field: z.string().min(1),
  value: z.unknown(),
})

// create の patch: client が optimistic に組んだ card 内容。
// correct_answer_ids は含めない (server が options.is_correct から再生成)。
export const cardCreatePatchSchema = z.object({
  exam_id: z.uuid(),
  title: titleSchema,
  question_label: questionLabelSchema,
  // 全 INSERT 経路が明示供給する契約 (spec §3.1)。欠落は per-mutation failed。
  base_order: z.number().int().min(1),
  question_text: questionTextSchema,
  options: optionsSchema,
  explanation_text: explanationTextSchema,
  memo: memoSchema,
})

// delete の patch: 不要 (空 object 許容)
export const cardDeletePatchSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// tag_category entity — patch zod
// ---------------------------------------------------------------------------

// update_field の patch: { field: 'name' | 'color' | 'sort_key', value }
// select_type は immutable のため allowlist 外。
export const tagCategoryUpdateFieldPatchSchema = z.object({
  field: z.enum(['name', 'color', 'sort_key']),
  value: z.unknown(),
})

// create の patch: client が optimistic に組んだ category 内容。
// 値検証は `lib/validation/tag.ts` の共有 field schema 経由 (apply 側 update 経路と
// 同 source、 drift 防止 = audit #10 解消)。 select_type は immutable のため inline。
export const tagCategoryCreatePatchSchema = z.object({
  name: tagNameSchema,
  select_type: z.enum(['single', 'multi']),
  color: tagColorSchema.optional(),
  sort_key: tagSortKeySchema.optional(),
})

export const tagCategoryDeletePatchSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// tag_option entity — patch zod
// ---------------------------------------------------------------------------

// update_field の patch: { field: 'name' | 'color' | 'sort_key' | 'category_id', value }
// category_id 移動は許容、 UNIQUE(category_id, name) 違反は apply 側で per-mutation failed。
export const tagOptionUpdateFieldPatchSchema = z.object({
  field: z.enum(['name', 'color', 'sort_key', 'category_id']),
  value: z.unknown(),
})

export const tagOptionCreatePatchSchema = z.object({
  category_id: tagCategoryIdSchema,
  name: tagNameSchema,
  color: tagColorSchema.optional(),
  sort_key: tagSortKeySchema.optional(),
})

export const tagOptionDeletePatchSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// card_move entity — patch zod (Grid-3 spec §2.1)
// ---------------------------------------------------------------------------

// move の patch: 「card id → (exam_id, base_order) の絶対値割当」の集合。
// exam_id は全 card 共通の移動先、 cards は client が計算済みの割当列で、 server は
// 順序を計算せずこれをそのまま適用する (spec §2.2)。
//
// 上限 10,000 は「1000 枚級 move + 数千枚 exam の再採番」を包含する DoS ガード。
// **card id の重複だけを拒否する** — 同一 card に 2 つの割当があると適用結果が
// 入力順依存になるため。 逆に **base_order 値の重複は許容** する (Order-1 §2.1 の
// 重複容認と同型: undo が元値へ戻すとき元値自体が重複していることがある)。
export const cardMovePatchSchema = z
  .object({
    exam_id: z.uuid(),
    cards: z
      .array(z.object({ id: z.uuid(), base_order: z.number().int().min(1) }))
      .min(1)
      .max(10_000),
  })
  .refine(
    (patch) => new Set(patch.cards.map((c) => c.id)).size === patch.cards.length,
    { message: 'duplicate card id in patch.cards' },
  )

export type CardMovePatch = z.infer<typeof cardMovePatchSchema>

// ---------------------------------------------------------------------------
// envelope discriminated union
// ---------------------------------------------------------------------------
//
// entity_type → op の 2 段 discriminated union: apply dispatch / outbox row 両側で
// patch 型を narrowing する。 entity_id は z.string() (bulk endpoint 側で z.uuid()
// gate 済、 ここは patch 型 narrowing が主目的のため緩め)。

const cardMutationEnvelope = z.discriminatedUnion('op', [
  z.object({
    entity_type: z.literal('card'),
    op: z.literal('create'),
    entity_id: z.string(),
    patch: cardCreatePatchSchema,
  }),
  z.object({
    entity_type: z.literal('card'),
    op: z.literal('update_field'),
    entity_id: z.string(),
    patch: cardUpdateFieldPatchSchema,
  }),
  z.object({
    entity_type: z.literal('card'),
    op: z.literal('delete'),
    entity_id: z.string(),
    patch: cardDeletePatchSchema,
  }),
])

const tagCategoryMutationEnvelope = z.discriminatedUnion('op', [
  z.object({
    entity_type: z.literal('tag_category'),
    op: z.literal('create'),
    entity_id: z.string(),
    patch: tagCategoryCreatePatchSchema,
  }),
  z.object({
    entity_type: z.literal('tag_category'),
    op: z.literal('update_field'),
    entity_id: z.string(),
    patch: tagCategoryUpdateFieldPatchSchema,
  }),
  z.object({
    entity_type: z.literal('tag_category'),
    op: z.literal('delete'),
    entity_id: z.string(),
    patch: tagCategoryDeletePatchSchema,
  }),
])

const tagOptionMutationEnvelope = z.discriminatedUnion('op', [
  z.object({
    entity_type: z.literal('tag_option'),
    op: z.literal('create'),
    entity_id: z.string(),
    patch: tagOptionCreatePatchSchema,
  }),
  z.object({
    entity_type: z.literal('tag_option'),
    op: z.literal('update_field'),
    entity_id: z.string(),
    patch: tagOptionUpdateFieldPatchSchema,
  }),
  z.object({
    entity_type: z.literal('tag_option'),
    op: z.literal('delete'),
    entity_id: z.string(),
    patch: tagOptionDeletePatchSchema,
  }),
])

// card_move は op が `move` 1 つだけなので内側 union を挟まない (単一 op の
// discriminatedUnion は entity_type 側の narrowing と同義で、 層が 1 つ無駄になる)。
// entity_id は他 entity と違い対象 entity の PK ではなく **移動操作 instance の uuid**
// (schema.ts の entity_mutations comment / spec §2.1)。
const cardMoveMutationEnvelope = z.object({
  entity_type: z.literal('card_move'),
  op: z.literal('move'),
  entity_id: z.string(),
  patch: cardMovePatchSchema,
})

export const entityMutationEnvelopeSchema = z.discriminatedUnion('entity_type', [
  cardMutationEnvelope,
  tagCategoryMutationEnvelope,
  tagOptionMutationEnvelope,
  cardMoveMutationEnvelope,
])

export type EntityMutationEnvelope = z.infer<typeof entityMutationEnvelopeSchema>
