// entity-mutation-registry — server 側 mutation-driven push の dispatch table。
//
// 役割:
// - bulk endpoint (POST /api/entity-mutations/bulk) は envelope を受け取り、
//   per-mutation の (entity_type, op) ペアで本 registry を引いて apply 関数を呼ぶ。
// - patch 検証 (zod) も entity_type × op ごとに本 registry に集約する
//   (drift 防止: bulk endpoint の switch ではなく 1 ファイルで定義を完結)。
// - 現在登録されているのは entity_type='card' のみ。 タグマスター等は後続 sprint で
//   `tag_category` / `tag_option` entry を追加するだけで bulk endpoint は無修正。
//
// 設計判断:
// - delete op は log INSERT を skip する (entity_mutations への audit 行を残さない)。
//   理由: delete mutation は tombstone + apply 関数の自然冪等 (対象不在 → silent
//   no-op) で再送安全性を担保しており、 監査 log としての価値が低い (mutation_id
//   ベースの再送 dedupe には INSERT が要らない)。 card 経路の従来挙動も同じ。
// - update_field / create は apply 後に log INSERT (mutation_id UNIQUE + onConflictDoNothing
//   が並走 race の backstop)。
// - 各 apply 関数の戻り値は ApplyResult 統一型に正規化 ('applied' | 'failed' | 'skipped')。
// - patch zod は per-op に分け、 invalid patch は **per-mutation failed** (bulk 全体を
//   400 で reject しない)。

import { z } from 'zod'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import {
  applyCardDelete,
  applyCardCreateWithId,
} from '@/lib/cards/apply-card-mutation'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'
import { optionSchema } from '@/lib/validation/card'
import {
  tagNameSchema,
  tagColorSchema,
  tagSortKeySchema,
  tagCategoryIdSchema,
} from '@/lib/validation/tag'
import {
  applyTagCategoryCreate,
  applyTagCategoryUpdate,
  applyTagCategoryDelete,
  applyTagOptionCreate,
  applyTagOptionUpdate,
  applyTagOptionDelete,
} from '@/lib/tags/apply-tag-mutation'

// ---------------------------------------------------------------------------
// 共通型
// ---------------------------------------------------------------------------

export type ApplyResult = 'applied' | 'failed' | 'skipped'

/**
 * registry が公開する apply 関数の統一 signature。
 * - tx: per-mutation tx executor
 * - userId: owner-scope 用
 * - entityId: 対象 entity の PK (uuid)
 * - patch: per-op zod で validate 済の payload
 *
 * 戻り値:
 * - 'applied' = 正常適用 (log INSERT 対象)
 * - 'failed'  = patch 後の DB 失敗 (orphan / owner mismatch 等)
 * - 'skipped' = 冪等 skip (registry 内で完結する場合のみ。 mutation_id 既存 skip は
 *               bulk endpoint 側で済ませるためここでは原則使わない)
 */
export type EntityApplyFn = (
  tx: DbExecutor,
  userId: string,
  entityId: string,
  patch: unknown,
) => Promise<ApplyResult>

/**
 * registry エントリ。 op ごとに zod patch schema + apply 関数 + log INSERT 要否を持つ。
 *
 * skipLog=true の op は entity_mutations への log INSERT を skip する
 * (delete のように audit 行を残さない設計)。
 */
export type RegistryEntry = {
  patch: z.ZodTypeAny
  apply: EntityApplyFn
  skipLog?: boolean
}

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
const cardUpdateFieldPatchSchema = z.object({
  field: z.string().min(1),
  value: z.unknown(),
})

// create の patch: client が optimistic に組んだ card 内容。
// correct_answer_ids は含めない (server が options.is_correct から再生成)。
const cardCreatePatchSchema = z.object({
  exam_id: z.uuid(),
  title: z
    .string()
    .trim()
    .min(1, 'タイトルは必須です')
    .max(200, 'タイトルは 200 文字以内で入力してください'),
  sort_key: z.string().max(100, 'ソートキーは 100 文字以内で入力してください').nullable(),
  question_text: z
    .string()
    .max(10000, '問題文は 10000 文字以内で入力してください')
    .refine((s) => s.trim().length > 0, { message: '問題文は必須です' }),
  options: z
    .array(optionSchema)
    .min(1, '選択肢は最低 1 個必要です')
    .max(50, '選択肢は最大 50 個までです')
    .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, {
      message: '選択肢の id が重複しています',
    }),
  explanation_text: z
    .string()
    .max(10000, '解説は 10000 文字以内で入力してください')
    .nullable(),
  memo: z.string().max(10000, 'メモは 10000 文字以内で入力してください').nullable(),
})

