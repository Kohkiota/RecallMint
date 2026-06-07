'use client'

// tag manager 右 column の orchestrator。
// - activeCategoryId=null: 「カテゴリを選択してください」 placeholder のみ表示
// - activeCategoryId 指定:
//   - useLiveQuery で `db.tag_options.where('category_id').equals(activeCategoryId)
//     .toArray()` → created_at ASC sort (tag_options index は category_id /
//     updated_at のみ、 created_at は in-memory sort)
//   - useLiveQuery で `db.tag_categories.toArray()` (OptionRow のカテゴリ変更
//     dropdown 用に伝播)
//   - OptionCreateForm + 各 OptionRow を render
//   - 削除フロー: OptionRow から onDelete callback を受けて 影響範囲 (`db.card_tags
//     .where('option_id').equals(optId).count()`) を集計 → DeleteConfirmDialog 表示
//     → 確定で enqueueEntityMutation({entity_type:'tag_option', op:'delete',
//     patch:{}}) 発行 + flush (server 側 applyTagOptionDelete が tombstone INSERT
//     + 物理 DELETE、 FK CASCADE で card_tags も消える)

import * as React from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'

import { OptionRow } from './option-row'
import { OptionCreateForm } from './option-create-form'
import { DeleteConfirmDialog } from './delete-confirm-dialog'

type Props = {
  activeCategoryId: string | null
}

type PendingDelete = {
  option: ClientTagOption
  cardCount: number
}

// created_at ASC で並べる (sort_key UI は Tag-4e で導入、 4a は固定順)。
function sortByCreatedAt(
  a: ClientTagOption,
  b: ClientTagOption,
): number {
  if (a.created_at === b.created_at) return 0
  return a.created_at < b.created_at ? -1 : 1
}

export function OptionList({ activeCategoryId }: Props) {
  const [pendingDelete, setPendingDelete] =
    React.useState<PendingDelete | null>(null)

  // active カテゴリ配下の options。 activeCategoryId が null の間は空配列扱い。
  const options = useLiveQuery(async () => {
    if (activeCategoryId === null) return []
    const all = await getClientDb()
      .tag_options.where('category_id')
      .equals(activeCategoryId)
      .toArray()
    return all.slice().sort(sortByCreatedAt)
  }, [activeCategoryId])

  // 全カテゴリ (OptionRow のカテゴリ変更 dropdown 用)。 active 切替に追随する必要は
  // ないが、 useLiveQuery を 1 つで済ます都合上 deps は不要。
  const allCategories: ClientTagCategory[] =
    useLiveQuery(async () => {
      return await getClientDb().tag_categories.toArray()
    }, []) ?? []

  const handleDeleteRequest = async (option: ClientTagOption) => {
    const db = getClientDb()
    let cardCount = 0
    try {
      cardCount = await db.card_tags
        .where('option_id')
        .equals(option.id)
        .count()
    } catch (err) {
      logger.warn({
        event: 'tag_option_delete.count_failed',
        optionId: option.id,
        err: String(err),
      })
    }
    setPendingDelete({ option, cardCount })
  }

  const handleConfirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete.option
    setPendingDelete(null)

    // optimistic cascade purge: 子孫 (card_tags) → 親 (option) の順で mirror から
    // 物理削除し useLiveQuery を即時再描画させる。 server cascade
    // (applyTagOptionDelete + FK) も等価処理を走らせるが、 二重削除 idempotent。
    // enqueue より **先に** 発火 (UI 即反映の保証、 mock spy 順序で gate)。
    void (async () => {
      const db = getClientDb()
      try {
        await db.card_tags.where('option_id').equals(target.id).delete()
        await db.tag_options.delete(target.id)
      } catch (err) {
        logger.warn({
          event: 'tag_option_delete.mirror_purge_failed',
          optionId: target.id,
          err: String(err),
        })
      }
    })()

    void enqueueEntityMutation({
      entity_type: 'tag_option',
      entity_id: target.id,
      op: 'delete',
      patch: {},
    }).catch((err) => {
      logger.warn({
        event: 'tag_option_delete.enqueue_failed',
        optionId: target.id,
        err: String(err),
      })
    })
    void runGuardedEntityMutationFlush().catch(() => {})
  }

  const handleCancelDelete = () => {
    setPendingDelete(null)
  }

  if (activeCategoryId === null) {
    return (
      <div className="rounded-md border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
        カテゴリを選択してください
      </div>
    )
  }

  const list = options ?? []
  const existingNames = list.map((o) => o.name)

  return (
    <div className="space-y-3">
      <OptionCreateForm
        activeCategoryId={activeCategoryId}
        existingNames={existingNames}
      />

      <ul className="space-y-1">
        {list.map((opt) => (
          <li key={opt.id}>
            <OptionRow
              option={opt}
              allCategories={allCategories}
              onDelete={(o) => {
                void handleDeleteRequest(o)
              }}
            />
          </li>
        ))}
      </ul>

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        targetKind="option"
        targetName={pendingDelete?.option.name ?? ''}
        cardCount={pendingDelete?.cardCount ?? 0}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  )
}
