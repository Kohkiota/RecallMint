// apply-tag-mutation — tag_categories / tag_options の create / update_field / delete を
// per-mutation tx 内で適用する server-only module。
// entity-mutation-registry の dispatch から呼ばれる。
//
// 設計方針:
// - create / update_field は冪等性を ON CONFLICT DO NOTHING (id) + 事前 SELECT で担保。
// - delete は tombstone INSERT → 物理 DELETE の 2 段で、 不在 / 他 user は silent success
//   (card delete と同じ idempotent 挙動)。 子テーブル (tag_options / card_tags) は
//   FK CASCADE で連動消滅。 ただし client mirror から子 tag_option を個別に消すために、
//   category 削除時は配下 option も tombstone INSERT する。
// - UNIQUE(category_id, name) 制約違反は事前 SELECT で「同 category 内同名」 を弾き、
//   per-mutation 'failed' を返す (merge ロジックは Tag-1 では未実装、 Tag-3/4 で別途検討)。
// - owner-scope (user_id) は全 statement で必須 (CLAUDE.md ルール)。

import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import {
  tagCategories,
  tagOptions,
  tombstones,
} from '@/lib/db/schema'
import type { ApplyResult } from '@/lib/sync/server/entity-mutation-registry'

// ---------------------------------------------------------------------------
// tag_category
// ---------------------------------------------------------------------------

export type TagCategoryCreatePatch = {
  name: string
  select_type: 'single' | 'multi'
  color?: string | null
  sort_key?: string | null
}

export async function applyTagCategoryCreate(
  tx: DbExecutor,
  userId: string,
  categoryId: string,
  patch: TagCategoryCreatePatch,
): Promise<ApplyResult> {
  // 冪等: 同 id の再送は ON CONFLICT DO NOTHING で no-op (created=false でも 'applied' 扱い、
  // card_mutations.create と同方針)。 ここで UNIQUE 違反は起こらない (PK のみ)。
  await tx
    .insert(tagCategories)
    .values({
      id: categoryId,
      userId,
      name: patch.name,
      selectType: patch.select_type,
      color: patch.color ?? null,
      sortKey: patch.sort_key ?? null,
    })
    .onConflictDoNothing()
  return 'applied'
}

// update_field の対象 field allowlist。 select_type は immutable (UI 担保)。
export type TagCategoryUpdateFieldName = 'name' | 'color' | 'sort_key'

export type TagCategoryUpdatePatch = {
  field: TagCategoryUpdateFieldName
  value: unknown
}

export async function applyTagCategoryUpdate(
  tx: DbExecutor,
  userId: string,
  categoryId: string,
  patch: TagCategoryUpdatePatch,
): Promise<ApplyResult> {
  const set: Record<string, unknown> = {}
  switch (patch.field) {
    case 'name': {
      if (typeof patch.value !== 'string' || patch.value.length === 0) {
        return 'failed'
      }
      set.name = patch.value
      break
    }
    case 'color': {
      if (patch.value !== null && typeof patch.value !== 'string') {
        return 'failed'
      }
      set.color = patch.value
      break
    }
    case 'sort_key': {
      if (patch.value !== null && typeof patch.value !== 'string') {
        return 'failed'
      }
      set.sortKey = patch.value
      break
    }
  }
  const result = await tx
    .update(tagCategories)
    .set(set)
    .where(and(eq(tagCategories.id, categoryId), eq(tagCategories.userId, userId)))
    .returning({ id: tagCategories.id })
  if (result.length === 0) {
    // orphan / owner mismatch → 0 row
    return 'failed'
  }
  return 'applied'
}

export async function applyTagCategoryDelete(
  tx: DbExecutor,
  userId: string,
  categoryId: string,
): Promise<ApplyResult> {
  // 1. category 存在 + owner check (不在 / 他 user → silent success)
  const found = await tx
    .select({ id: tagCategories.id })
    .from(tagCategories)
    .where(and(eq(tagCategories.id, categoryId), eq(tagCategories.userId, userId)))
  if (found.length === 0) return 'applied'

  // 2. 配下 option の id を全件取得 (client mirror から個別削除するため tombstone INSERT)
  const childOptions = await tx
    .select({ id: tagOptions.id })
    .from(tagOptions)
    .where(and(eq(tagOptions.categoryId, categoryId), eq(tagOptions.userId, userId)))

  // 3. tombstone INSERT (category 自身 + 配下 option 全件)。 ON CONFLICT DO NOTHING で
  //    並走 race / 再送に安全。
  await tx
    .insert(tombstones)
    .values({
      userId,
      entityType: 'tag_category',
      entityId: categoryId,
      deletedAt: sql`now()`,
    })
    .onConflictDoNothing()

  if (childOptions.length > 0) {
    await tx
      .insert(tombstones)
      .values(
        childOptions.map((o) => ({
          userId,
          entityType: 'tag_option' as const,
          entityId: o.id,
          deletedAt: sql`now()`,
        })),
      )
      .onConflictDoNothing()
  }

  // 4. tag_categories DELETE — FK CASCADE で tag_options / card_tags も連動消滅
  await tx
    .delete(tagCategories)
    .where(and(eq(tagCategories.id, categoryId), eq(tagCategories.userId, userId)))

  return 'applied'
}

// ---------------------------------------------------------------------------
// tag_option
// ---------------------------------------------------------------------------

export type TagOptionCreatePatch = {
  category_id: string
  name: string
  color?: string | null
  sort_key?: string | null
}