// delete の patch: 不要 (空 object 許容)
const cardDeletePatchSchema = z.record(z.string(), z.unknown())

// card-field-handlers の text 列正規化と同じ: '' → null。
// client が '' を送ると create と update で挙動が乖離するため揃える。
const emptyToNull = (v: string | null | undefined): string | null =>
  v === '' ? null : (v ?? null)

// ---------------------------------------------------------------------------
// card entity — apply 関数 (既存 applyCardX への薄い adapter)
// ---------------------------------------------------------------------------

const applyCardUpdateField: EntityApplyFn = async (tx, userId, entityId, patch) => {
  // envelope zod 通過後の field/value。 envelope は `field: z.string().min(1)` まで
  // 緩和してあり、 未知 field はここで dispatch lookup 失敗 → 'failed' で弾く
  // (旧 enum 早期 reject の代替 gate)。
  const { field, value } = patch as { field: string; value: unknown }
  const handler = (CARD_FIELD_HANDLERS as Record<string, typeof CARD_FIELD_HANDLERS.title | undefined>)[field]
  if (!handler) {
    return 'failed'
  }
  // 値検証 (zod) + 正規化 + cards owner-scoped UPDATE は handler に閉じ込め。
  // 戻り値 'applied' | 'failed' をそのまま registry へ流す。
  return await handler(tx, entityId, userId, value)
}

const applyCardCreate: EntityApplyFn = async (tx, userId, entityId, patch) => {
  const p = patch as z.infer<typeof cardCreatePatchSchema>
  // options: camelCase (zod) → snake_case (CardOption)
  const cardOptions = p.options.map((o) => ({
    id: o.id,
    text: o.text,
    is_correct: o.isCorrect,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }))
  const createResult = await applyCardCreateWithId(tx, userId, {
    cardId: entityId,
    examId: p.exam_id,
    title: p.title,
    sortKey: emptyToNull(p.sort_key),
    questionText: p.question_text,
    options: cardOptions,
    explanationText: emptyToNull(p.explanation_text),
    memo: emptyToNull(p.memo),
  })
  if (createResult.examNotFound) {
    return 'failed'
  }
  // ON CONFLICT skip でも created=false で返るが、 card 行は存在しているため
  // log INSERT (mutation_id UNIQUE + onConflictDoNothing) に進める。
  return 'applied'
}

const applyCardDeleteFn: EntityApplyFn = async (tx, userId, entityId, _patch) => {
  // applyCardDelete は card 不在 / owner mismatch でも silent success (idempotent)。
  // 戻り値は void、 success 扱いで 'applied' を返す。 log INSERT は registry 側で skip。
  await applyCardDelete(tx, entityId, userId)
  return 'applied'
}

// ---------------------------------------------------------------------------
// tag_category entity — patch zod
// ---------------------------------------------------------------------------

// update_field の patch: { field: 'name' | 'color' | 'sort_key', value }
// select_type は immutable のため allowlist 外。
const tagCategoryUpdateFieldPatchSchema = z.object({
  field: z.enum(['name', 'color', 'sort_key']),
  value: z.unknown(),
})

// create の patch: client が optimistic に組んだ category 内容。
// 値検証は `lib/validation/tag.ts` の共有 field schema 経由 (apply 側 update 経路と
// 同 source、 drift 防止 = audit #10 解消)。 select_type は immutable のため inline。
const tagCategoryCreatePatchSchema = z.object({
  name: tagNameSchema,
  select_type: z.enum(['single', 'multi']),
  color: tagColorSchema.optional(),
  sort_key: tagSortKeySchema.optional(),
})

const tagCategoryDeletePatchSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// tag_category entity — apply 関数 (apply-tag-mutation への薄い adapter)
// ---------------------------------------------------------------------------

const applyTagCategoryUpdateFn: EntityApplyFn = async (tx, userId, entityId, patch) => {
  const { field, value } = patch as { field: 'name' | 'color' | 'sort_key'; value: unknown }
  return await applyTagCategoryUpdate(tx, userId, entityId, { field, value })
}

const applyTagCategoryCreateFn: EntityApplyFn = async (tx, userId, entityId, patch) => {
  const p = patch as z.infer<typeof tagCategoryCreatePatchSchema>
  return await applyTagCategoryCreate(tx, userId, entityId, {
    name: p.name,
    select_type: p.select_type,
    color: p.color ?? null,
    sort_key: p.sort_key ?? null,
  })
}

