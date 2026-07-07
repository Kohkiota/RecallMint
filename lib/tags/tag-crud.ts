// tag-crud: タグ CRUD の application-service (use-case) module。
// カテゴリ / option の rename・color・delete・create・影響集計を集約する。
// Dexie mirror (getClientDb) / outbox (enqueueEntityMutation) / flush に触れる副作用ありの
// use-case 層であり、 lib/tags の pure builder (build-next-tag-set / next-sort-key 等) とは層が異なる。
// buildNewOption は pure builder だが、 createOption / handleCreateOptionAndAssign と密結合のため
// 本 module に同居する。
//
// Client-only: depends on `getClientDb()` (Dexie / IndexedDB)、 client component から import される
// 前提。 RSC からの import は `getClientDb` が server で throw する設計に依存して防御
// (`@/lib/tags/reorder-handlers` 等の既存 client-only helper と同 convention、 `'use client'`
// directive は使わず banner で示す)。 P3 Task1 で card-tags-section.tsx から byte-equivalent 移転。

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import { enqueueEntityMutation, type EnqueueEntityMutationInput } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { runOptimisticUpdate } from '@/lib/sync/optimistic-mutation'
import { nextSortKey } from '@/lib/tags/next-sort-key'

// ---------------------------------------------------------------------------
// Tag-4c-1: rename / color / delete handlers + count helpers
//
// これらは module スコープの純粋関数として定義 (React state への closure なし)。
// getClientDb() は module-level singleton を返すため、 component lifecycle と独立。
// テスト容易性のため export する (buildNextTagSet と同じ規約)。
//
// Atomic strategy:
// - rename / color: `runOptimisticUpdate` (helper) で mirror update + enqueue を 1 rw tx に
//   閉じ込め、 失敗時 Dexie auto-rollback (Sync-fix-1 T2a)。
// - delete: multi-store。 db.transaction('rw', ...) で same-tx atomic
// ---------------------------------------------------------------------------

/**
 * カテゴリ名を変更する。 同名は no-op、 全ユーザースコープで同名衝突なら throw。
 * 失敗時 Dexie auto-rollback via runOptimisticUpdate (throwOnError: true で caller UI に伝播)。
 */
export async function handleRenameCategory(categoryId: string, newName: string): Promise<void> {
  const db = getClientDb()
  const before = await db.tag_categories.get(categoryId)
  if (!before) return
  if (before.name === newName) return // no-op
  // 同名衝突 check (自分自身を除外した全 category を検索)
  const all = await db.tag_categories.toArray()
  if (all.some((c) => c.id !== categoryId && c.name === newName)) {
    throw new Error('同名のカテゴリが既にあります')
  }
  await runOptimisticUpdate({
    store: db.tag_categories,
    rowKey: categoryId,
    beforeValue: { name: before.name, updated_at: before.updated_at },
    afterPatch: { name: newName, updated_at: new Date().toISOString() },
    mutation: {
      entity_type: 'tag_category',
      entity_id: categoryId,
      op: 'update_field',
      patch: { field: 'name', value: newName },
    },
    logEvent: 'tag_category_rename.tx_failed',
    logContext: { id: categoryId },
    isNoop: (b, a) => b.name === a.name,
    throwOnError: true,
  })
}

/**
 * カテゴリ color を設定する (null でクリア)。 null → null は no-op。
 * 失敗時 Dexie auto-rollback via runOptimisticUpdate (throwOnError: true で caller UI に伝播)。
 */
export async function handleSetCategoryColor(categoryId: string, color: string | null): Promise<void> {
  const db = getClientDb()
  const before = await db.tag_categories.get(categoryId)
  if (!before) return
  // before.color ?? null で undefined → null 正規化 (空文字 / undefined に化けない比較)
  const beforeColor = before.color ?? null
  if (beforeColor === color) return // no-op
  await runOptimisticUpdate({
    store: db.tag_categories,
    rowKey: categoryId,
    beforeValue: { color: beforeColor, updated_at: before.updated_at },
    afterPatch: { color, updated_at: new Date().toISOString() },
    mutation: {
      entity_type: 'tag_category',
      entity_id: categoryId,
      op: 'update_field',
      patch: { field: 'color', value: color },
    },
    logEvent: 'tag_category_color.tx_failed',
    logContext: { id: categoryId },
    isNoop: (b, a) => b.color === a.color,
    throwOnError: true,
  })
}

