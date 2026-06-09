'use client'

// CardTagsSection: 1 card 分の「タグ」 section orchestrator。
// optimistic toggle logic を集約し、 付与済バッジ群 + 「+ タグを追加」 button を組み立てる。
//
// 設計変更点 (Tag-4b-fix):
// - 旧: categories を iterate → 全カテゴリ row を常時表示 (CardTagCategoryRow)
// - 新: cardTags を iterate → 付与済み tag のバッジのみ表示 (Notion 方式)
// - 「タグ管理 →」 link は見出し横から削除。 Tag-4c-2a Task 4 で popover footer からも撤去。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md

import { memo, useCallback, useMemo } from 'react'

import { logger } from '@/lib/logger'
import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { nextSortKey } from '@/lib/tags/next-sort-key'
import { reindexSortKeys } from '@/lib/tags/reindex-sort-keys'

import { CardTagBadge } from './card-tag-badge'
import { CardTagEditPopover } from './card-tag-edit-popover'
import { CardTagAddPopover } from './card-tag-add-popover'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  cardId: string
  // 親 InlineCardList が server (Clerk auth()) から prop で受領した owner id を
  // そのまま受け取り、 optimistic mirror put の user_id に使う。 次 pull で server 値に
  // 上書きされる前提は維持しつつ、 空文字汚染 (将来の user_id index による delete-by-user /
  // 解析経路) を避ける。
  userId: string
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  cardTags: ClientCardTag[]
}

// ---------------------------------------------------------------------------
// Pure helper: whole-set 構築ロジック (テスト容易性のため export)
// ---------------------------------------------------------------------------

/**
 * toggle 後の次の option_id セットを計算する純粋関数。
 * whole-set 不変条件 (他カテゴリ落とし回避) を保証する。
 *
 * @param category - toggle 対象カテゴリ (select_type で multi/single を判定)
 * @param allAssignedOptionIds - 本 card 全カテゴリ横断の現在の付与済み option_id 配列
 * @param sameCategoryOptionIds - 同カテゴリに属する全 option_id の集合 (Set)
 * @param clickedOptionId - toggle する option_id
 * @returns { next: 次の全付与済み option_id 配列, toAdd: 追加する id 配列, toRemove: 削除する id 配列 }
 */
export function buildNextTagSet(
  category: Pick<ClientTagCategory, 'select_type'>,
  allAssignedOptionIds: string[],
  sameCategoryOptionIds: Set<string>,
  clickedOptionId: string,
): { next: string[]; toAdd: string[]; toRemove: string[] } {
  const oldSet = new Set(allAssignedOptionIds)
  const newSet = new Set(allAssignedOptionIds)

  if (category.select_type === 'multi') {
    if (newSet.has(clickedOptionId)) newSet.delete(clickedOptionId)
    else newSet.add(clickedOptionId)
  } else {
    // single: 同カテゴリ既存 clear → 元々付いてなければ add (入れ替え) /
    // 元々付いてたら add せず 0 個に戻る
    const wasAssigned = oldSet.has(clickedOptionId)
    for (const id of sameCategoryOptionIds) newSet.delete(id)
    if (!wasAssigned) newSet.add(clickedOptionId)
  }

  const toAdd: string[] = []
  const toRemove: string[] = []
  for (const id of newSet) if (!oldSet.has(id)) toAdd.push(id)
  for (const id of oldSet) if (!newSet.has(id)) toRemove.push(id)

  return { next: [...newSet], toAdd, toRemove }
}

// ---------------------------------------------------------------------------
// Tag-4c-1: rename / color / delete handlers + count helpers
//
// これらは module スコープの純粋関数として定義 (React state への closure なし)。
// getClientDb() は module-level singleton を返すため、 component lifecycle と独立。
// テスト容易性のため export する (buildNextTagSet と同じ規約)。
//
// Atomic strategy:
// - rename / color: single-store。 mirror.update await → enqueue await → revert on throw
// - delete: multi-store。 db.transaction('rw', ...) で same-tx atomic
// ---------------------------------------------------------------------------