const applyTagCategoryDeleteFn: EntityApplyFn = async (tx, userId, entityId, _patch) => {
  return await applyTagCategoryDelete(tx, userId, entityId)
}

// ---------------------------------------------------------------------------
// tag_option entity — patch zod
// ---------------------------------------------------------------------------

// update_field の patch: { field: 'name' | 'color' | 'sort_key' | 'category_id', value }
// category_id 移動は許容、 UNIQUE(category_id, name) 違反は apply 側で per-mutation failed。
const tagOptionUpdateFieldPatchSchema = z.object({
  field: z.enum(['name', 'color', 'sort_key', 'category_id']),
  value: z.unknown(),
})

const tagOptionCreatePatchSchema = z.object({
  category_id: tagCategoryIdSchema,
  name: tagNameSchema,
  color: tagColorSchema.optional(),
  sort_key: tagSortKeySchema.optional(),
})

const tagOptionDeletePatchSchema = z.record(z.string(), z.unknown())

// ---------------------------------------------------------------------------
// tag_option entity — apply 関数
// ---------------------------------------------------------------------------

const applyTagOptionUpdateFn: EntityApplyFn = async (tx, userId, entityId, patch) => {
  const { field, value } = patch as {
    field: 'name' | 'color' | 'sort_key' | 'category_id'
    value: unknown
  }
  return await applyTagOptionUpdate(tx, userId, entityId, { field, value })
}

const applyTagOptionCreateFn: EntityApplyFn = async (tx, userId, entityId, patch) => {
  const p = patch as z.infer<typeof tagOptionCreatePatchSchema>
  return await applyTagOptionCreate(tx, userId, entityId, {
    category_id: p.category_id,
    name: p.name,
    color: p.color ?? null,
    sort_key: p.sort_key ?? null,
  })
}

const applyTagOptionDeleteFn: EntityApplyFn = async (tx, userId, entityId, _patch) => {
  return await applyTagOptionDelete(tx, userId, entityId)
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

/**
 * (entity_type, op) → registry entry の dispatch table。
 *
 * Tag-1 で tag_category / tag_option を追加。 bulk endpoint 側は無修正で、 ここに entry を
 * 追加するだけで client → server の双方向同期 (push: outbox → bulk → registry、
 * pull: tag_categories / tag_options stream) が成立する。
 */
export const ENTITY_MUTATION_REGISTRY: Record<
  string,
  Record<string, RegistryEntry | undefined> | undefined
> = {
  card: {
    update_field: {
      patch: cardUpdateFieldPatchSchema,
      apply: applyCardUpdateField,
    },
    create: {
      patch: cardCreatePatchSchema,
      apply: applyCardCreate,
    },
    delete: {
      patch: cardDeletePatchSchema,
      apply: applyCardDeleteFn,
      // delete op は entity_mutations に log INSERT しない。
      // 理由: 監査 log としての価値が低く、 再送 dedupe は tombstone + 自然冪等で
      // 担保するため (audit log として記録不要)。 従来 card 経路の挙動を維持する。
      skipLog: true,
    },
  },
  tag_category: {
    update_field: {
      patch: tagCategoryUpdateFieldPatchSchema,
      apply: applyTagCategoryUpdateFn,
    },
    create: {
      patch: tagCategoryCreatePatchSchema,
      apply: applyTagCategoryCreateFn,
    },
    delete: {
      patch: tagCategoryDeletePatchSchema,
      apply: applyTagCategoryDeleteFn,
      // card と同方針: tombstone + idempotent apply で audit 不要、 log skip
      skipLog: true,
    },
  },
  tag_option: {
    update_field: {
      patch: tagOptionUpdateFieldPatchSchema,
      apply: applyTagOptionUpdateFn,
    },
    create: {
      patch: tagOptionCreatePatchSchema,
      apply: applyTagOptionCreateFn,
    },
    delete: {
      patch: tagOptionDeletePatchSchema,
      apply: applyTagOptionDeleteFn,
      skipLog: true,
    },
  },
}

/**
 * registry 引き helper。 未知の (entity_type, op) ペアは undefined を返す
 * (呼出側で per-mutation failed として扱う)。
 */
export function lookupRegistryEntry(
  entityType: string,
  op: string,
): RegistryEntry | undefined {
  return ENTITY_MUTATION_REGISTRY[entityType]?.[op]
}