/**
 * オプション名を変更する。 同名は no-op、 同 category 内同名衝突なら throw。
 * 失敗時 Dexie auto-rollback via runOptimisticUpdate (throwOnError: true で caller UI に伝播)。
 */
export async function handleRenameOption(optionId: string, newName: string): Promise<void> {
  const db = getClientDb()
  const before = await db.tag_options.get(optionId)
  if (!before) return
  if (before.name === newName) return // no-op
  // 同 category 内で同名衝突 check (自分自身を除外)
  const sameCat = await db.tag_options.where('category_id').equals(before.category_id).toArray()
  if (sameCat.some((o) => o.id !== optionId && o.name === newName)) {
    throw new Error('同名の option が既にあります')
  }
  await runOptimisticUpdate({
    store: db.tag_options,
    rowKey: optionId,
    beforeValue: { name: before.name, updated_at: before.updated_at },
    afterPatch: { name: newName, updated_at: new Date().toISOString() },
    mutation: {
      entity_type: 'tag_option',
      entity_id: optionId,
      op: 'update_field',
      patch: { field: 'name', value: newName },
    },
    logEvent: 'tag_option_rename.tx_failed',
    logContext: { id: optionId },
    isNoop: (b, a) => b.name === a.name,
    throwOnError: true,
  })
}

/**
 * オプション color を設定する (null でクリア)。 null → null は no-op。
 * 失敗時 Dexie auto-rollback via runOptimisticUpdate (throwOnError: true で caller UI に伝播)。
 */
export async function handleSetOptionColor(optionId: string, color: string | null): Promise<void> {
  const db = getClientDb()
  const before = await db.tag_options.get(optionId)
  if (!before) return
  // before.color ?? null で undefined → null 正規化 (空文字 / undefined に化けない比較)
  const beforeColor = before.color ?? null
  if (beforeColor === color) return // no-op
  await runOptimisticUpdate({
    store: db.tag_options,
    rowKey: optionId,
    beforeValue: { color: beforeColor, updated_at: before.updated_at },
    afterPatch: { color, updated_at: new Date().toISOString() },
    mutation: {
      entity_type: 'tag_option',
      entity_id: optionId,
      op: 'update_field',
      patch: { field: 'color', value: color },
    },
    logEvent: 'tag_option_color.tx_failed',
    logContext: { id: optionId },
    isNoop: (b, a) => b.color === a.color,
    throwOnError: true,
  })
}

/**
 * カテゴリを削除する。
 * same-tx atomic: 配下 option の card_tags → tag_options → tag_categories → enqueue を
 * 同一 Dexie tx に収め、 途中失敗で全 store が rollback される。
 */
export async function handleDeleteCategory(categoryId: string): Promise<void> {
  const db = getClientDb()
  await db.transaction(
    'rw',
    db.card_tags,
    db.tag_options,
    db.tag_categories,
    db.entity_mutations,
    async () => {
      const options = await db.tag_options.where('category_id').equals(categoryId).toArray()
      const optionIds = options.map((o) => o.id)
      if (optionIds.length > 0) {
        await db.card_tags.where('option_id').anyOf(optionIds).delete()
      }
      await db.tag_options.where('category_id').equals(categoryId).delete()
      await db.tag_categories.delete(categoryId)
      await enqueueEntityMutation({
        entity_type: 'tag_category',
        entity_id: categoryId,
        op: 'delete',
        patch: {},
      })
    },
  )
  void runGuardedEntityMutationFlush().catch(() => {})
}