export async function applyTagOptionCreate(
  tx: DbExecutor,
  userId: string,
  optionId: string,
  patch: TagOptionCreatePatch,
): Promise<ApplyResult> {
  // 1. 親 category の owner-scope check (不在 / 他 user → 'failed')
  const parent = await tx
    .select({ id: tagCategories.id })
    .from(tagCategories)
    .where(
      and(eq(tagCategories.id, patch.category_id), eq(tagCategories.userId, userId)),
    )
  if (parent.length === 0) return 'failed'

  // 2. UNIQUE (category_id, name) の事前チェック (merge ロジック未実装、 衝突は failed)
  const dup = await tx
    .select({ id: tagOptions.id })
    .from(tagOptions)
    .where(and(eq(tagOptions.categoryId, patch.category_id), eq(tagOptions.name, patch.name)))
  if (dup.length > 0) return 'failed'

  // 3. INSERT — id 衝突 (再送) は ON CONFLICT DO NOTHING で no-op
  await tx
    .insert(tagOptions)
    .values({
      id: optionId,
      userId,
      categoryId: patch.category_id,
      name: patch.name,
      color: patch.color ?? null,
      sortKey: patch.sort_key ?? null,
    })
    .onConflictDoNothing()
  return 'applied'
}

// update_field の対象 field allowlist。 category_id はカテゴリ間移動を許容
// (移動先同名 merge は未実装、 UNIQUE 違反は事前 SELECT で 'failed')。
export type TagOptionUpdateFieldName = 'name' | 'color' | 'sort_key' | 'category_id'

export type TagOptionUpdatePatch = {
  field: TagOptionUpdateFieldName
  value: unknown
}

export async function applyTagOptionUpdate(
  tx: DbExecutor,
  userId: string,
  optionId: string,
  patch: TagOptionUpdatePatch,
): Promise<ApplyResult> {
  const set: Record<string, unknown> = {}

  switch (patch.field) {
    case 'name': {
      if (typeof patch.value !== 'string' || patch.value.length === 0) {
        return 'failed'
      }
      // UNIQUE (category_id, name) を事前 SELECT で確認 (自分自身の category 内に
      // 同名が他 id で存在しないか)。
      const current = await tx
        .select({ categoryId: tagOptions.categoryId })
        .from(tagOptions)
        .where(and(eq(tagOptions.id, optionId), eq(tagOptions.userId, userId)))
      if (current.length === 0) return 'failed'
      const dup = await tx
        .select({ id: tagOptions.id })
        .from(tagOptions)
        .where(
          and(
            eq(tagOptions.categoryId, current[0]!.categoryId),
            eq(tagOptions.name, patch.value),
          ),
        )
      // dup に自分自身が含まれる場合は no-op (rename to same name) として許容
      if (dup.length > 0 && dup.some((d) => d.id !== optionId)) return 'failed'
      set.name = patch.value
      break
    }
    case 'color': {
      if (patch.value !== null && typeof patch.value !== 'string') {
        return 'failed'
      }
      set.color = patch.value
      break
    }
    case 'sort_key': {
      if (patch.value !== null && typeof patch.value !== 'string') {
        return 'failed'
      }
      set.sortKey = patch.value
      break
    }
    case 'category_id': {
      if (typeof patch.value !== 'string' || patch.value.length === 0) {
        return 'failed'
      }
      // 移動先 category の owner check
      const parent = await tx
        .select({ id: tagCategories.id })
        .from(tagCategories)
        .where(and(eq(tagCategories.id, patch.value), eq(tagCategories.userId, userId)))
      if (parent.length === 0) return 'failed'
      // 自分自身の name を取得し、 移動先 category に同名 option が無いか確認
      const current = await tx
        .select({ name: tagOptions.name })
        .from(tagOptions)
        .where(and(eq(tagOptions.id, optionId), eq(tagOptions.userId, userId)))
      if (current.length === 0) return 'failed'
      const dup = await tx
        .select({ id: tagOptions.id })
        .from(tagOptions)
        .where(
          and(
            eq(tagOptions.categoryId, patch.value),
            eq(tagOptions.name, current[0]!.name),
          ),
        )
      if (dup.length > 0 && dup.some((d) => d.id !== optionId)) return 'failed'
      set.categoryId = patch.value
      break
    }
  }
  const result = await tx
    .update(tagOptions)
    .set(set)
    .where(and(eq(tagOptions.id, optionId), eq(tagOptions.userId, userId)))
    .returning({ id: tagOptions.id })
  if (result.length === 0) {
    return 'failed'
  }
  return 'applied'
}

export async function applyTagOptionDelete(
  tx: DbExecutor,
  userId: string,
  optionId: string,
): Promise<ApplyResult> {
  // 1. option 存在 + owner check (不在 / 他 user → silent success)
  const found = await tx
    .select({ id: tagOptions.id })
    .from(tagOptions)
    .where(and(eq(tagOptions.id, optionId), eq(tagOptions.userId, userId)))
  if (found.length === 0) return 'applied'

  // 2. tombstone INSERT — mirror 削除反映 (pull.ts 参照)
  await tx
    .insert(tombstones)
    .values({
      userId,
      entityType: 'tag_option',
      entityId: optionId,
      deletedAt: sql`now()`,
    })
    .onConflictDoNothing()

  // 3. tag_options DELETE — FK CASCADE で card_tags も連動消滅
  await tx
    .delete(tagOptions)
    .where(and(eq(tagOptions.id, optionId), eq(tagOptions.userId, userId)))

  return 'applied'
}
