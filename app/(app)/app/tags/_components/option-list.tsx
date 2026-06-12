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
//   - 削除フロー: OptionRow から onDelete callback を受けて 確認なし即削除
//     (Tag-4c-2c hotfix H2 / popover Tag-4c-1-fix A-3 確定仕様「option 削除 = 確認なし
//     即削除」 と整合)。 optimistic cascade purge (子: card_tags 物理削除 →
//     親: tag_option 物理削除) → enqueueEntityMutation({entity_type:'tag_option',
//     op:'delete', patch:{}}) 発行 + flush (server 側 applyTagOptionDelete が
//     tombstone INSERT + 物理 DELETE、 FK CASCADE で card_tags も消える)。
//     category 削除側 (category-list.tsx) は ConfirmDialog 経路を維持 (仕様)。

import * as React from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { GripVertical } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { runOptimisticMutation } from '@/lib/sync/optimistic-mutation'
import { sortByKeyThenCreated } from '@/lib/tags/sort-comparator'
import { handleReorderOptions } from '@/lib/tags/reorder-handlers'
import { useTagSortableSensors } from '@/lib/tags/use-tag-sortable-sensors'

import { OptionRow } from './option-row'
import { OptionCreateForm } from './option-create-form'

type Props = {
  activeCategoryId: string | null
}

// sort_key 数値昇順 + 同位 created_at ASC を共有 comparator で適用 (Tag-4c-2b §4.8)。
// popover と同 IDB を同 comparator で読むことで両画面の並びを共有。 Tag-4c-2c T3:
// manager 行頭に D&D handle + DndContext を配線し、 共有 module
// `lib/tags/reorder-handlers.ts` の `handleReorderOptions(items, activeCategoryId,
// orderedIds)` (3 引数) を dispatch する。

// Tag-4c-2c T3 spec §4.2 / F-1 = A: SortableOptionRowWrapper を本 file 内に local
// 定義 (T2 `SortableCategoryRowWrapper` と対称、 generic 化はせず category / option
// 別 wrapper の個別運用)。 外側 `<li>` を `useSortable.setNodeRef` に当て、
// listeners/attributes は handle button のみに spread (event 分離契約: color pill
// / pen / カテゴリ移動 dropdown / 削除 × は通常 click のまま動作、 既存
// stopPropagation 実装に依存)。 `OptionRow` 本体は完全無変更で内側に nested。
function SortableOptionRowWrapper({
  option,
  allCategories,
  onDelete,
}: {
  option: ClientTagOption
  allCategories: ClientTagCategory[]
  onDelete: (option: ClientTagOption) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: option.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <li ref={setNodeRef} style={style} className="flex items-center">
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...listeners}
        {...attributes}
        aria-label={`option を並べ替え: ${option.name}`}
        className="inline-flex h-7 w-6 cursor-grab items-center justify-center touch-none text-slate-400 hover:text-slate-600"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div className="flex-1 min-w-0">
        <OptionRow
          option={option}
          allCategories={allCategories}
          onDelete={onDelete}
        />
      </div>
    </li>
  )
}

