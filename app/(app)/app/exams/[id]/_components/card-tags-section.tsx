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

import { memo } from 'react'

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
        {cardTags.map((ct) => {
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
        />
      </div>
    </div>
  )
}

// 親 InlineCardList が `categories` / `options` を useMemo で安定化し、 `cardTags` は
// 1 card 分の subset を渡すため、 shallow compare 既定の React.memo で十分機能する
// (関係する card の section だけ再描画され、 他 card は skip)。
export const CardTagsSection = memo(CardTagsSectionInner)