/**
 * カテゴリ名を変更する。
 * mirror update → enqueue の順で await、 enqueue が throw したら mirror を元値に revert。
 * 同名の場合は no-op (IDB / enqueue を触らない)。
 * 全ユーザースコープで同名の category が既に存在する場合は throw。
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
  const now = new Date().toISOString()
  try {
    await db.tag_categories.update(categoryId, { name: newName, updated_at: now })
    await enqueueEntityMutation({
      entity_type: 'tag_category',
      entity_id: categoryId,
      op: 'update_field',
      patch: { field: 'name', value: newName },
    })
  } catch (err) {
    // revert mirror を元値に戻す (updated_at も before 値で上書き)
    await db.tag_categories.update(categoryId, {
      name: before.name,
      updated_at: before.updated_at,
    }).catch((err) => { logger.warn({ event: 'tag_category_rename.revert_failed', id: categoryId, err: String(err) }) })
    throw err
  }
  void runGuardedEntityMutationFlush().catch(() => {})
}

/**
 * カテゴリ color を設定する (null でクリア)。
 * null → null は no-op。
 */
export async function handleSetCategoryColor(categoryId: string, color: string | null): Promise<void> {
  const db = getClientDb()
  const before = await db.tag_categories.get(categoryId)
  if (!before) return
  // 値が同じ (null → null, 'red' → 'red') なら no-op
  const beforeColor = before.color ?? null
  if (beforeColor === color) return
  const now = new Date().toISOString()
  try {
    await db.tag_categories.update(categoryId, { color, updated_at: now })
    await enqueueEntityMutation({
      entity_type: 'tag_category',
      entity_id: categoryId,
      op: 'update_field',
      patch: { field: 'color', value: color },
    })
  } catch (err) {
    // revert: before.color が null なら null を書き戻す (空文字に化けさせない)
    await db.tag_categories.update(categoryId, {
      color: beforeColor,
      updated_at: before.updated_at,
    }).catch((err) => { logger.warn({ event: 'tag_category_color.revert_failed', id: categoryId, err: String(err) }) })
    throw err
  }
  void runGuardedEntityMutationFlush().catch(() => {})
}

/**
 * オプション名を変更する。
 * 同名の場合は no-op。
 * 同 category 内に既存と同名の option が存在する場合は throw。
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
  const now = new Date().toISOString()
  try {
    await db.tag_options.update(optionId, { name: newName, updated_at: now })
    await enqueueEntityMutation({
      entity_type: 'tag_option',
      entity_id: optionId,
      op: 'update_field',
      patch: { field: 'name', value: newName },
    })
  } catch (err) {
    await db.tag_options.update(optionId, {
      name: before.name,
      updated_at: before.updated_at,
    }).catch((err) => { logger.warn({ event: 'tag_option_rename.revert_failed', id: optionId, err: String(err) }) })
    throw err
  }
  void runGuardedEntityMutationFlush().catch(() => {})
}

/**
 * オプション color を設定する (null でクリア)。
 * null → null は no-op。
 */
