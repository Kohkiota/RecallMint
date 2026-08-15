// exam-card-row-dnd — row DnD (dnd-kit) の UI 部品一式 (row-dnd sprint task-3
// spec §3.2〜§3.6 / §4.2)。
//
// この file 単体では **未配線**: SortableRow は TableBody (exam-card-table.tsx)
// からまだ呼ばれておらず、その使用開始は task-4。RowDragHandle は provider
// (RowDndContext) 不在時は null を描画する — この既定 (createContext(null)) により、
// task-3 完了時点でアプリの見た目は変化しない。
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
// RowDndContext — SortableRow (provider) → RowDragHandle (consumer) の橋渡し。
// select 列の cell (RowDragHandle) は <tr> (SortableRow) の子孫だが TanStack Table の
// flexRender 経由で render されるため、 listeners/attributes を prop drilling せず
// context で配る (category-list の wrapper 構造と違い、handle は tr の直接子ではない)。
// 既定 null = provider 不在時は handle が非描画になる (task-3 完了時点の視覚不変を保証)。
// ---------------------------------------------------------------------------

type RowDndValue = {
  listeners: DraggableSyntheticListeners
  attributes: DraggableAttributes
  setActivatorNodeRef: (el: HTMLElement | null) => void
  showHandle: boolean
  locked: boolean
  pending: boolean
  lockedReasonId: string
}

const RowDndContext = createContext<RowDndValue | null>(null)

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
  showHandle,
  locked,
  pending,
  lockedReasonId,
  measureElement,
  children,
}: {
  cardId: string
  index: number
  showHandle: boolean
  locked: boolean
  pending: boolean
  lockedReasonId: string
  measureElement: (node: Element | null) => void
  children: ReactNode
}) {
  // spec §3.2: 位置指定 gating (ソート/フィルタ中) と楽観 pending の両方を disabled に
  // 畳む。呼出側 (task-4) に同じ判定を重複させる別 prop は作らない。
  const disabled = locked || pending
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
    showHandle,
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
// RowDragHandle — select 列 (exam-card-table-columns.tsx) の checkbox 手前に置く
// 掴み手。 listeners/attributes/touch-none は **この button のみ**に付与する
// (tr / checkbox / 「カードを開く」/ 行メニューには付けない — event 分離契約)。
// ---------------------------------------------------------------------------

export function RowDragHandle({ cardTitle }: { cardTitle: string }) {
  const ctx = useContext(RowDndContext)
  // provider 不在 (task-4 配線前) または showHandle=false は非描画。
  if (!ctx || !ctx.showHandle) return null

  const { listeners, attributes, setActivatorNodeRef, locked, pending, lockedReasonId } = ctx
  const disabled = locked || pending

  // dnd-kit の attributes は自前の aria-describedby (SR 向け操作説明要素の id) を
  // **既に持つ** (`node_modules/@dnd-kit/core/dist/core.esm.js:3432-3439` の
  // `ariaDescribedById.draggable`)。 {...attributes} の後に素朴に
  // `aria-describedby={lockedReasonId}` を書くと dnd-kit 側の id が消え、 逆順に書くと
  // spread がこちらを上書きして消す — どちらの素朴な順序も片方の id を破壊する。
  // 両者を空白区切りで明示的に合成する (2026-08-15 OT 承認修正)。 locked でなければ
  // dnd-kit 側の id だけが残る。
  const describedBy = [attributes['aria-describedby'], locked ? lockedReasonId : null]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...listeners}
      {...attributes}
      aria-describedby={describedBy || undefined}
      disabled={disabled}
      title={locked ? ROW_DND_LOCKED_REASON : undefined}
      aria-label={`行を並べ替え: ${cardTitle}`}
      // select td 全域の onClick (行選択トグル) への bubbling を止める
      // (checkbox / 「カードを開く」/ 行メニューと同理由)。 td 側 handler は onClick のみ
      // (exam-card-table.tsx:218-220) のため、 click 経路の遮断だけで mouse / keyboard /
      // tap の全 activation 経路をカバーする。
      onClick={(e) => e.stopPropagation()}
      className="inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </button>
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
