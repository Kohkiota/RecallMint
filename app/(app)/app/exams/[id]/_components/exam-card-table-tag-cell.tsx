// TagCell — Grid-1 T6: table view の 1 cell 分タグ表示 + popover trigger 統合。
// K=5 固定 (OQ-2 確定): 先頭 K 個を badge として表示、 残りを +N に集約。
// K 以下なら全 badge を render (線引きは件数ベース、 line-clamp 不使用)。
// 空セル (タグ 0 件) は「+」 placeholder badge 1 つ。
//
// click 挙動:
//   - 既存バッジ click → popover initialStage='option' + initialCategoryId={category.id}
//   - +N click → popover initialStage 未指定 (= 'category' start)
//   - 空セル placeholder click → popover initialStage 未指定
//
// useCardTagToggle は ExamCardTable レベルで 1 回 instantiate し、 toggle callback を props で受け取る。
// tagEditCallbacks は ExamCardTable レベルで 1 回構築し、 TagCell 内で createOptionAndAssign を
// cardId-bound に差し替えて popover に渡す (ExamCardTable は cardId を知らない)。
//
// 'use client' directive を付けない: TagCell は ExamCardTable (= 'use client') からのみ
// import される子 component で、 boundary は親側で確立済。 file 自体に 'use client' を
// 付けると Next.js TS plugin が function 型 prop (`toggle`) を「serializable でない
// Server Action prop」 として誤検出する (rule 71007、 T2 hook と同 pattern)。

import * as React from 'react'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { compareTagEntry } from '@/lib/tags/sort-comparator'
import type { ToggleFn } from '../_hooks/use-card-tag-toggle'

import { CardTagBadge } from './card-tag-badge'
import { CardTagAddPopover } from './card-tag-add-popover'
import {
  handleCreateOptionAndAssign,
  type TagEditCallbacks,
} from '@/lib/tags/tag-crud'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** OQ-2 確定 K=5 (mobile / desktop 共通) */
const TAG_CELL_K = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TagCellTag = {
  category: ClientTagCategory
  option: ClientTagOption
}

export type TagCellProps = {
  cardId: string
  /** card owner の userId (createOptionAndAssign bind 用) */
  userId: string
  tags: TagCellTag[]
  /** table レベルで共有する全カテゴリ一覧 */
  categories: ClientTagCategory[]
  /** table レベルで共有する全 option 一覧 */
  options: ClientTagOption[]
  /** ExamCardTable レベルで 1 回 instantiate された toggle fn */
  toggle: ToggleFn
  /** ExamCardTable レベルで 1 回構築された tagEditCallbacks (createOptionAndAssign は TagCell 内で cardId-bound に override) */
  tagEditCallbacks: TagEditCallbacks
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TagCell({
  cardId,
  userId,
  tags,
  categories,
  options,
  toggle,
  tagEditCallbacks,
}: TagCellProps) {
  // 表示順は compareTagEntry (card-tags-section.tsx の sortedCardTags と同じ comparator)。
  // category sort_key ASC NULLS LAST → 同カテゴリ内 option sort_key ASC NULLS LAST → created_at ASC。
  const sortedTags = React.useMemo(
    () =>
      [...tags].sort(compareTagEntry),
    [tags],
  )

  const totalCount = sortedTags.length
  const visibleTags = sortedTags.slice(0, TAG_CELL_K)
  // K 以下なら hiddenCount=0 → +N 非表示
  const hiddenCount = Math.max(0, totalCount - TAG_CELL_K)

  // 該当 card の全 option_id (popover の allAssignedOptionIds に渡す)
  const allAssignedOptionIds = React.useMemo(
    () => sortedTags.map((t) => t.option.id),
    [sortedTags],
  )

  // createOptionAndAssign は cardId-bound な closure (ExamCardTable の placeholder を override)。
  // CardTagAddPopover が option 新規作成時に tagEditCallbacks.createOptionAndAssign(categoryId, name)
  // を呼ぶため、 cardId + userId を bind した closure を TagCell レベルで構築する。
  // tags から ClientCardTag 形式の配列を構築 (handleCreateOptionAndAssign の existingCardTags 引数)。
  const cardTagsForThisCard = React.useMemo(
    () =>
      sortedTags.map((t) => ({
        card_id: cardId,
        option_id: t.option.id,
        user_id: userId,
        created_at: t.option.created_at,
      })),
    [sortedTags, cardId, userId],
  )

  const cardIdBoundCallbacks: TagEditCallbacks = React.useMemo(
    () => ({
      ...tagEditCallbacks,
      createOptionAndAssign: (categoryId: string, name: string) =>
        handleCreateOptionAndAssign(
          userId,
          cardId,
          categories,
          options,
          cardTagsForThisCard,
          categoryId,
          name,
        ),
    }),
    [tagEditCallbacks, userId, cardId, categories, options, cardTagsForThisCard],
  )

  // popover に渡す共通 props (initialStage / initialCategoryId / trigger は各インスタンスで異なる)
  const sharedPopoverProps = {
    categories,
    options,
    allAssignedOptionIds,
    onToggle: (categoryId: string, optionId: string) =>
      void toggle(cardId, categoryId, optionId),
    tagEditCallbacks: cardIdBoundCallbacks,
  }

  return (
    <div
      data-testid={`tag-cell-${cardId}`}
      data-tag-count={totalCount}
      className="flex flex-wrap items-center gap-1"
    >
      {totalCount === 0 && (
        // 空セル placeholder: 「+」 badge 1 つ。 click → popover initialStage 未指定 (= 'category')
        <CardTagAddPopover
          {...sharedPopoverProps}
          trigger={
            <button
              type="button"
              aria-label="タグを追加"
              className="inline-flex items-center justify-center rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-700 hover:border-slate-400"
            >
              +
            </button>
          }
        />
      )}

      {visibleTags.map((t) => (
        // 各バッジ: CardTagBadge を trigger 化。 asChild で PopoverTrigger が button の onClick を merge。
        // onOpenEdit は no-op (asChild 経由の click で popover が開く)。
        // onRemove は toggle で当該 option を remove (× click、 stopPropagation で popover は開かない)。
        <CardTagAddPopover
          key={`${cardId}-${t.option.id}`}
          {...sharedPopoverProps}
          initialStage="option"
          initialCategoryId={t.category.id}
          trigger={
            <CardTagBadge
              category={t.category}
              option={t.option}
              onRemove={() => void toggle(cardId, t.category.id, t.option.id)}
              onOpenEdit={() => {}}
            />
          }
        />
      ))}

      {hiddenCount > 0 && (
        // +N badge: click → popover initialStage 未指定 (全カテゴリ横断 = 既存挙動)
        <CardTagAddPopover
          {...sharedPopoverProps}
          trigger={
            <button
              type="button"
              aria-label={`他 ${hiddenCount} タグ`}
              className="inline-flex items-center justify-center rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-700 hover:border-slate-400"
            >
              +{hiddenCount}
            </button>
          }
        />
      )}
    </div>
  )
}
