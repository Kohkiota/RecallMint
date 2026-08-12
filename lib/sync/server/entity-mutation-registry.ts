// entity-mutation-registry — server 側 mutation-driven push の dispatch table。
//
// 役割:
// - bulk endpoint (POST /api/entity-mutations/bulk) は envelope を受け取り、
//   per-mutation の (entity_type, op) ペアで本 registry を引いて apply 関数を呼ぶ。
// - patch 検証 (zod) も entity_type × op ごとに本 registry に集約する
//   (drift 防止: bulk endpoint の switch ではなく 1 ファイルで定義を完結)。
// - 現在 entity_type='card' / 'tag_category' / 'tag_option' を登録。
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
//
// T5: schema 部 (patch zod 9 件) は `lib/sync/shared/mutation-schemas.ts` に移管 (server-only
// 不付 = client / test と共有)。 本 file は apply dispatch に絞り、 `server-only` を付ける
// (apply 関数 chain が drizzle / DB を import するため client bundle 不可)。
// `RegistryEntry<TEnvelope>` を generic 化することで apply 関数の `patch` を envelope union
// から narrow し、 旧 `patch as z.infer<...>` cast を構造的に排除する。

import 'server-only'
import { z } from 'zod'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import {
  applyCardDelete,
  applyCardCreateWithId,
} from '@/lib/cards/apply-card-mutation'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'
import {
  applyTagCategoryCreate,
  applyTagCategoryUpdate,
  applyTagCategoryDelete,
  applyTagOptionCreate,
  applyTagOptionUpdate,
  applyTagOptionDelete,
} from '@/lib/tags/apply-tag-mutation'
import {
  cardCreatePatchSchema,
  cardUpdateFieldPatchSchema,
  cardDeletePatchSchema,
  tagCategoryCreatePatchSchema,
  tagCategoryUpdateFieldPatchSchema,
  tagCategoryDeletePatchSchema,
  tagOptionCreatePatchSchema,
  tagOptionUpdateFieldPatchSchema,
  tagOptionDeletePatchSchema,
} from '@/lib/sync/shared/mutation-schemas'

// ---------------------------------------------------------------------------
// 共通型
// ---------------------------------------------------------------------------

export type ApplyResult = 'applied' | 'failed' | 'skipped'

/**
 * registry が公開する apply 関数の統一 signature (generic 版)。
 *
 * `TPatch` は 各 entry の patch zod から `z.infer<>` で派生する。 registry 表側
 * (`ENTITY_MUTATION_REGISTRY`) は op ごとに entry を定義するので、 個別 entry の
 * apply は narrow された patch 型を受け取れる (旧 `patch as z.infer<...>` cast 排除)。
 */
export type EntityApplyFn<TPatch> = (
  tx: DbExecutor,
  userId: string,
  entityId: string,
  patch: TPatch,
) => Promise<ApplyResult>

/**
 * registry エントリ (generic)。 patch zod と apply 関数の patch 型を `TSchema` で連動。
 *
 * - 個別 entry 定義時は `TSchema` を具体的な zod schema 型にすることで apply 関数の
 *   `patch` を narrow 型で受けられる (旧 `patch as z.infer<...>` cast 排除)。
 * - 表 (`ENTITY_MUTATION_REGISTRY`) と `lookupRegistryEntry` の戻り型は `RegistryEntry`
 *   (= `TSchema=z.ZodTypeAny` の既定 generic、 apply は `unknown` 受け) として扱う。
 *   bulk endpoint は `patch.safeParse` → 成功時 `patchParsed.data` (型は unknown) を
 *   apply に渡す経路のため、 caller 側は `unknown` で支障なく動く。
 *
 * skipLog=true の op は entity_mutations への log INSERT を skip する
 * (delete のように audit 行を残さない設計)。
 *
 * cascadeLike=true の op は per-mutation tx 並列化対象から外す (Y-2 T-B3 #1b、 案 X)。
 * 強 cascade (= 配下 entity を巻き込む delete) と cross-entity 書込 (= 対象 entity 以外の
 * table にも書く) を持つ op が該当し、 group helper 段で 1 件でも検出されたら bulk 全体を
 * serial fallback に倒す (= 並列化の新規リスクを「非 cascade のみ」に閉じ込める)。
 * step 0 doc §1.2 / §4.2 で 4 件確定 (Sprint B (DB 全体掃除) T5 で card.create の根拠は
 * 消滅・card.delete の根拠は card_count 言及を除いて自立、 各 entry 側 comment 参照):
 *   - `card.create` (根拠だった `exams.card_count += 1` は Sprint B で消滅。 flag 撤去は
 *     bulk 並列化の挙動変更 = scope 外のため並列化再検証まで保守的に維持、 spec §1.10-2)
 *   - `card.delete` (tombstone INSERT + cards DELETE の cross-entity 書込)
 *   - `tag_category.delete` (配下 tag_options 巻き込み + FK CASCADE)
 *   - `tag_option.delete` (FK CASCADE で card_tags 巻き込み)
 * 残り 5 op (`card.update_field` / `tag_category.create|update_field` /
 * `tag_option.create|update_field`) は本人 entity 内 self-contained のため flag を
 * 立てない (= undefined = false 同等)。 新 op 追加時の flag 立て忘れは
 * `entity-mutation-registry.test.ts` の 9 件 enumerate assert で gate する。
 */