/**
 * オプションを削除する。
 * same-tx atomic: card_tags → tag_options → enqueue を同一 Dexie tx に収める。
 */
export async function handleDeleteOption(optionId: string): Promise<void> {
  const db = getClientDb()
  await db.transaction(
    'rw',
    db.card_tags,
    db.tag_options,
    db.entity_mutations,
    async () => {
      await db.card_tags.where('option_id').equals(optionId).delete()
      await db.tag_options.delete(optionId)
      await enqueueEntityMutation({
        entity_type: 'tag_option',
        entity_id: optionId,
        op: 'delete',
        patch: {},
      })
    },
  )
  void runGuardedEntityMutationFlush().catch(() => {})
}

// ---------------------------------------------------------------------------
// Count helpers (Tag-4c-1)
// ---------------------------------------------------------------------------

/**
 * カテゴリを削除した場合の影響 card 数 / option 数を返す。
 * 削除確認 UI での表示に使う (IDB read-only、 副作用なし)。
 *
 * Fix A-4: cardCount は distinct card_id の数 (Set を使う)。
 * 1 card が同カテゴリ内の複数 option を持つ場合でも 1 として数える。
 */
export async function countCategoryImpact(
  categoryId: string,
): Promise<{ optionCount: number; cardCount: number }> {
  const db = getClientDb()
  const options = await db.tag_options.where('category_id').equals(categoryId).toArray()
  const cardIds = new Set<string>()
  for (const opt of options) {
    const tags = await db.card_tags.where('option_id').equals(opt.id).toArray()
    for (const t of tags) cardIds.add(t.card_id)
  }
  return { optionCount: options.length, cardCount: cardIds.size }
}

/**
 * オプションを削除した場合の影響 card 数を返す。
 */
export async function countOptionImpact(
  optionId: string,
): Promise<{ cardCount: number }> {
  const db = getClientDb()
  return { cardCount: await db.card_tags.where('option_id').equals(optionId).count() }
}

// ---------------------------------------------------------------------------
// Create handlers (Tag-4c-2a)
//
// 既存の rename / color / delete handler が module スコープに集約されているのと同じ規約で、
// create 系も明示的に props (userId / cardId / 当該 scope の categories / options / cardTags)
// を受け取る module スコープ関数として export する。 component 内では useCallback で
// closure 化し、 useMemo の dep に乗せて tagEditCallbacks identity を制御する。
//
// テスト容易性: deps を引数で受けることで getClientDb / enqueue mock 経由でユニットテスト可能。
// ---------------------------------------------------------------------------

/**
 * カテゴリを新規作成する。
 * mirror put (tag_categories) + enqueue (entity_mutations) を 2 store rw tx に閉じ、
 * 失敗時 Dexie auto-rollback。 userId 空文字なら early return + console.error。
 * sort_key は同 user scope の category 全体で max+1 (text 列、 string で書込)。
 * color は null 固定 (作成時 UI なし、 Tag-4c-1 popover で後付け編集可能)。
 *
 * @returns 採番した id (popover 側で次 stage 遷移用)
 * @throws userId 空文字時 / 内部 enqueue 失敗時 (Dexie auto-rollback 済)
 */
export async function handleCreateCategory(
  userId: string,
  existingCategories: ClientTagCategory[],
  name: string,
  selectType: 'single' | 'multi',
): Promise<{ id: string }> {
  if (!userId) {
    console.error('[Tag-4c-2a] empty user_id, aborting handleCreateCategory')
    throw new Error('empty user_id')
  }
  const db = getClientDb()
  const id = crypto.randomUUID()
  const sortKey = nextSortKey(existingCategories.map((c) => c.sort_key))
  const nowIso = new Date().toISOString()

  await db.transaction(
    'rw',
    db.tag_categories,
    db.entity_mutations,
    async () => {
      await db.tag_categories.put({
        id,
        user_id: userId,
        name,
        select_type: selectType,
        color: null,
        sort_key: sortKey,
        created_at: nowIso,
        updated_at: nowIso,
      })
      await enqueueEntityMutation({
        entity_type: 'tag_category',
        entity_id: id,
        op: 'create',
        patch: { name, select_type: selectType, sort_key: sortKey },
      })
    },
  )

  void runGuardedEntityMutationFlush().catch(() => {})
  return { id }
}

