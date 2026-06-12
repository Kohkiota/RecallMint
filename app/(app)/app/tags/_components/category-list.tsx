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
} from '@/lib/client-db'
import { runOptimisticMutation } from '@/lib/sync/optimistic-mutation'
import { logger } from '@/lib/logger'
import { sortByKeyThenCreated } from '@/lib/tags/sort-comparator'
import { handleReorderCategories } from '@/lib/tags/reorder-handlers'
import { useTagSortableSensors } from '@/lib/tags/use-tag-sortable-sensors'

import { CategoryRow } from './category-row'
import { CategoryCreateForm } from './category-create-form'
import { DeleteConfirmDialog } from './delete-confirm-dialog'

type Props = {
  // Sync-fix-1 T2b: server で解決した userId を CategoryCreateForm に thread。
  userId: string
  activeCategoryId: string | null
  onSelectCategory: (id: string | null) => void
}

type PendingDelete = {
  category: ClientTagCategory
  childOptionCount: number
  cardCount: number
}

// sort_key 数値昇順 + 同位 created_at ASC を共有 comparator で適用 (Tag-4c-2b §4.8)。
// popover と同 IDB を同 comparator で読むことで「どちらで並べ替えても両画面が同じ並びを
// 共有」 が成立。 Tag-4c-2c T2: manager 行頭に D&D handle + DndContext を配線し、
// 共有 module `lib/tags/reorder-handlers.ts` の `handleReorderCategories` を dispatch。

// Tag-4c-2c T2 spec §4.2 / F-1 = A: SortableCategoryRowWrapper を本 file 内に local
// 定義。 generic 化はせず category / option 別 wrapper の個別運用 (manager の 2 list は
// children の UI 構造が異なり、 generic 化のメリット薄)。
// 外側 `<li>` を `useSortable.setNodeRef` に当て、 listeners/attributes は handle button
// のみに spread (event 分離契約: row click / pen / 削除 button は通常 click のまま動作)。
// `CategoryRow` 本体は完全無変更で内側に nested。
function SortableCategoryRowWrapper({
  category,
  active,
  onSelect,
  onDelete,
}: {
  category: ClientTagCategory
  active: boolean
  onSelect: (id: string) => void
  onDelete: (category: ClientTagCategory) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: category.id })
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
        aria-label={`カテゴリを並べ替え: ${category.name}`}
        className="inline-flex h-7 w-6 cursor-grab items-center justify-center touch-none text-slate-400 hover:text-slate-600"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div className="flex-1 min-w-0">
        <CategoryRow
          category={category}
          active={active}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      </div>
    </li>
  )
}

export function CategoryList({
  userId,
  activeCategoryId,
  onSelectCategory,
}: Props) {
  const [pendingDelete, setPendingDelete] =
    React.useState<PendingDelete | null>(null)

  const categories = useLiveQuery(async () => {
    const all = await getClientDb().tag_categories.toArray()
    return all.slice().sort(sortByKeyThenCreated)
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
      logger.warnFromError('tag_category_delete.count_failed', { categoryId: category.id }, err)
    }
    setPendingDelete({ category, childOptionCount, cardCount })
  }

  const handleConfirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete.category
    setPendingDelete(null)

    // optimistic cascade purge + enqueue を 1 Dexie rw tx に閉じる
    // (`runOptimisticMutation` multi-store)。 enqueue throw で Dexie auto-rollback により
    // cascade purge も巻き戻り、 useLiveQuery が削除前の状態に戻る (silent + 案 a 取り直し)。
    // server cascade (applyTagCategoryDelete + FK) も等価処理を走らせるが、 二重削除
    // idempotent (server 真値が pull で上書き)。 `mutate` 内で 子孫 (card_tags) →
    // 中孫 (tag_options) → 親 (tag_category) の順で物理削除し、 enqueue は helper が tx 内で
    // mutations を順次 await する (= enqueue より先に物理削除が走る発行順を維持)。
    const db = getClientDb()
    void runOptimisticMutation({
      stores: [db.card_tags, db.tag_options, db.tag_categories],
      mutate: async () => {
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
      },
      mutations: [
        {
          entity_type: 'tag_category',
          entity_id: target.id,
          op: 'delete',
          patch: {},
        },
      ],
      logEvent: 'tag_category_delete.tx_failed',
      logContext: { categoryId: target.id },
    })

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
  // Tag-4c-2b T7: 末尾採番のため既存 sort_key 群を form に渡す (共有 nextSortKey で消費)。
  const existingSortKeys = list.map((c) => c.sort_key)

  // Tag-4c-2c T2 spec §4.3 / hotfix H4: dnd-kit sensors。 popover と同 hook を共有して
  // 並び替え UX を統一する (Mouse 即 / Touch long-press / Keyboard a11y、 詳細は
  // `lib/tags/use-tag-sortable-sensors.ts` の header コメント)。
  const sensors = useTagSortableSensors()

  // 1 件以下は並べ替え不能 → DndContext を mount せず素の `<li>` で render (handle 非表示)。
  // 構造的に「並べ替えできない」 状態を保証 (spec §4.3)。
  const sortableEnabled = list.length >= 2

  // Tag-4c-2c T2 spec §4.3: drag-end で 共有 module の `handleReorderCategories` を dispatch。
  // active/over が同 id or over=null は no-op (popover と同形)、 防御 `findIndex === -1` も同。
  // 共有 module は defensive filter + reindexSortKeys + same-tx atomic + catch silent return +
  // 外 flush を持つ (4c-2b T6/T7 で完成)、 manager 経路でもそのまま動く契約。
  const handleManagerDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = list.findIndex((c) => c.id === active.id)
    const newIndex = list.findIndex((c) => c.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(list, oldIndex, newIndex)
    void handleReorderCategories(
      list,
      next.map((c) => c.id),
    )
  }

  return (
    <div className="space-y-3">
      <CategoryCreateForm
        userId={userId}
        onCreated={handleCreated}
        existingSortKeys={existingSortKeys}
      />

      {sortableEnabled ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleManagerDragEnd}
        >
          <SortableContext
            items={list.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-1">
              {list.map((category) => (
                <SortableCategoryRowWrapper
                  key={category.id}
                  category={category}
                  active={category.id === activeCategoryId}
                  onSelect={onSelectCategory}
                  onDelete={(c) => {
                    void handleDeleteRequest(c)
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
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
      )}

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