export type RegistryEntry<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  patch: TSchema
  apply: EntityApplyFn<z.infer<TSchema>>
  skipLog?: boolean
  cascadeLike?: boolean
}

/**
 * 個別 entry を narrow 型で組み、 表登録時は `RegistryEntry` (apply: unknown 受け) に
 * 縮約する helper。 narrow 型のまま `Record<string, RegistryEntry>` に突っ込むと
 * `EntityApplyFn` の contravariance で代入不可になるため、 ここで widen する。
 *
 * runtime には影響なし — safeParse 通過後の `patchParsed.data` を unknown のまま渡し、
 * apply 関数内で narrow patch として扱える (entry 定義時に schema と apply の型が
 * `TSchema` で連動済のため、 cast は entry 内側でなく widen helper に閉じる)。
 */
function defineEntry<TSchema extends z.ZodTypeAny>(
  entry: RegistryEntry<TSchema>,
): RegistryEntry {
  return entry as unknown as RegistryEntry
}

// ---------------------------------------------------------------------------
// 共通 helper
// ---------------------------------------------------------------------------

// card-field-handlers の text 列正規化と同じ: '' → null。
// client が '' を送ると create と update で挙動が乖離するため揃える。
const emptyToNull = (v: string | null | undefined): string | null =>
  v === '' ? null : (v ?? null)

// ---------------------------------------------------------------------------
// card entity — apply 関数 (既存 applyCardX への薄い adapter)
// ---------------------------------------------------------------------------

const applyCardUpdateField: EntityApplyFn<
  z.infer<typeof cardUpdateFieldPatchSchema>
> = async (tx, userId, entityId, patch) => {
  // envelope zod 通過後の field/value。 envelope は `field: z.string().min(1)` まで
  // 緩和してあり、 未知 field はここで dispatch lookup 失敗 → 'failed' で弾く
  // (旧 enum 早期 reject の代替 gate)。
  const { field, value } = patch
  const handler = (CARD_FIELD_HANDLERS as Record<string, typeof CARD_FIELD_HANDLERS.title | undefined>)[field]
  if (!handler) {
    return 'failed'
  }
  // 値検証 (zod) + 正規化 + cards owner-scoped UPDATE は handler に閉じ込め。
  // 戻り値 'applied' | 'failed' をそのまま registry へ流す。
  return await handler(tx, entityId, userId, value)
}

const applyCardCreate: EntityApplyFn<
  z.infer<typeof cardCreatePatchSchema>
> = async (tx, userId, entityId, patch) => {
  // options: camelCase (zod) → snake_case (CardOption)
  const cardOptions = patch.options.map((o) => ({
    id: o.id,
    uid: o.uid, // Sprint I W5: 画像 identity(cardCreatePatchSchema で uid 必須)を透過。
    text: o.text,
    is_correct: o.isCorrect,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }))
  const createResult = await applyCardCreateWithId(tx, userId, {
    cardId: entityId,
    examId: patch.exam_id,
    title: patch.title,
    sortKey: emptyToNull(patch.sort_key),
    questionText: patch.question_text,
    options: cardOptions,
    explanationText: emptyToNull(patch.explanation_text),
    memo: emptyToNull(patch.memo),
  })
  if (createResult.examNotFound) {
    return 'failed'
  }
  // ON CONFLICT skip でも created=false で返るが、 card 行は存在しているため
  // log INSERT (mutation_id UNIQUE + onConflictDoNothing) に進める。
  return 'applied'
}

const applyCardDeleteFn: EntityApplyFn<
  z.infer<typeof cardDeletePatchSchema>
> = async (tx, userId, entityId, _patch) => {
  // applyCardDelete は card 不在 / owner mismatch でも silent success (idempotent)。
  // 戻り値は void、 success 扱いで 'applied' を返す。 log INSERT は registry 側で skip。
  await applyCardDelete(tx, entityId, userId)
  return 'applied'
}

// ---------------------------------------------------------------------------
// tag_category entity — apply 関数 (apply-tag-mutation への薄い adapter)
// ---------------------------------------------------------------------------

const applyTagCategoryUpdateFn: EntityApplyFn<
  z.infer<typeof tagCategoryUpdateFieldPatchSchema>
> = async (tx, userId, entityId, patch) => {
  return await applyTagCategoryUpdate(tx, userId, entityId, patch)
}