// ---------------------------------------------------------------------------
// buildNewOption: pure builder (no Dexie / no side effects)
// Fix-1: bulk タグ付与で新規 option 作成 payload を共有するために抽出。
// カテゴリ絞り込みの注意: sortKey は categoryId と一致する option のみから採番する
// (他カテゴリの sort_key を巻き込むと同カテゴリ内連番が壊れる)。
// ---------------------------------------------------------------------------

export function buildNewOption(
  userId: string,
  existingOptions: ClientTagOption[],
  categoryId: string,
  name: string,
): { newOptionId: string; optionRow: ClientTagOption; enqueueInput: EnqueueEntityMutationInput } {
  if (!userId) throw new Error('empty user_id')
  const newOptionId = crypto.randomUUID()
  const sortKey = nextSortKey(
    existingOptions.filter((o) => o.category_id === categoryId).map((o) => o.sort_key),
  )
  const nowIso = new Date().toISOString()
  const optionRow: ClientTagOption = {
    id: newOptionId,
    user_id: userId,
    category_id: categoryId,
    name,
    color: null,
    sort_key: sortKey,
    created_at: nowIso,
    updated_at: nowIso,
  }
  const enqueueInput: EnqueueEntityMutationInput = {
    entity_type: 'tag_option',
    entity_id: newOptionId,
    op: 'create',
    patch: { category_id: categoryId, name, color: null, sort_key: sortKey },
  }
  return { newOptionId, optionRow, enqueueInput }
}

/**
 * bulk 用: option を新規作成する (card への付与は行わない)。
 * 自前の rw tx (tag_options + entity_mutations) に閉じる。
 * userId 空文字なら console.error + throw (fail-fast)。
 * 呼び出し元が別 tx で card_tags を扱う場合は buildNewOption を直接使うこと
 * (この関数は tx 分裂を起こすため handleCreateOptionAndAssign 内では使わない)。
 */
export async function createOption(
  userId: string,
  existingOptions: ClientTagOption[],
  categoryId: string,
  name: string,
): Promise<string> {
  if (!userId) {
    console.error('[Fix-1] empty user_id, aborting createOption')
    throw new Error('empty user_id')
  }
  const db = getClientDb()
  const { newOptionId, optionRow, enqueueInput } = buildNewOption(userId, existingOptions, categoryId, name)
  await db.transaction(
    'rw',
    db.tag_options,
    db.entity_mutations,
    async () => {
      await db.tag_options.put(optionRow)
      await enqueueEntityMutation(enqueueInput)
    },
  )
  void runGuardedEntityMutationFlush().catch(() => {})
  return newOptionId
}

/**
 * option を新規作成し、 当該 card に即時付与する。
 * mirror put (tag_options) + card_tags whole-set 差分書込 + enqueue 2 連発を
 * 3 store rw tx に閉じる。 失敗時 Dexie auto-rollback。
 *
 * select_type='single' の場合、 同カテゴリ既存付与 option を toRemove に積み
 * whole-set 不変条件を満たす (buildNextTagSet 相当の logic を inline 展開)。
 * select_type='multi' の場合、 新 option を toAdd のみ。
 *
 * userId 空文字なら early return + console.error (副作用なし)。
 * category 不在なら silent no-op。
 */
