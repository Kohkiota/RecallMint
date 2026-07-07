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

import {
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import {
  handleReorderCategories,
  handleReorderOptions,
} from '@/lib/tags/reorder-handlers'
import { compareTagEntry } from '@/lib/tags/sort-comparator'
import {
  handleRenameCategory,
  handleSetCategoryColor,
  handleDeleteCategory,
  handleRenameOption,
  handleSetOptionColor,
  handleDeleteOption,
  countCategoryImpact,
  countOptionImpact,
  handleCreateCategory,
  handleCreateOptionAndAssign,
  type TagEditCallbacks,
} from '@/lib/tags/tag-crud'

import { useCardTagToggle } from '../_hooks/use-card-tag-toggle'

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
// Pure helper: whole-set 構築ロジック
//
// Grid-2 T4: 定義本体は `@/lib/tags/build-next-tag-set` に移設 (単票 hook と bulk helper で共有)。
// ここでは re-export のみ残し、 既存 importer (use-card-tag-toggle / 本 file の test) の
// `import { buildNextTagSet } from './card-tags-section'` 互換を保つ。 ロジック・挙動は完全不変。
// ---------------------------------------------------------------------------

export { buildNextTagSet } from '@/lib/tags/build-next-tag-set'

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

  // Tag-4c-2c hotfix H1 で sort_key 順に切替 (共有 `sortByKeyThenCreated` で popover/manager/バッジ
  // 3 経路の並びを揃える)。 第 1 キー = category.sort_key 数値昇順、 第 2 キー = 同 category 内
  // option.sort_key 数値昇順、 tie-break = created_at (comparator 内蔵)。 旧 Fix C-3 軸 2 (Tag-4b-fix
  // 由来) は name localeCompare で固定していたため、 sort_key 未参照の文字列辞書順による 11+ 件
  // 誤順 (調査 3) を解消する。
  const sortedCardTags = useMemo(() => {
    return [...cardTags].sort((a, b) => {
      const optA = options.find((o) => o.id === a.option_id)
      const optB = options.find((o) => o.id === b.option_id)
      if (!optA || !optB) return 0
      const catA = categories.find((c) => c.id === optA.category_id)
      const catB = categories.find((c) => c.id === optB.category_id)
      if (!catA || !catB) return 0
      return compareTagEntry({ category: catA, option: optA }, { category: catB, option: optB })
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

  // Tag-4c-2b T7 M-C: D&D reorder handler の component 側 closure。 module スコープ
  // `handleReorderCategories` / `handleReorderOptions` に当該 scope (categories / options)
  // を bind し useCallback で安定化、 CardTagAddPopover の standalone props として直接
  // 渡す (tagEditCallbacks 経由を drop し 1 経路化、 spec §4.7 反映)。
  const reorderCategories = useCallback(
    (orderedIds: string[]) => handleReorderCategories(categories, orderedIds),
    [categories],
  )

  const reorderOptions = useCallback(
    (categoryId: string, orderedIds: string[]) =>
      handleReorderOptions(options, categoryId, orderedIds),
    [options],
  )

  // Tag-4c-1 + Tag-4c-2a: 6 handlers + 2 count helpers + 2 create handlers を単一
  // memoized object に集約。 module スコープ関数 (rename / color / delete / count) は
  // deps 不要、 useCallback で安定化した create 系のみ deps に含める。 reorder 系は
  // Tag-4c-2b T7 M-C で popover の standalone props 1 経路に分離 (型から drop 済)。
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
  }), [createCategory, createOptionAndAssign])

  // Grid-1 T2: toggle ロジックを useCardTagToggle hook に切り出し。
  // hook は table レベルで 1 回 instantiate し、 getCardContext で live data を渡す。
  // CardTagsSection の outward 挙動 (props / render / mutation 反映タイミング) は完全不変。
  // CardTagsSection は per-card scope (props で 1 card 分のみ受領) のため、
  // getCardContext は cardId を見ずに固定 context を返す。 T6 TagCell の
  // table-level usage では cardId をキーに Map lookup する形になる。
  const rowToggle = useCardTagToggle({
    userId,
    getCardContext: (_cardId) => ({
      categories,
      options,
      allAssignedOptionIds,
    }),
  })

  const handleToggle = useCallback(
    (categoryId: string, optionId: string) => rowToggle(cardId, categoryId, optionId),
    [rowToggle, cardId],
  )

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
          onReorderCategories={reorderCategories}
          onReorderOptions={reorderOptions}
        />
      </div>
    </div>
  )
}

// 親 InlineCardList が `categories` / `options` を useMemo で安定化し、 `cardTags` は
// 1 card 分の subset を渡すため、 shallow compare 既定の React.memo で十分機能する
// (関係する card の section だけ再描画され、 他 card は skip)。
export const CardTagsSection = memo(CardTagsSectionInner)