const applyTagCategoryCreateFn: EntityApplyFn<
  z.infer<typeof tagCategoryCreatePatchSchema>
> = async (tx, userId, entityId, patch) => {
  return await applyTagCategoryCreate(tx, userId, entityId, {
    name: patch.name,
    select_type: patch.select_type,
    color: patch.color ?? null,
    sort_key: patch.sort_key ?? null,
  })
}

const applyTagCategoryDeleteFn: EntityApplyFn<
  z.infer<typeof tagCategoryDeletePatchSchema>
> = async (tx, userId, entityId, _patch) => {
  return await applyTagCategoryDelete(tx, userId, entityId)
}

// ---------------------------------------------------------------------------
// tag_option entity — apply 関数
// ---------------------------------------------------------------------------

const applyTagOptionUpdateFn: EntityApplyFn<
  z.infer<typeof tagOptionUpdateFieldPatchSchema>
> = async (tx, userId, entityId, patch) => {
  return await applyTagOptionUpdate(tx, userId, entityId, patch)
}

const applyTagOptionCreateFn: EntityApplyFn<
  z.infer<typeof tagOptionCreatePatchSchema>
> = async (tx, userId, entityId, patch) => {
  return await applyTagOptionCreate(tx, userId, entityId, {
    category_id: patch.category_id,
    name: patch.name,
    color: patch.color ?? null,
    sort_key: patch.sort_key ?? null,
  })
}

const applyTagOptionDeleteFn: EntityApplyFn<
  z.infer<typeof tagOptionDeletePatchSchema>
> = async (tx, userId, entityId, _patch) => {
  return await applyTagOptionDelete(tx, userId, entityId)
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

/**
 * (entity_type, op) → registry entry の dispatch table。
 *
 * 表側の値は具体的な entry 型を持つが、 caller (`lookupRegistryEntry` 経由) からは
 * `RegistryEntry` (= TSchema=ZodTypeAny の既定 generic、 patch.safeParse → apply の
 * 統一経路) として扱う。 個別 entry の apply は patch を narrow 型で受けるため、
 * 内側で `patch as z.infer<...>` cast を不要にできる。
 */
export const ENTITY_MUTATION_REGISTRY: Record<
  string,
  Record<string, RegistryEntry | undefined> | undefined
> = {
  card: {
    update_field: defineEntry({
      patch: cardUpdateFieldPatchSchema,
      apply: applyCardUpdateField,
    }),
    create: defineEntry({
      patch: cardCreatePatchSchema,
      apply: applyCardCreate,
      // 根拠だった cross-entity read-modify-write (`exams.card_count += 1`) は
      // Sprint B (DB 全体掃除) T5 の bump 撤去で消滅した。 flag 撤去はバルク並列化の
      // 挙動変更であり本 sprint の scope 外のため、 再検証するまで保守的に維持する
      // (spec §1.10-2)。
      cascadeLike: true,
    }),
    delete: defineEntry({
      patch: cardDeletePatchSchema,
      apply: applyCardDeleteFn,
      // delete op は entity_mutations に log INSERT しない。
      // 理由: 監査 log としての価値が低く、 再送 dedupe は tombstone + 自然冪等で
      // 担保するため (audit log として記録不要)。 従来 card 経路の挙動を維持する。
      skipLog: true,
      // tombstone INSERT + cards DELETE の cross-entity 書込を伴うため並列化対象外
      // (§1.2 表)。
      cascadeLike: true,
    }),
  },
  tag_category: {
    update_field: defineEntry({
      patch: tagCategoryUpdateFieldPatchSchema,
      apply: applyTagCategoryUpdateFn,
    }),
    create: defineEntry({
      patch: tagCategoryCreatePatchSchema,
      apply: applyTagCategoryCreateFn,
    }),
    delete: defineEntry({
      patch: tagCategoryDeletePatchSchema,
      apply: applyTagCategoryDeleteFn,
      // card と同方針: tombstone + idempotent apply で audit 不要、 log skip
      skipLog: true,
      // 配下 tag_options 全件 SELECT → tombstones bulk INSERT → FK CASCADE で
      // tag_options / card_tags を巻き込むため、 並列化対象外 (§1.2 表)。
      cascadeLike: true,
    }),
  },
  tag_option: {
    update_field: defineEntry({
      patch: tagOptionUpdateFieldPatchSchema,
      apply: applyTagOptionUpdateFn,
    }),
    create: defineEntry({
      patch: tagOptionCreatePatchSchema,
      apply: applyTagOptionCreateFn,
    }),
    delete: defineEntry({
      patch: tagOptionDeletePatchSchema,
      apply: applyTagOptionDeleteFn,
      skipLog: true,
      // tombstone INSERT + tag_options DELETE → FK CASCADE で card_tags を巻き込む
      // ため、 並列化対象外 (§1.2 表)。
      cascadeLike: true,
    }),
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
