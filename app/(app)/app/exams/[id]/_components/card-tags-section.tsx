'use client'

// CardTagsSection: 1 card 分の「タグ」 section orchestrator。
// optimistic toggle logic を集約し、 付与済バッジ群 + 「+ タグを追加」 button を組み立てる。
//
// 設計変更点 (Tag-4b-fix):
// - 旧: categories を iterate → 全カテゴリ row を常時表示 (CardTagCategoryRow)
// - 新: cardTags を iterate → 付与済み tag のバッジのみ表示 (Notion 方式)
// - 「タグ管理 →」 link は見出し横から削除。 popover footer のみに配置。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md

import { memo, useMemo } from 'react'

import { logger } from '@/lib/logger'
import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

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

  // Tag-4c-1: 6 handlers + 2 count helpers を単一 memoized object に集約。
  // handlers は module スコープ関数 (getClientDb singleton のみ参照、 React state 依存なし)
  // のため deps [] で安全。 object identity を安定化することで popover の React.memo が
  // 機能する (親の re-render で毎回新オブジェクトが渡らない)。
  const tagEditCallbacks: TagEditCallbacks = useMemo(() => ({
    renameCategory: handleRenameCategory,
    setCategoryColor: handleSetCategoryColor,
    deleteCategory: handleDeleteCategory,
    renameOption: handleRenameOption,
    setOptionColor: handleSetOptionColor,
    deleteOption: handleDeleteOption,
    countCategoryImpact,
    countOptionImpact,
  }), [])

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
        />
      </div>
    </div>
  )
}

// 親 InlineCardList が `categories` / `options` を useMemo で安定化し、 `cardTags` は
// 1 card 分の subset を渡すため、 shallow compare 既定の React.memo で十分機能する
// (関係する card の section だけ再描画され、 他 card は skip)。
export const CardTagsSection = memo(CardTagsSectionInner)
