// exam-card-row-dnd — row DnD (dnd-kit) の UI 部品一式 (row-dnd sprint task-3
// spec §3.2〜§3.6 / §4.2)。
//
// 掴み手 (grip) の component は **ここには無い**: row-ux spec §2.2 で「ドラッグ =
// 並べ替え / クリック = メニュー」の二役 button に統合され、実体は
// exam-card-row-menu.tsx の trigger になった。この file は provider (SortableRow) と
// consumer accessor (useRowDnd) と DragOverlay 用プレビューだけを持つ。
//
// 'use client' は付けない: 親 (exam-card-table-columns.tsx = 'use client') からのみ
// import される子。file 自体に付けると Next.js TS plugin が function 型 prop を
// Server Action として誤検出する (exam-card-row-menu.tsx と同 pattern・rule 71007)。

import { createContext, useCallback, useContext, type CSSProperties, type ReactNode } from 'react'
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ClientCard } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// RowDndContext — SortableRow (provider) → grip (consumer) の橋渡し。
// select 列の cell (grip = ExamCardRowMenu の trigger) は <tr> (SortableRow) の子孫だが
// TanStack Table の flexRender 経由で render されるため、 listeners/attributes を
// prop drilling せず context で配る (category-list の wrapper 構造と違い、grip は tr の
// 直接子ではない)。 既定 null = provider 不在 (単体 harness) では grip が menu 専用になる。
// ---------------------------------------------------------------------------

type RowDndValue = {
  listeners: DraggableSyntheticListeners
  attributes: DraggableAttributes
  setActivatorNodeRef: (el: HTMLElement | null) => void
  /** この試験で並べ替えが意味を持つか (基準順全件 >= 2 — 「今できるか」ではない)。 */
  dragAvailable: boolean
  locked: boolean
  pending: boolean
  lockedReasonId: string
}

const RowDndContext = createContext<RowDndValue | null>(null)

/**
 * grip (exam-card-row-menu.tsx) が SortableRow の DnD 値を取る唯一の口。
 * provider 不在 (単体 harness) は null = ドラッグ役なしの menu 専用 trigger。
 */
export function useRowDnd(): RowDndValue | null {
  return useContext(RowDndContext)
}

// ソート/フィルタ適用中の並べ替え不能理由 (spec §7.4 と同型の gating 文言)。
export const ROW_DND_LOCKED_REASON =
  'ソート/フィルタ適用中は並べ替えできません(解除すると並べ替えられます)'

// ---------------------------------------------------------------------------
// SortableRow — 現行 TableBody の <tr> (exam-card-table.tsx:190-196) の verbatim
// 移送 + drag 用の属性を足したもの。
// ---------------------------------------------------------------------------

export function SortableRow({
  cardId,
  index,
  dragAvailable,
  locked,
  pending,
  lockedReasonId,
  measureElement,
  children,
}: {
  cardId: string
  index: number
  dragAvailable: boolean
  locked: boolean
  pending: boolean
  lockedReasonId: string
  measureElement: (node: Element | null) => void
  children: ReactNode
}) {
  // spec §3.2 + row-ux §4: 位置指定 gating (ソート/フィルタ中)・楽観 pending・並べ替えが
  // 意味を持たない試験 (1 枚) の 3 つを disabled に畳む。 grip は描画され続けるので
  // (menu 役)、 ドラッグ役の無効化はここ 1 箇所 = dnd-kit が listeners を undefined で
  // 返す形に一本化する。
  const disabled = locked || pending || !dragAvailable
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cardId, disabled })

  // spec §3.2 (OT 承認 ③): <tr> には dnd-kit の setNodeRef と TanStack Virtual の
  // measureElement の 2 つを付ける必要がある。inline arrow (`(el) => { setNodeRef(el); measureElement(el) }`)
  // は毎 render で新しい関数 identity になり、 React は古い ref を null 呼出→新 ref を
  // node 呼出する detach/attach を **毎 render** 発生させる。 measureElement 内部は
  // ResizeObserver.observe/unobserve を呼ぶため、 これが毎 render 走ると監視の張り直しが
  // 恒久的に続く。 useCallback で identity を [setNodeRef, measureElement] に固定し、
  // 依存が変わらない限り同一 ref 関数を保つ。
  const setRefs = useCallback(
    (node: HTMLTableRowElement | null) => {
      setNodeRef(node)
      measureElement(node)
    },
    [setNodeRef, measureElement],
  )

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const contextValue: RowDndValue = {
    listeners,
    attributes,
    setActivatorNodeRef,
    dragAvailable,
    locked,
    pending,
    lockedReasonId,
  }

  return (
    <tr
      data-index={index}
      ref={setRefs}
      data-testid={`row-${cardId}`}
      className={cn('group hover:bg-muted/50', isDragging && 'opacity-50')}
      style={style}
    >
      <RowDndContext.Provider value={contextValue}>{children}</RowDndContext.Provider>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// RowDragPreview — DragOverlay に出す簡素なプレビュー (table row を再現しない)。
// ---------------------------------------------------------------------------

const TITLE_PREVIEW_MAX = 40

function truncateTitle(title: string): string {
  return title.length > TITLE_PREVIEW_MAX ? `${title.slice(0, TITLE_PREVIEW_MAX)}…` : title
}

export function RowDragPreview({ card }: { card: ClientCard }) {
  // 番号 (question_label・あれば) と タイトル (先頭 40 字) の**両方**を並記する。
  // `card.question_label ?? card.title` のような片方だけを出す fallback は
  // kickoff 決定 3「番号・タイトルを示す」からずれる (両方揃っているのに片方しか
  // 見えなくなる)。
  const label = card.question_label?.trim()
  const title = card.title.trim()
  const parts = [label, title.length > 0 ? truncateTitle(title) : null].filter(
    (part): part is string => Boolean(part && part.length > 0),
  )
  const text = parts.length > 0 ? parts.join(' ') : '(無題)'

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 shadow-md">
      <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate text-sm">{text}</span>
    </div>
  )
}
