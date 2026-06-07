'use client'

// CardTagCategoryRow: 1 カテゴリの表示行。 見出し + 型アイコン (multi/single) +
// 付与済 pill 群 + 「+ 追加」 dropdown を組み立てる。 optimistic 更新の本体
// (whole-set 構築 + IDB put/delete + enqueue + flush trigger) を本 component が担う。
//
// 重要な不変条件:
// - 親 (CardTagsSection / InlineCardList) から受け取る `allAssignedOptionIds` は
//   「該当 card の全カテゴリ横断の option_id 配列」。 本 row は自カテゴリの差分のみを
//   適用して新 whole-set を構築し、 そのまま `tag_option_ids` として enqueue する。
//   他カテゴリの option_id は維持される。
// - select_type='single' は「最大 1 個」 + 「0 個 (未選択) 許容」 + 「同 option
//   再 click で解除」 の radio 的挙動。 同カテゴリ既存を一旦 clear → click 対象が
//   元々付いてなければ add (= 入れ替え) / 元々付いてれば add せず 0 個に戻る。
// - 発行順序: IDB put/delete (transaction) → enqueueEntityMutation → flush trigger。
//   これにより useLiveQuery が即時再描画して UI optimistic を満たす。
//
// `runGuardedEntityMutationFlush()` は引数なしで呼ぶ (label 文字列は受け付けない、
// 既存 call site と統一)。 失敗時の rollback は親の useLiveQuery が次回 pull で
// reconcile する想定 (案 a 取り直し経路)。

import { CheckSquare, Circle } from 'lucide-react'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

import { CardTagPill } from './card-tag-pill'
import { CardTagAddDropdown } from './card-tag-add-dropdown'

type Props = {
  cardId: string
  category: ClientTagCategory
  categoryOptions: ClientTagOption[]
  assignedOptionIds: string[]
  allAssignedOptionIds: string[]
}

export function CardTagCategoryRow({
  cardId,
  category,
  categoryOptions,
  assignedOptionIds,
  allAssignedOptionIds,
}: Props) {
  // optimistic 更新本体。 click 対象 option を toggle (multi: in/out 反転、
  // single: radio 的) して whole-set を構築 → 差分を IDB に反映 → enqueue + flush。
  const applyToggle = async (clickedOptionId: string) => {
    const sameCategoryOptionIds = new Set(categoryOptions.map((o) => o.id))
    const oldSet = new Set(allAssignedOptionIds)
    const newSet = new Set(allAssignedOptionIds)

    if (category.select_type === 'multi') {
      if (newSet.has(clickedOptionId)) {
        newSet.delete(clickedOptionId)
      } else {
        newSet.add(clickedOptionId)
      }
    } else {
      // single: まず同カテゴリ既存を全 clear、 click 対象が元々付いてなければ
      // 新たに add (= 入れ替え)、 元々付いてれば add しない (= 0 個に戻る)。
      const wasAssigned = oldSet.has(clickedOptionId)
      for (const id of sameCategoryOptionIds) {
        newSet.delete(id)
      }
      if (!wasAssigned) {
        newSet.add(clickedOptionId)
      }
    }

    // 差分: 旧 → 新 で新規 add / 削除を計算。
    const toAdd: string[] = []
    const toRemove: string[] = []
    for (const id of newSet) {
      if (!oldSet.has(id)) toAdd.push(id)
    }
    for (const id of oldSet) {
      if (!newSet.has(id)) toRemove.push(id)
    }

    const db = getClientDb()
    const nowIso = new Date().toISOString()

    // 1. optimistic IDB 反映 (transaction)。 useLiveQuery が即時再描画する。
    await db.transaction('rw', db.card_tags, async () => {
      for (const id of toRemove) {
        await db.card_tags.delete([cardId, id])
      }
      for (const id of toAdd) {
        await db.card_tags.put({
          card_id: cardId,
          option_id: id,
          user_id: '',
          created_at: nowIso,
        })
      }
    })

    // 2. server に whole-set replace を enqueue (Tag-2c handler 仕様)。
    void enqueueEntityMutation({
      entity_type: 'card',
      entity_id: cardId,
      op: 'update_field',
      patch: { field: 'tag_option_ids', value: [...newSet] },
    })

    // 3. flush trigger (best-effort、 lock-busy は無視)。
    void runGuardedEntityMutationFlush().catch(() => {})
  }

  const handleToggle = (optionId: string) => {
    void applyToggle(optionId)
  }

  const handleRemove = (optionId: string) => {
    // pill × click は付与済 option に対する remove。 applyToggle は multi/single 共に
    // 「付与済 → 解除」 を正しく処理するため共通経路にする (single の場合は同カテゴリ
    // 既存 clear → add せず 0 個 になり、 結果として delete と等価)。
    void applyToggle(optionId)
  }

  const TypeIcon = category.select_type === 'multi' ? CheckSquare : Circle
  const assignedSet = new Set(assignedOptionIds)

  return (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      <span className="inline-flex items-center gap-1 text-slate-700">
        <span>{category.name}</span>
        <TypeIcon
          aria-label={`タイプ: ${category.select_type}`}
          className="w-4 h-4 text-slate-500"
        />
      </span>
      {categoryOptions
        .filter((o) => assignedSet.has(o.id))
        .map((o) => (
          <CardTagPill
            key={o.id}
            option={o}
            onRemove={() => handleRemove(o.id)}
          />
        ))}
      <CardTagAddDropdown
        categoryOptions={categoryOptions}
        selectedOptionIds={assignedSet}
        selectType={category.select_type}
        onToggle={handleToggle}
      />
    </div>
  )
}
