'use client'

// CardTagsSection: 1 card 分の「タグ」 section orchestrator。 categories を
// created_at ASC で iterate し、 各カテゴリ row に option / cardTags filter 後の
// props を渡す。 自身は描画組立のみで、 optimistic 更新 logic は子 (CardTagCategoryRow)
// が担う。
//
// 描画 spec (`docs/superpowers/specs/2026-06-07-tag-4b-card-tags-section-design.md` §4):
// - 見出し「タグ」 + 横に「タグ管理 →」 link (常時表示、 /app/tags)
// - カテゴリ ≥1 件: 各 row を created_at ASC で render
// - カテゴリ 0 件: placeholder 文 (「タグ管理ページでカテゴリを作成すると…」) を表示
// - cardTags は本 card 分のみが渡される前提 (親 InlineCardList が card_id でグループ化)
//
// パフォーマンス:
// - 親で useLiveQuery 一括 subscribe + React.memo + useMemo で再描画最小化する設計
//   (Task 3 で配線)。 本 component は受領 props を pure に描画。
// - Tag-4b Task 3: 本 component を React.memo でラップする。 親 (InlineCardList) は
//   `categories` / `options` を useMemo で同 ref に固定し、 `cardTags` は 1 card 分の
//   subset を渡すため、 ある card にタグを付けた瞬間に他の card の section が再描画
//   されるのを memo で構造的に防ぐ。

import { memo } from 'react'
import Link from 'next/link'

import type {
  ClientTagCategory,
  ClientTagOption,
  ClientCardTag,
} from '@/lib/client-db'

import { CardTagCategoryRow } from './card-tag-category-row'

type Props = {
  cardId: string
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  cardTags: ClientCardTag[]
}

function CardTagsSectionInner({
  cardId,
  categories,
  options,
  cardTags,
}: Props) {
  // 本 card の全カテゴリ横断 option_id 配列。 各 row の whole-set 構築に使う。
  const allAssignedOptionIds = cardTags.map((t) => t.option_id)

  // 親が pre-sort してくれている保証はないため、 描画前に created_at ASC に固定。
  const sortedCategories = [...categories].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-500">タグ</h3>
        <Link
          href="/app/tags"
          prefetch={false}
          className="text-xs text-slate-500 hover:text-slate-900"
        >
          タグ管理 →
        </Link>
      </div>

      {sortedCategories.length === 0 ? (
        <p className="text-xs text-slate-500">
          タグ管理ページでカテゴリを作成すると、 ここでタグを付けられます。
        </p>
      ) : (
        <div className="space-y-1.5">
          {sortedCategories.map((category) => {
            const categoryOptions = options
              .filter((o) => o.category_id === category.id)
              .sort((a, b) =>
                a.created_at < b.created_at
                  ? -1
                  : a.created_at > b.created_at
                    ? 1
                    : 0,
              )
            const categoryOptionIdSet = new Set(
              categoryOptions.map((o) => o.id),
            )
            const assignedOptionIds = allAssignedOptionIds.filter((id) =>
              categoryOptionIdSet.has(id),
            )
            return (
              <CardTagCategoryRow
                key={category.id}
                cardId={cardId}
                category={category}
                categoryOptions={categoryOptions}
                assignedOptionIds={assignedOptionIds}
                allAssignedOptionIds={allAssignedOptionIds}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// 親 InlineCardList が `categories` / `options` を useMemo で安定化し、 `cardTags` は
// 1 card 分の subset を渡すため、 shallow compare 既定の React.memo で十分機能する
// (関係する card の section だけ再描画され、 他 card は skip)。
export const CardTagsSection = memo(CardTagsSectionInner)