export function OptionList({ activeCategoryId }: Props) {
  // active カテゴリ配下の options。 activeCategoryId が null の間は空配列扱い。
  const options = useLiveQuery(async () => {
    if (activeCategoryId === null) return []
    const all = await getClientDb()
      .tag_options.where('category_id')
      .equals(activeCategoryId)
      .toArray()
    return all.slice().sort(sortByKeyThenCreated)
  }, [activeCategoryId])

  // 全カテゴリ (OptionRow のカテゴリ変更 dropdown 用)。 active 切替に追随する必要は
  // ないが、 useLiveQuery を 1 つで済ます都合上 deps は不要。
  const allCategories: ClientTagCategory[] =
    useLiveQuery(async () => {
      return await getClientDb().tag_categories.toArray()
    }, []) ?? []

  // Tag-4c-2c T3 spec §4.3 / hotfix H4: dnd-kit sensors (popover / T2 と同 hook を共有、
  // Mouse 即 / Touch long-press / Keyboard a11y、 詳細は
  // `lib/tags/use-tag-sortable-sensors.ts` の header コメント)。
  // Tag-4c-2c hotfix b02c072: 早期 return (`activeCategoryId === null`) より **前** に置く。
  // hooks は render の各 path で同数同順 invocation が必要 (React rules of hooks)、
  // 早期 return の後に置くと `activeCategoryId` の null → non-null 遷移で hook 数が
  // 変わり 「Rendered more hooks than during the previous render」 で throw する。
  const sensors = useTagSortableSensors()

  // Tag-4c-2c hotfix H2: ConfirmDialog 経路を撤去し即削除に統一 (popover Tag-4c-1-fix A-3
  // 確定仕様 「option 削除 = 確認なし即削除」 と整合)。 Sync-fix-1 T1b: cascade purge +
  // enqueue を 1 Dexie rw tx に閉じる (`runOptimisticMutation` multi-store)、 enqueue throw
  // で Dexie auto-rollback により cascade purge も巻き戻る。 manager は popover と異なり
  // same-tx atomic 必須ではないが、 silent lost write を構造的に塞ぐため helper 化。
  // `mutate` 内で 子孫 (card_tags) → 親 (tag_option) の順で物理削除し、 enqueue は helper が
  // tx 内で mutations を順次 await する (= enqueue より先に物理削除が走る発行順を維持)。
  const handleDeleteImmediate = (option: ClientTagOption): void => {
    const db = getClientDb()
    void runOptimisticMutation({
      stores: [db.card_tags, db.tag_options],
      mutate: async () => {
        await db.card_tags.where('option_id').equals(option.id).delete()
        await db.tag_options.delete(option.id)
      },
      mutations: [
        {
          entity_type: 'tag_option',
          entity_id: option.id,
          op: 'delete',
          patch: {},
        },
      ],
      logEvent: 'tag_option_delete.tx_failed',
      logContext: { optionId: option.id },
    })
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
  // Tag-4c-2b T7: 末尾採番のため active category 配下の既存 sort_key 群を form に渡す。
  const existingSortKeys = list.map((o) => o.sort_key)

  // 1 件以下は並べ替え不能 → DndContext を mount せず素の `<li>` で render (handle 非表示)。
  // 構造的に「並べ替えできない」 状態を保証 (spec §4.3)。
  const sortableEnabled = list.length >= 2

  // Tag-4c-2c T3 spec §4.3: drag-end で 共有 module の `handleReorderOptions` を dispatch。
  // active/over が同 id or over=null は no-op、 防御 `findIndex === -1` も同。 共有 module は
  // defensive filter + reindexSortKeys + same-tx atomic + catch silent return + 外 flush を
  // 持つ (4c-2b T6/T7 で完成)、 manager 経路でもそのまま動く契約。 第 2 引数 categoryId は
  // 「reindex 母数を当該 category 配下のみに限定」 するための必須引数 (popover と同 arity)。
  const handleManagerDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = list.findIndex((o) => o.id === active.id)
    const newIndex = list.findIndex((o) => o.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(list, oldIndex, newIndex)
    void handleReorderOptions(
      list,
      activeCategoryId,
      next.map((o) => o.id),
    )
  }

  return (
    <div className="space-y-3">
      <OptionCreateForm
        activeCategoryId={activeCategoryId}
        existingNames={existingNames}
        existingSortKeys={existingSortKeys}
      />

      {sortableEnabled ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleManagerDragEnd}
        >
          <SortableContext
            items={list.map((o) => o.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-1">
              {list.map((opt) => (
                <SortableOptionRowWrapper
                  key={opt.id}
                  option={opt}
                  allCategories={allCategories}
                  onDelete={(o) => handleDeleteImmediate(o)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <ul className="space-y-1">
          {list.map((opt) => (
            <li key={opt.id}>
              <OptionRow
                option={opt}
                allCategories={allCategories}
                onDelete={(o) => handleDeleteImmediate(o)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