export async function handleSetOptionColor(optionId: string, color: string | null): Promise<void> {
  const db = getClientDb()
  const before = await db.tag_options.get(optionId)
  if (!before) return
  const beforeColor = before.color ?? null
  if (beforeColor === color) return // no-op
  const now = new Date().toISOString()
  try {
    await db.tag_options.update(optionId, { color, updated_at: now })
    await enqueueEntityMutation({
      entity_type: 'tag_option',
      entity_id: optionId,
      op: 'update_field',
      patch: { field: 'color', value: color },
    })
  } catch (err) {
    // revert: before.color が null なら null を書き戻す (空文字に化けさせない)
    await db.tag_options.update(optionId, {
      color: beforeColor,
      updated_at: before.updated_at,
    }).catch((err) => { logger.warn({ event: 'tag_option_color.revert_failed', id: optionId, err: String(err) }) })
    throw err
  }
  void runGuardedEntityMutationFlush().catch(() => {})
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
        patch: { name, select_type: selectType },
      })
    },
  )

  void runGuardedEntityMutationFlush().catch(() => {})
  return { id }
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
  const newOptionId = crypto.randomUUID()
  const sortKey = nextSortKey(
    existingOptions.filter((o) => o.category_id === categoryId).map((o) => o.sort_key),
  )
  const nowIso = new Date().toISOString()

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
      await db.tag_options.put({
        id: newOptionId,
        user_id: userId,
        category_id: categoryId,
        name,
        color: null,
        sort_key: sortKey,
        created_at: nowIso,
        updated_at: nowIso,
      })
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
      await enqueueEntityMutation({
        entity_type: 'tag_option',
        entity_id: newOptionId,
        op: 'create',
        patch: { category_id: categoryId, name, color: null },
      })
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
// Tag-4c-2b T6: D&D reorder handlers (module スコープ)
//
// reference 実装 = `handleToggle` の same-tx atomic pattern (mirror update + enqueue を
// 同一 Dexie rw tx に閉じ、 enqueue throw で tx 全体 throw → Dexie auto-rollback →
// handler catch で silent return、 案 a 取り直し: 次回 pull が server 値で reconcile)。
// updates.length === 0 (= 同順 drag or 既に正規化済) なら tx 自体張らず flush もしない。
// mirror update は partial `{ sort_key, updated_at }` のみ (他列触らない)、 user_id 注入は
// 不要 (sort_key 書込は user 列を触らない、 reference handleToggle の whole-set replace と
// は異なる)。
//
// component 側では useCallback で props (categories / options) を bind した closure に
// 安定化し、 tagEditCallbacks に乗せて popover に渡す。
// ---------------------------------------------------------------------------

/**
 * categories の D&D 並べ替えを反映する。
 * - 当該 list 全件の sort_key を `'0','1',…,'N-1'` で正規化 (`reindexSortKeys` 純関数)。
 * - 差分が 0 件なら tx も flush も発火しない (no-op)。
 * - 失敗時 Dexie auto-rollback、 catch silent return (案 a 取り直し)。
 */
export async function handleReorderCategories(
  existingCategories: ClientTagCategory[],
  orderedIds: string[],
): Promise<void> {
  const currentMap = new Map(existingCategories.map((c) => [c.id, c.sort_key]))
  const updates = reindexSortKeys(orderedIds, currentMap)
  if (updates.length === 0) return
  const db = getClientDb()
  const nowIso = new Date().toISOString()
  try {
    await db.transaction('rw', db.tag_categories, db.entity_mutations, async () => {
      for (const { id, sort_key } of updates) {
        await db.tag_categories.update(id, { sort_key, updated_at: nowIso })
        await enqueueEntityMutation({
          entity_type: 'tag_category',
          entity_id: id,
          op: 'update_field',
          patch: { field: 'sort_key', value: sort_key },
        })
      }
    })
  } catch {
    // Dexie tx auto-rollback 済 (mirror + outbox 共に未反映)。 案 a 取り直し経路で
    // 次回 pull が server 値で reconcile するため、 UI への明示通知は省略。
    return
  }
  // flush は tx 外で best-effort。 失敗しても outbox row は残り次回 trigger で再送される。
  void runGuardedEntityMutationFlush().catch(() => {})
}

/**
 * 指定 category 配下 options の D&D 並べ替えを反映する。
 * categoryId 配下の option のみを reindex 母数とする (別 category の option を
 * 巻き込まない不変条件)。 他は handleReorderCategories と同形。
 */