export async function handleCreateOptionAndAssign(
  userId: string,
  cardId: string,
  existingCategories: ClientTagCategory[],
  existingOptions: ClientTagOption[],
  existingCardTags: ClientCardTag[],
  categoryId: string,
  name: string,
): Promise<void> {
  if (!userId) {
    console.error('[Tag-4c-2a] empty user_id, aborting handleCreateOptionAndAssign')
    return
  }
  const category = existingCategories.find((c) => c.id === categoryId)
  if (!category) return

  const db = getClientDb()
  // payload 構築は pure builder に委譲 (tx 境界・card_tags 差分は本関数が保持)
  const { newOptionId, optionRow, enqueueInput } = buildNewOption(userId, existingOptions, categoryId, name)
  // タイムスタンプの一貫性: card_tags.created_at は optionRow と同一 ISO 文字列を再利用
  const nowIso = optionRow.created_at

  // whole-set 差分構築:
  // - multi: 新 option を toAdd のみ
  // - single: 新 option を toAdd、 同カテゴリ既存付与の option を toRemove
  const oldAssigned = existingCardTags.map((t) => t.option_id)
  const oldSet = new Set(oldAssigned)
  const newSet = new Set(oldAssigned)
  const toRemove: string[] = []
  if (category.select_type === 'single') {
    const sameCatOptionIds = new Set(
      existingOptions.filter((o) => o.category_id === categoryId).map((o) => o.id),
    )
    for (const id of sameCatOptionIds) {
      if (oldSet.has(id)) {
        newSet.delete(id)
        toRemove.push(id)
      }
    }
  }
  newSet.add(newOptionId)
  const next = [...newSet]

  await db.transaction(
    'rw',
    db.tag_options,
    db.card_tags,
    db.entity_mutations,
    async () => {
      // 1) tag_options mirror put
      await db.tag_options.put(optionRow)
      // 2) card_tags 差分書込 (single 時のみ toRemove あり)
      for (const id of toRemove) {
        await db.card_tags.delete([cardId, id])
      }
      await db.card_tags.put({
        card_id: cardId,
        option_id: newOptionId,
        user_id: userId,
        created_at: nowIso,
      })
      // 3) enqueue 2 連発: tag_option create + card update_field
      await enqueueEntityMutation(enqueueInput)
      await enqueueEntityMutation({
        entity_type: 'card',
        entity_id: cardId,
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: next },
      })
    },
  )

  void runGuardedEntityMutationFlush().catch(() => {})
}

// ---------------------------------------------------------------------------
// tagEditCallbacks 型 (Task 3/4 で popover に渡す single props object)
// ---------------------------------------------------------------------------

export type TagEditCallbacks = {
  renameCategory: (categoryId: string, newName: string) => Promise<void>
  setCategoryColor: (categoryId: string, color: string | null) => Promise<void>
  deleteCategory: (categoryId: string) => Promise<void>
  renameOption: (optionId: string, newName: string) => Promise<void>
  setOptionColor: (optionId: string, color: string | null) => Promise<void>
  deleteOption: (optionId: string) => Promise<void>
  countCategoryImpact: (categoryId: string) => Promise<{ optionCount: number; cardCount: number }>
  countOptionImpact: (optionId: string) => Promise<{ cardCount: number }>
  // Tag-4c-2a: popover からの「カテゴリ新規作成」「option 新規作成 + 即時付与」 経路。
  // 実装は module スコープ `handleCreateCategory` / `handleCreateOptionAndAssign` に集約、
  // section 内では props (userId / cardId / 当該 scope の集合) を bind した useCallback
  // closure を tagEditCallbacks に乗せる。 popover からは UI 視点の引数 (name, selectType /
  // categoryId, name) のみで呼び出せる。
  createCategory: (
    name: string,
    selectType: 'single' | 'multi',
  ) => Promise<{ id: string }>
  createOptionAndAssign: (categoryId: string, name: string) => Promise<void>
  // Tag-4c-2b T7 M-C: popover stage1 / stage2 D&D 経路は CardTagAddPopover の standalone
  // props (`onReorderCategories` / `onReorderOptions`) 1 経路に集約。 旧 T6 で本型に乗せて
  // いた `reorderCategories` / `reorderOptions` は二重経路の一方が dead だったため drop。
  // section 内 useCallback closure は popover の standalone props として直接渡す。
}
