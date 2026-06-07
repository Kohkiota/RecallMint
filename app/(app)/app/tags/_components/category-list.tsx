'use client'

// tag manager 左 column の orchestrator。
// - useLiveQuery で db.tag_categories.toArray() → created_at ASC で sort
//   (tag_categories index は `updated_at` のみ、 created_at は in-memory sort)
// - CategoryCreateForm + 各 CategoryRow を render
// - 削除フロー: CategoryRow から onDelete callback を受けて 影響範囲 count (配下
//   option 数 + 紐付き card 数) を IDB から集計 → DeleteConfirmDialog 表示
//   → 確定で `enqueueEntityMutation({entity_type:'tag_category', op:'delete'})`
//   1 件のみ発行 (server 側 applyTagCategoryDelete が配下 option + card_tags も
//   tombstone INSERT + FK cascade で削除)
// - active 切替: row click → onSelectCategory(id)、 削除確定で active が消えるなら
//   onSelectCategory(null)
// - 作成 form の onCreated callback で新カテゴリを即 active 化 (UX)

import * as React from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import {
  getClientDb,
  type ClientTagCategory,
} from '@/lib/client-db'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'

import { CategoryRow } from './category-row'
import { CategoryCreateForm } from './category-create-form'
import { DeleteConfirmDialog } from './delete-confirm-dialog'

type Props = {
  activeCategoryId: string | null
  onSelectCategory: (id: string | null) => void
}

type PendingDelete = {
  category: ClientTagCategory
  childOptionCount: number
  cardCount: number
}

// created_at ASC で並べる (sort_key UI は Tag-4e で導入、 4a は固定順)。
// `<` 比較で十分 (ISO 8601 文字列の辞書順 = 時系列順)。
function sortByCreatedAt(
  a: ClientTagCategory,
  b: ClientTagCategory,
): number {
  if (a.created_at === b.created_at) return 0
  return a.created_at < b.created_at ? -1 : 1
}

export function CategoryList({
  activeCategoryId,
  onSelectCategory,
}: Props) {
  const [pendingDelete, setPendingDelete] =
    React.useState<PendingDelete | null>(null)

  const categories = useLiveQuery(async () => {
    const all = await getClientDb().tag_categories.toArray()
    return all.slice().sort(sortByCreatedAt)
  }, [])

  // 削除 button click を受けて IDB から影響範囲を集計し、 確認 dialog を開く。
  // 集計は async (Dexie count) のため pending state を経由する。
  const handleDeleteRequest = async (category: ClientTagCategory) => {
    const db = getClientDb()
    let childOptionCount = 0
    let cardCount = 0
    try {
      const options = await db.tag_options
        .where('category_id')
        .equals(category.id)
        .toArray()
      childOptionCount = options.length
      // 各 option の card_tags を逐次 count して合算。 option 数は通常少ない (~10) ので
      // 並列 count は不要。 100+ の表示丸めは dialog 側で吸収。
      for (const opt of options) {
        cardCount += await db.card_tags
          .where('option_id')
          .equals(opt.id)
          .count()
      }
    } catch (err) {
      logger.warn({
        event: 'tag_category_delete.count_failed',
        categoryId: category.id,
        err: String(err),
      })
    }
    setPendingDelete({ category, childOptionCount, cardCount })
  }

  const handleConfirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete.category
    setPendingDelete(null)

    // optimistic cascade purge: 子孫 (card_tags) → 中孫 (options) → 親 (category) の
    // 順で mirror から物理削除し useLiveQuery を即時再描画させる。 server cascade
    // (applyTagCategoryDelete + FK) も等価処理を走らせるが、 二重削除 idempotent
    // (server 真値が pull で上書き)。 enqueue より **先に** 発火 (UI 即反映の保証、
    // mock spy 順序で gate)。
    void (async () => {
      const db = getClientDb()
      try {
        const options = await db.tag_options
          .where('category_id')
          .equals(target.id)
          .toArray()
        const optionIds = options.map((o) => o.id)
        if (optionIds.length > 0) {
          await db.card_tags.where('option_id').anyOf(optionIds).delete()
        }
        await db.tag_options
          .where('category_id')
          .equals(target.id)
          .delete()
        await db.tag_categories.delete(target.id)
      } catch (err) {
        logger.warn({
          event: 'tag_category_delete.mirror_purge_failed',
          categoryId: target.id,
          err: String(err),
        })
      }
    })()

    void enqueueEntityMutation({
      entity_type: 'tag_category',
      entity_id: target.id,
      op: 'delete',
      patch: {},
    }).catch((err) => {
      logger.warn({
        event: 'tag_category_delete.enqueue_failed',
        categoryId: target.id,
        err: String(err),
      })
    })
    void runGuardedEntityMutationFlush().catch(() => {})

    // 削除対象が現 active なら active を解除。 server pull で IDB から消えた後に
    // 別カテゴリへの自動遷移は今回はしない (空 state へ落とすほうが意図明確)。
    if (activeCategoryId === target.id) {
      onSelectCategory(null)
    }
  }

  const handleCancelDelete = () => {
    setPendingDelete(null)
  }

  const handleCreated = (newId: string) => {
    // 新規作成カテゴリを即 active 化 (UX: 直後の option 追加導線が自然に繋がる)。
    onSelectCategory(newId)
  }

  const list = categories ?? []

  return (
    <div className="space-y-3">
      <CategoryCreateForm onCreated={handleCreated} />

      <ul className="space-y-1">
        {list.map((category) => (
          <li key={category.id}>
            <CategoryRow
              category={category}
              active={category.id === activeCategoryId}
              onSelect={onSelectCategory}
              onDelete={(c) => {
                void handleDeleteRequest(c)
              }}
            />
          </li>
        ))}
      </ul>

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        targetKind="category"
        targetName={pendingDelete?.category.name ?? ''}
        childOptionCount={pendingDelete?.childOptionCount ?? 0}
        cardCount={pendingDelete?.cardCount ?? 0}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  )
}