export async function handleReorderOptions(
  existingOptions: ClientTagOption[],
  categoryId: string,
  orderedIds: string[],
): Promise<void> {
  const currentMap = new Map(
    existingOptions
      .filter((o) => o.category_id === categoryId)
      .map((o) => [o.id, o.sort_key]),
  )
  const updates = reindexSortKeys(orderedIds, currentMap)
  if (updates.length === 0) return
  const db = getClientDb()
  const nowIso = new Date().toISOString()
  try {
    await db.transaction('rw', db.tag_options, db.entity_mutations, async () => {
      for (const { id, sort_key } of updates) {
        await db.tag_options.update(id, { sort_key, updated_at: nowIso })
        await enqueueEntityMutation({
          entity_type: 'tag_option',
          entity_id: id,
          op: 'update_field',
          patch: { field: 'sort_key', value: sort_key },
        })
      }
    })
  } catch {
    return
  }
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
  // Tag-4c-2b T6: popover stage1 / stage2 D&D 並べ替えの差分 reindex 経路。
  // 実装は section 内の useCallback closure として安定化し、 popover の
  // DndContext.onDragEnd → handleStageNDragEnd → 当該 callback 直接 dispatch で呼ばれる。
  reorderCategories: (orderedIds: string[]) => Promise<void>
  reorderOptions: (categoryId: string, orderedIds: string[]) => Promise<void>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function CardTagsSectionInner({
  cardId,
  userId,
  categories,
  options,
  cardTags,
}: Props) {
  // 本 card の全カテゴリ横断 option_id 配列。 handleToggle の whole-set 構築に使う。
  const allAssignedOptionIds = cardTags.map((t) => t.option_id)

  // Fix C-3 軸 2: card body バッジを category.name ASC, option.name ASC (localeCompare ja) で並べる。
  const sortedCardTags = useMemo(() => {
    return [...cardTags].sort((a, b) => {
      const optA = options.find((o) => o.id === a.option_id)
      const optB = options.find((o) => o.id === b.option_id)
      if (!optA || !optB) return 0
      const catA = categories.find((c) => c.id === optA.category_id)
      const catB = categories.find((c) => c.id === optB.category_id)
      if (!catA || !catB) return 0
      const catCmp = catA.name.localeCompare(catB.name, 'ja')
      if (catCmp !== 0) return catCmp
      return optA.name.localeCompare(optB.name, 'ja')
    })
  }, [cardTags, options, categories])

  // Tag-4c-2a: create 系 handler は module スコープ実装に props (userId / cardId /
  // 当該 scope の集合) を bind した closure として useCallback で安定化する。
  // popover に渡す `tagEditCallbacks` interface は (name, selectType) / (categoryId, name)
  // という UI 視点の引数のみを残す (props は section が握る)。
  const createCategory = useCallback(
    (name: string, selectType: 'single' | 'multi') =>
      handleCreateCategory(userId, categories, name, selectType),
    [userId, categories],
  )

  const createOptionAndAssign = useCallback(
    (categoryId: string, name: string) =>
      handleCreateOptionAndAssign(
        userId,
        cardId,
        categories,
        options,
        cardTags,
        categoryId,
        name,
      ),
    [userId, cardId, categories, options, cardTags],
  )

  // Tag-4c-2b T6: D&D reorder handler の component 側 closure。
  // module スコープ `handleReorderCategories` / `handleReorderOptions` に当該 scope
  // (categories / options) を bind した closure を useCallback で安定化する。
  // popover に渡す `tagEditCallbacks` interface は popover 側 UI 視点の引数のみを残す。
  const reorderCategories = useCallback(
    (orderedIds: string[]) => handleReorderCategories(categories, orderedIds),
    [categories],
  )

  const reorderOptions = useCallback(
    (categoryId: string, orderedIds: string[]) =>
      handleReorderOptions(options, categoryId, orderedIds),
    [options],
  )

  // Tag-4c-1 + Tag-4c-2a + Tag-4c-2b: 6 handlers + 2 count helpers + 2 create handlers
  // + 2 reorder handlers を単一 memoized object に集約。 module スコープ関数 (rename /
  // color / delete / count) は deps 不要、 useCallback で安定化した create 系 + reorder
  // 系のみ deps に含める。 popover の React.memo identity を維持するため、 これらの
  // 引数依存変化時のみ object identity が変わる。
  const tagEditCallbacks: TagEditCallbacks = useMemo(() => ({
    renameCategory: handleRenameCategory,
    setCategoryColor: handleSetCategoryColor,
    deleteCategory: handleDeleteCategory,
    renameOption: handleRenameOption,
    setOptionColor: handleSetOptionColor,
    deleteOption: handleDeleteOption,
    countCategoryImpact,
    countOptionImpact,
    createCategory,
    createOptionAndAssign,
    reorderCategories,
    reorderOptions,
  }), [createCategory, createOptionAndAssign, reorderCategories, reorderOptions])

  const handleToggle = async (categoryId: string, optionId: string) => {
    const category = categories.find((c) => c.id === categoryId)
    if (!category) return

    const sameCategoryOptionIds = new Set(
      options.filter((o) => o.category_id === categoryId).map((o) => o.id),
    )

    const { next, toAdd, toRemove } = buildNextTagSet(
      category,
      allAssignedOptionIds,
      sameCategoryOptionIds,
      optionId,
    )

    const db = getClientDb()
    const nowIso = new Date().toISOString()

    // optimistic mirror 書込と outbox enqueue を同一 Dexie tx に寄せる。
    // 「UI だけ反映され送信予約が無い」 状態を構造的に排除: enqueue が失敗すれば Dexie が
    // tx を自動 rollback、 mirror も元に戻る。 flush (ネットワーク送信) は tx 外で fire-and-
    // forget、 outbox row は残るため次回 trigger で再送される。
    // (Tag-4b-fix codex review #1: 旧 void 並列発行を atomic 化。 他 8 ファイル経路は
    // 別 sprint「Sync-fix-1」 で共有 helper に収束予定、 本 component が reference 実装)。
    try {
      await db.transaction('rw', db.card_tags, db.entity_mutations, async () => {
        for (const id of toRemove) await db.card_tags.delete([cardId, id])
        for (const id of toAdd) {
          await db.card_tags.put({
            card_id: cardId,
            option_id: id,
            user_id: userId,
            created_at: nowIso,
          })
        }
        await enqueueEntityMutation({
          entity_type: 'card',
          entity_id: cardId,
          op: 'update_field',
          patch: { field: 'tag_option_ids', value: next },
        })
      })
    } catch {
      // Dexie tx auto-rollback 済 (mirror + outbox 共に未反映)。 案 a 取り直し経路で
      // 次回 pull が server 値で reconcile するため、 UI への明示通知は省略。
      return
    }

    // flush は tx 外で best-effort。 失敗しても outbox row は残り次回 trigger で再送される。
    void runGuardedEntityMutationFlush().catch(() => {})
  }

  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium text-slate-500">タグ</h3>
      <div className="flex flex-wrap items-center gap-1">
        {sortedCardTags.map((ct) => {
          const option = options.find((o) => o.id === ct.option_id)
          if (!option) return null // stale tag (option deleted)、 defensive skip
          const category = categories.find((c) => c.id === option.category_id)
          if (!category) return null // stale tag (category deleted)、 defensive skip

          const sameCatOptionIds = options.filter(
            (o) => o.category_id === category.id,
          )
          const selectedInCategory = new Set(
            allAssignedOptionIds.filter((id) =>
              sameCatOptionIds.some((o) => o.id === id),
            ),
          )

          return (
            <CardTagEditPopover
              key={`${ct.card_id}-${ct.option_id}`}
              category={category}
              categoryOptions={sameCatOptionIds}
              selectedOptionIds={selectedInCategory}
              onToggle={(optId) => handleToggle(category.id, optId)}
              tagEditCallbacks={tagEditCallbacks}
            >
              <CardTagBadge
                category={category}
                option={option}
                onRemove={() => handleToggle(category.id, option.id)}
                onOpenEdit={() => {}}
              />
            </CardTagEditPopover>
          )
        })}
        <CardTagAddPopover
          categories={categories}
          options={options}
          allAssignedOptionIds={allAssignedOptionIds}
          onToggle={handleToggle}
          tagEditCallbacks={tagEditCallbacks}
          onReorderCategories={tagEditCallbacks.reorderCategories}
          onReorderOptions={tagEditCallbacks.reorderOptions}
        />
      </div>
    </div>
  )
}

// 親 InlineCardList が `categories` / `options` を useMemo で安定化し、 `cardTags` は
// 1 card 分の subset を渡すため、 shallow compare 既定の React.memo で十分機能する
// (関係する card の section だけ再描画され、 他 card は skip)。
export const CardTagsSection = memo(CardTagsSectionInner)
