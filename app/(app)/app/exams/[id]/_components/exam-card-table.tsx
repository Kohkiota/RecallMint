'use client'

// ---------------------------------------------------------------------------
// S2b-1: computeCollapsed — scroll 閾値 / hysteresis / 短コンテンツ guard の純関数。
// jsdom は scroll 計算不可のため、この関数を export して直接 unit test する。
//
//   scrollTop < 8                         → false (expand)
//   scrollTop > 24 AND guard >= 8         → true  (collapse)
//   それ以外 (8 ≤ scrollTop ≤ 24)         → current (hysteresis)
//
// guard = scrollHeight - clientHeight - middleBandHeight >= 8
//   middleBandHeight: collapse 対象帯高合計(chrome + condBarWrapper の実測 offsetHeight)
//   理由: collapse すると clientHeight が middleBandHeight ぶん増加し、
//         maxScroll が同量減る。guard がないと scrollTop がclamp されて
//         expand 条件を即満たす「一往復ちらつき」が発生する。
// ---------------------------------------------------------------------------
export function computeCollapsed(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  middleBandHeight: number,
  current: boolean,
): boolean {
  if (scrollTop < 8) return false
  if (scrollTop > 24 && scrollHeight - clientHeight - middleBandHeight >= 8) return true
  return current
}

// ExamCardTable — TanStack Table 最小構成。
// 案 X-A: ExamCardTable 内で独自 useLiveQuery を呼ぶ (InlineCardList と subscription を共有しない)。
// view='table' 時のみ mount (OQ-5 案 S-A / conditional unmount) されるため、
// 同時刻に 1 subscription のみ = spec §9 の「二重 subscription にしない」を構造的に保証。
//
// OQ-3 案 J-A: join シェイプ = flat array { card, tags: { category, option }[] }。
// join は useLiveQuery 解決時に 1 回、useMemo で ref 安定化 (TanStack 参照不安定対策の核)。
//
// Grid-1 T6:
//   - useCardTagToggle を table レベルで 1 回 instantiate (OT 制約 2)。
//   - tagEditCallbacks も table レベルで 1 回構築 (案 EC-A)。
//   - 両者を meta 経由で各 TagCell に配る (TanStack 標準 pattern)。

import {
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
  memo,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type RowSelectionState,
  type SortingState,
  type ColumnFiltersState,
  type ColumnSizingState,
  type VisibilityState,
  type ColumnPinningState,
  type OnChangeFn,
  type Table,
} from '@tanstack/react-table'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ActionToast } from '@/components/ui/action-toast'
import { Button } from '@/components/ui/button'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { compareByBaseOrder, placementForRowDrop, type MovePlacement } from '@/lib/cards/domain/card-order'
import { useSortableSensors, type SortableSensorOptions } from '@/lib/dnd/use-sortable-sensors'
import { buildJaAnnouncements, ROW_DND_SR_INSTRUCTIONS } from '@/lib/dnd/accessibility'
import { restrictToVerticalAxis } from '@/lib/dnd/restrict-to-vertical-axis'
import { examCardTableColumns, type ExamCardRow, type ExamCardTableMeta } from './exam-card-table-columns'
import { joinCardTags } from '@/lib/cards/join-card-tags'
import { ColumnHeaderMenu } from './exam-card-table-header-menu'
import { SortableRow, RowDragPreview, ROW_DND_LOCKED_REASON } from './exam-card-row-dnd'
import { computePinnedLeft, derivePinnedBoundary } from '../_lib/column-pinning'
import { waitForExamInMirror } from '../_lib/wait-for-exam-mirror'
import { ConditionBar } from './exam-card-table-condition-bar'
import { cardTableFilterEditors } from './exam-card-table-filter-editors'
import { ExamCardTableActionBar } from './exam-card-table-action-bar'
import { ExamCardSidePeek } from './exam-card-side-peek'
import { createExam } from '../../_actions/create-exam'
import { runGuardedPull } from '@/lib/sync/pull'
import type { MoveDispatchOutcome } from './exam-card-move-popover'
import { cardLabel } from './exam-card-row-menu'
import { useCardTagToggle } from '../_hooks/use-card-tag-toggle'
import { useBulkCardTags, type BulkResult, type BulkTagOp } from '../_hooks/use-bulk-card-tags'
import { useBulkCardDelete } from '../_hooks/use-bulk-card-delete'
import { useMoveCards, type MoveResult } from '../../_hooks/use-move-cards'
import {
  handleRenameCategory,
  handleSetCategoryColor,
  handleDeleteCategory,
  handleRenameOption,
  handleSetOptionColor,
  handleDeleteOption,
  countCategoryImpact,
  countOptionImpact,
  handleCreateCategory,
  createOption,
  type TagEditCallbacks,
} from '@/lib/tags/tag-crud'

// ---------------------------------------------------------------------------
// Fix-3 T1: TableBody / MemoizedTableBody (module スコープ — component 外で定義し
//   React.memo が正しく機能するようにする。component 内定義だと毎 render で
//   関数参照が変わり memo が無意味になる)。
// ---------------------------------------------------------------------------

type TableBodyProps = {
  table: Table<ExamCardRow>
  isResizing: boolean
  // S2-2: 内部スクロール container (tableContainerRef) を getScrollElement に渡すための ref。
  //   element virtualizer は container.scrollTop を offset 原点とする。 旧 window 実装が
  //   scrollMargin=listOffset(document 座標)で container 先頭へ re-base していたのと同一の
  //   基準を、 element 実装では container 自身が原点 = scrollMargin 0 で満たす (下記参照)。
  scrollElementRef: RefObject<HTMLDivElement | null>
  // row-dnd task-4: SortableRow (spec §3.2 gating) へそのまま配る 3 値。
  //   dragAvailable は table.getRowModel().rows (filter 後) ではなく **基準順全件 (data.length)**
  //   由来 (ExamCardTable 側で算出) — これは「この試験で並べ替えが意味を持つか」(カード
  //   1 件の試験は絶対に並べ替えられない) を問う判定で、「今この瞬間許可されているか」
  //   (= positionLocked、フィルタ適用中は disabled) とは別の関心事。表示行数で判定すると
  //   フィルタの絞り込みに応じてドラッグ可否が出たり消えたりしてしまい、理由表示
  //   (spec D-c) より悪い挙動になる。
  dragAvailable: boolean
  locked: boolean
  pending: boolean
  lockedReasonId: string
}

// Fix-3 T2: 推定行高 (px)。実行高の中央値目安。過小でも measureElement が補正する。
const ESTIMATED_ROW_HEIGHT = 120

// row-ux §3: 行 DnD だけ sensor の起動条件を変える (グリップが「ドラッグ = 並べ替え /
// クリック = メニュー」の二役のため)。
//   - mouse: 4px 超で初めて起動 = しきい値以下の押下は native click として menu に届く
//     (dnd-kit は activation しなかった押下に click 抑止を張らない)。 tolerance は付けない
//     (超過で handleCancel に落ちるため)。
//   - keyboard: Enter を start から外し menu 用に残す。 Space が掴む / 離す、 Escape が取消。
// useSensor は options の参照で memo するため module スコープ定数にする (毎 render の
// object literal だと memo が毎回無効化される — use-sortable-sensors.ts の安定参照規律)。
const ROW_DND_SENSOR_OPTIONS: SortableSensorOptions = {
  mouseActivationConstraint: { distance: 4 },
  keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] },
}

function TableBody({
  table,
  scrollElementRef,
  dragAvailable,
  locked,
  pending,
  lockedReasonId,
}: TableBodyProps) {
  const rows = table.getRowModel().rows

  // S2-2: 行仮想化を element virtualizer 化 (内部スクロール container が縦スクロール主体)。
  //   getScrollElement=tableContainerRef で container.scrollTop を offset 原点にする。
  //   scrollMargin は既定 0: element scroll では container 先頭 (= table/thead 先頭) が原点で、
  //   これは旧 window 実装の scrollMargin=listOffset(container の document 座標)が re-base して
  //   いた基準と一致する (list 位置は両者とも「container 先頭」相対)。 thead 高分の微小差は
  //   overscan=5 が吸収する (旧実装も同一挙動)。 実挙動は stg 300-card smoke で締める。
  //   getItemKey=card.id で sort/filter 並び替え時の index-key churn を防ぐ (getRowId 一致)。
  //   measureElement は各実行 <tr> に付与し dynamic 行高を測る (estimateSize の補正)。
  //   observeElementRect / observeElementOffset は default (明示指定しない)。
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual の useVirtualizer は React Compiler 非対応 API だが、TanStack 側の既知 tradeoff であり抑止が推奨方針 (useReactTable と同扱い)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => rows[index].id,
    overscan: 5,
    useFlushSync: false,
  })

  // Fix-3 T2: resize commit 後に幅変更後の行高を測り直す。
  //   resize 中は memo 凍結で body が再 render されないため、この effect は
  //   commit で columnSizing が確定した後の再 render で 1 回だけ走る (onChange の
  //   中間値では走らない = 凍結が保証)。
  const columnSizing = table.getState().columnSizing
  useEffect(() => {
    rowVirtualizer.measure()
  }, [columnSizing, rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()
  const visibleColCount = table.getVisibleLeafColumns().length
  // spacer 高を算出。 element virtualizer では scrollMargin=0 のため start/end は
  //   container 先頭相対 (= 実質そのまま)。 options.scrollMargin 参照を残すのは
  //   将来 scrollMargin を再定義しても式が破綻しないため (現状は 0)。
  // virtualItems が空の場合 (filter で 0 件 / data 未ロード) は spacer を出さない。
  // 空時に素直に計算すると paddingBottom = totalSize (+scrollMargin) の余白スペーサーが
  // 誤描画されるため、0 に固定する (件数境界 0 件の phantom spacer 回帰防止)。
  const hasItems = virtualItems.length > 0
  const paddingTop = hasItems
    ? virtualItems[0].start - rowVirtualizer.options.scrollMargin
    : 0
  const paddingBottom = hasItems
    ? totalSize -
      (virtualItems[virtualItems.length - 1].end -
        rowVirtualizer.options.scrollMargin)
    : 0

  return (
    <tbody>
      {paddingTop > 0 && (
        <tr aria-hidden>
          <td
            colSpan={visibleColCount}
            style={{ height: paddingTop, padding: 0, border: 0 }}
          />
        </tr>
      )}
      {virtualItems.map((vi) => {
        const row = rows[vi.index]
        return (
          // S5-3: group を付与し、pinned td の group-hover 色合成を有効化(spec D-5)。
          // pinning なし時も group は inert(group-hover 子が存在しない)で視覚変化なし。
          // row-dnd task-4: <tr> 自体は SortableRow (exam-card-row-dnd.tsx) が描画する
          // (data-testid / data-index / measureElement ref 合成もそちら側に移った・verbatim 移送)。
          <SortableRow
            key={row.id}
            cardId={row.original.card.id}
            index={vi.index}
            dragAvailable={dragAvailable}
            locked={locked}
            pending={pending}
            lockedReasonId={lockedReasonId}
            measureElement={rowVirtualizer.measureElement}
          >
            {row.getVisibleCells().map((cell) => {
              // S5-3: left-pinned 判定。
              const isPinnedCell = cell.column.getIsPinned() === 'left'
              // S5-3: 最右可視 pinned 列にセパレータ border-r を付与(spec D-6・visible-leaf 基準)。
              const isLastPinnedCell = isPinnedCell && cell.column.getIsLastColumn('left')
              return (
                <td
                  key={cell.id}
                  // T3: border-b を td に付与 (border-separate では tr border-b は効かない)。
                  // align-top: 全列一律で上揃え (長文セルで頭を揃える。既定 middle からの変更)。
                  // select 列のみ text-center でチェックボックスを水平中央に揃える。
                  // B: select td 全域をクリック領域化 (cursor-pointer + onClick で選択トグル)。
                  //    checkbox 直 click は input 側 stopPropagation で二重発火を防ぐ (net no-op 回避)。
                  // S5-3: pinned td = sticky z-[1] + 不透過背景(下を通過するセルの透け防止)。
                  // group-hover: 非 pinned の hover:bg-muted/50(半透明)と同色の不透過合成色(spec D-5)。
                  className={cn(
                    'px-1 py-1 border-b border-border align-top',
                    cell.column.id === 'select' && 'text-center cursor-pointer',
                    isPinnedCell && 'sticky z-[1] bg-background group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]',
                    isLastPinnedCell && 'border-r',
                  )}
                  onClick={
                    cell.column.id === 'select' ? () => row.toggleSelected() : undefined
                  }
                  // Fix-3 T1: CSS 変数参照。resize 中は tbody が memo 凍結されているが
                  //   <table> 上の CSS 変数が更新されるため視覚幅はリアルタイムに追従する。
                  // S5-3: pinned td の left offset は CSS 変数参照(resize 中も追従・spec D-5)。
                  style={{
                    width: `calc(var(--col-${cell.column.id}-size) * 1px)`,
                    ...(isPinnedCell && { left: `calc(var(--col-${cell.column.id}-start) * 1px)` }),
                  }}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              )
            })}
          </SortableRow>
        )
      })}
      {paddingBottom > 0 && (
        <tr aria-hidden>
          <td
            colSpan={visibleColCount}
            style={{ height: paddingBottom, padding: 0, border: 0 }}
          />
        </tr>
      )}
    </tbody>
  )
}

// Fix-3 T1.1: 単一型 + isResizing comparator で remount リーク根治。
//   isResizing=true の間は tbody を凍結(再レンダーをスキップ)し CSS 変数のみ更新される。
//   isResizing=false の間は通常再レンダーで data/tag 変更への反応性を維持する。
//   落とし穴: data===data 比較は useReactTable が同一 mutated instance を返すため常に true
//   → 非 resize 中も永久 skip → rows 不更新になる。comparator は next.isResizing 単独が正。
const MemoizedTableBody = memo(
  TableBody,
  (_prev, next) => next.isResizing,
)

// ---------------------------------------------------------------------------
// Grid-3 §7.1 / §7.5: 移動の文言。 useMoveCards の失敗表現をそのまま UI 文言へ写す。
// ---------------------------------------------------------------------------

// tx 失敗 (reject)。 all-or-nothing なので「移動していない」と言い切れる。
const MOVE_FAILED_MESSAGE = '移動に失敗しました。しばらくしてから再度お試しください。'
// mutation 未発行 (mirror に移動先 exam が無い / 他 user のもの)。
const MOVE_TARGET_MISSING_MESSAGE = '移動先の試験が見つかりません。選び直してください。'
// 切り出し (b) で自動作成する exam 名 (spec §6.1)。
const SPLIT_OUT_EXAM_NAME = '無題の試験'
// createExam が failure / reject で返った場合の inline 文言 (server action の failure 文体)。
const SPLIT_OUT_FAILED_MESSAGE =
  '試験の作成に失敗しました。しばらくしてから再度お試しください。'
// 作成した exam が mirror に届かないまま移動を試みた場合 (pull skip / pull 失敗)。
// 汎用の「移動先の試験が見つかりません。選び直してください」は切り出しでは意味を
// 成さない (ユーザーは移動先を選んでいない) ため、この経路だけ差し替える。
const SPLIT_OUT_NOT_SYNCED_MESSAGE =
  '作成した試験の同期が終わっていません。しばらくしてから再度お試しください。'
// pull が走ったのに移動先が居ない = 作成した exam が削除されている (別端末等)。
// 「同期待ち」ではないので案内を分ける (次のクリックは新しい exam を作り直す)。
const SPLIT_OUT_TARGET_GONE_MESSAGE =
  '切り出し先の試験が見つかりません。もう一度お試しください。'
// undo が発行できなかった理由 → 文言 (spec §5.4)。
const UNDO_FAILURE_MESSAGE = {
  'source-exam-missing': '元の試験が削除されています',
  'cards-missing': '移動したカードの一部が削除されています',
} as const
const UNDO_FAILED_MESSAGE = '元に戻せませんでした。しばらくしてから再度お試しください。'

type MoveSuccess = MoveResult & { ok: true }
// 単一 slot の toast state。 id は key に渡し、 同一文言の連続表示でも remount させる
// (ActionToast の契約: message 同値だと auto-dismiss timer が再カウントされない)。
type MoveToastState = { id: number; message: string; undo?: MoveSuccess }

type ExamCardTableProps = {
  examId: string
  userId: string
  // S2-5: columnVisibility は controlled prop。 state 所有 + examViewPrefs 永続は
  // exam-detail-view.tsx が単一所有する (内部 useState / mount-load / persist effect は撤去)。
  columnVisibility: VisibilityState
  onColumnVisibilityChange: OnChangeFn<VisibilityState>
  // S5-2: columnPinning は controlled prop (handleColumnVisibilityChange と同型)。
  // state 所有 + examViewPrefs V3 永続は exam-detail-view が単一所有する。
  columnPinning: ColumnPinningState
  onColumnPinningChange: OnChangeFn<ColumnPinningState>
  // S2b-1: scroll → collapsed 信号を exam-detail-view に通知し table-chrome を collapse。
  onCollapsedChange?: (collapsed: boolean) => void
  // S2b-1: table-chrome の高さを実測するための ref (短コンテンツ guard 用)。
  // exam-detail-view が table-chrome 外側 wrapper の ref を渡す。
  chromeRef?: RefObject<HTMLElement | null>
}

export function ExamCardTable({
  examId,
  userId,
  columnVisibility,
  onColumnVisibilityChange,
  columnPinning,
  onColumnPinningChange,
  onCollapsedChange,
  chromeRef,
}: ExamCardTableProps) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  // 初期ソート: 空配列 = compareByBaseOrder pre-sort (liveData:232) が連番順を担保するため不要。
  // ソートを全削除した時も自然に連番順へ戻る(バーシュリンクとも整合)。
  const [sorting, setSorting] = useState<SortingState>([])
  // Grid-2 T3: columnFilters は非永続 (examViewPrefs に保存しない、 リロードで初期化)。
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  // T3: columnSizing は非永続 (examViewPrefs / sync_meta に書かない、 リロードで初期化)。
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})

  // side peek: 現在 open 中のカード id。rowSelection と用途直交・examViewPrefs 非永続。
  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  // 同一 id 再 click で close(toggle)、別 id click で切替。
  const openCard = useCallback(
    (id: string) => setActiveCardId((prev) => (prev === id ? null : id)),
    [],
  )
  // peek 閉じる。毎 render で新しい arrow を作らないよう安定化(ExamCardSidePeek に渡す)。
  const handleClosePeek = useCallback(() => setActiveCardId(null), [])

  // S2b-1: 中間帯 collapse 状態。初期 false — remount 時は常に false から再出発。
  const [collapsed, setCollapsed] = useState(false)
  // ref で最新値を保持(rAF callback の stale closure 防止)。
  const collapsedRef = useRef(false)
  // ConditionBar wrapper の高さ実測用 ref(短コンテンツ guard)。
  const condBarWrapperRef = useRef<HTMLDivElement>(null)
  // rAF キャンセル用 id。
  const rafIdRef = useRef(0)

  // useLiveQuery: 案 X-A。 4 store (cards / tag_categories / tag_options / card_tags) を
  // 1 subscription で一括 pull。 InlineCardList の useLiveQuery と同パターンを踏襲
  // (T-B5 最適化: card_tags は filteredCards の card_id 集合だけに絞って fetch)。
  // view='table' 時のみ mount されるため、 view='card' 時は InlineCardList の subscription
  // のみが生存 = 同時刻に 2 subscription にならない (OQ-5 案 S-A で構造的に保証)。
  const liveData = useLiveQuery(async () => {
    const db = getClientDb()
    const [cardRows, categories, options] = await Promise.all([
      db.cards.where('exam_id').equals(examId).toArray(),
      db.tag_categories.toArray(),
      db.tag_options.toArray(),
    ])
    const filteredCards = cardRows
      .filter((c) => c.user_id === userId)
      .sort(compareByBaseOrder)
    const pageCardIds = filteredCards.map((c) => c.id)
    const cardTags =
      pageCardIds.length === 0
        ? []
        : await db.card_tags.where('card_id').anyOf(pageCardIds).toArray()
    return { filteredCards, categories, options, cardTags }
  }, [examId, userId])

  // join (OQ-3 案 J-A): useLiveQuery 解決時に 1 回 join + useMemo で ref 安定化。
  // data prop ref が不安定だと TanStack 参照不安定で再描画暴発するため、
  // useMemo は smoke ③ 対策の核。 deps = liveData (オブジェクト ref) で
  // 同じオブジェクト ref ならキャッシュ再利用 = 余分な TanStack 更新なし。
  const data = useMemo<ExamCardRow[]>(() => {
    if (!liveData) return []
    const { filteredCards, categories, options, cardTags } = liveData
    return joinCardTags(filteredCards, cardTags, categories, options)
  }, [liveData])

  // activeRow: columnFilters 非依存で data 全件から引く(spec §3.4)。
  // activeCardId が null の場合は null を返す(peek 非表示)。
  const activeRow = activeCardId ? data.find((r) => r.card.id === activeCardId) ?? null : null

  // activeCardTags: liveData から activeCardId のタグのみ絞り込む。
  const activeCardTags = useMemo(
    () =>
      activeCardId && liveData
        ? liveData.cardTags.filter((ct) => ct.card_id === activeCardId)
        : [],
    [liveData, activeCardId],
  )

  // prune: data からカードが消えた時(削除・exam 移動)のみ close。
  // columnFilters で行が非表示になっても data は全件のため prune しない(spec §3.6)。
  useEffect(() => {
    if (activeCardId !== null && activeRow === null) setActiveCardId(null)
  }, [activeCardId, activeRow])

  // Grid-1 T6: useCardTagToggle を table レベルで 1 回 instantiate (OT 制約 2)。
  // getCardContext は liveData から card ごとの context を返す getter pattern (OT 制約 1:
  // hook 内で useLiveQuery を呼ばない)。 inline arrow は latest-ref pattern で安定化済。
  const getCardContext = useCallback(
    (cardId: string) => {
      if (!liveData) return undefined
      const cardTagsForCard = liveData.cardTags.filter((ct) => ct.card_id === cardId)
      return {
        categories: liveData.categories,
        options: liveData.options,
        allAssignedOptionIds: cardTagsForCard.map((ct) => ct.option_id),
      }
    },
    [liveData],
  )

  const toggle = useCardTagToggle({ userId, getCardContext })

  // Grid-2 T6: bulk helper を table レベルで 1 回 instantiate。
  // getCardTags は単票 getCardContext と同 shape (T4 が想定する getter) なので流用。
  const bulkTag = useBulkCardTags({ userId, getCardTags: getCardContext })
  const bulkDelete = useBulkCardDelete({ userId })
  // 失敗 UI 用 state (BF-2 inline)。 atomic all-or-nothing の結果を保持。
  const [lastBulkResult, setLastBulkResult] = useState<{
    op: string
    result: BulkResult
  } | null>(null)

  // Grid-1 T6 案 EC-A: tagEditCallbacks を table レベルで 1 回構築。
  // module スコープ handler (rename/color/delete/count) は import で共有。
  // create 系は userId / liveData を bind した useCallback closure。
  // ExamCardTable は per-row cardId を tagEditCallbacks に bind できないため、
  // createOptionAndAssign は TagCell の onToggle callback が行うので不要に見えるが、
  // CardTagAddPopover の createOptionAndAssign 経路 (option 新規作成) は popover 内で
  // selectedCategoryId + input name を取り、 onToggle ではなく tagEditCallbacks.createOptionAndAssign
  // を呼ぶ設計 (card-tags-section.tsx L541-558 参照)。 そのため cardId を bind した closure が必要。
  //
  // ここでは per-card の cardId は取得できないため、 createOptionAndAssign に cardId を
  // 渡す経路は TagCell 経由の sharedPopoverProps.onToggle 内で行う (TagCell 実装参照)。
  // tagEditCallbacks.createOptionAndAssign は fallback として no-op にはせず、
  // TagCell が cardId=row.original.card.id を閉じ込めた onToggle を渡す設計になっている。
  //
  // 問題: tagEditCallbacks.createOptionAndAssign は cardId をどこから取るか。
  // TagCell で sharedPopoverProps.onToggle は (categoryId, optionId) のため、
  // createOptionAndAssign の cardId は TagCell スコープで bind する必要がある。
  // ExamCardTable ではテーブル全体で 1 つの tagEditCallbacks を構築しているが、
  // createOptionAndAssign だけは per-row で closure が異なる。
  //
  // 解決: tagEditCallbacks.createOptionAndAssign は「最後に render された行」の cardId を
  // 使う実装ではなく、 TagCell 側で cardId-bound な createOptionAndAssign を構築し
  // tagEditCallbacks を上書きして渡す方式にする。 具体的には TagCell が受け取った
  // tagEditCallbacks を spread し createOptionAndAssign だけ cardId-bound に差し替える。
  // ExamCardTable では createOptionAndAssign の placeholder として渡し、 TagCell 側で override。
  //
  // placeholder: 空関数 (型を満たすが実際は TagCell 側で override される)。
  const createCategory = useCallback(
    (name: string, selectType: 'single' | 'multi') =>
      handleCreateCategory(
        userId,
        liveData?.categories ?? [],
        name,
        selectType,
      ),
    [userId, liveData?.categories],
  )

  // createOptionAndAssign は base では省略する (TagEditCallbacks で optional)。
  // 実経路では TagCell が cardId-bound closure を、ActionBar が bulk 版を必ず override
  // するため、popover には常に定義済みの createOptionAndAssign が届く。
  const tagEditCallbacks: TagEditCallbacks = useMemo(
    () => ({
      renameCategory: (categoryId: string, newName: string) =>
        handleRenameCategory(userId, categoryId, newName),
      setCategoryColor: (categoryId: string, color: string | null) =>
        handleSetCategoryColor(userId, categoryId, color),
      deleteCategory: (categoryId: string) => handleDeleteCategory(userId, categoryId),
      renameOption: (optionId: string, newName: string) =>
        handleRenameOption(userId, optionId, newName),
      setOptionColor: (optionId: string, color: string | null) =>
        handleSetOptionColor(userId, optionId, color),
      deleteOption: (optionId: string) => handleDeleteOption(userId, optionId),
      countCategoryImpact,
      countOptionImpact,
      createCategory,
    }),
    [userId, createCategory],
  )

  // Grid-3 §7.1 / §7.2: 移動の実行核。 **table instance より前** に置く必要がある —
  // 行メニュー (c) の dispatch は meta 経由で cell に配るため、useReactTable の引数を
  // 組み立てる時点で束縛済みでなければならない (選択行に依存する onMove / onSplitOut は
  // selectedIds が要るので table の後に残す)。
  //
  // toast state を **table が持つ** のが要件: 移動が成功すると対象 card が現 exam から
  // 消え → prune effect で selection が空 → action bar が unmount するため、 bar 配下に
  // 置くと成功 toast (= undo 素材) が即座に消える。 失敗時は移動していない = 選択が
  // 残るので inline error は bar 側で良い。
  const { moveCards, undoMove } = useMoveCards({ userId })
  const [moveToast, setMoveToast] = useState<MoveToastState | null>(null)
  const [undoPending, setUndoPending] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  // 実行中 flag と「切り出しで作った exam」は **popover の外** に置く: popover は
  // close で unmount されるため、中に持つと閉じ→開きで消えて二重 submit できてしまう。
  const [movePending, setMovePending] = useState(false)
  // 切り出しで作成済みだが移動が成立しなかった exam の id。次の切り出しは createExam を
  // 飛ばしてこれを再利用する (失敗のたびに空の「無題の試験」が増えるのを防ぐ)。
  // 移動が成立した時点で手放す。
  const splitExamIdRef = useRef<string | null>(null)
  // 切り出しの再入ガード (同期)。詳細は onSplitOut 冒頭。
  const splitInFlightRef = useRef(false)
  const toastSeqRef = useRef(0)

  // ソート/フィルタ適用中は位置指定を禁じる (spec §7.4)。 一括バーの「直後」と
  // 行メニュー項目の両方が同じ判定を使う。
  const positionLocked = sorting.length > 0 || columnFilters.length > 0

  const showMoveToast = useCallback((message: string, undo?: MoveSuccess) => {
    toastSeqRef.current += 1
    setMoveToast({ id: toastSeqRef.current, message, undo })
  }, [])

  // 移動の実行と結果の解釈 (成功 toast / 失敗 3 分岐 → 文言) を 1 箇所に置く。
  // error の **表示先** は入口ごとに違う (一括バー = inline error 枠 / 行メニュー =
  // picker dialog 内。行メニューは選択ゼロでも開けるため bar が mount されていない)
  // ので、ここでは文言を返すだけにして表示は呼出側に委ねる。
  const runMove = useCallback(
    async (
      cardIds: string[],
      targetExamId: string,
      placement: MovePlacement,
    ): Promise<{ outcome: MoveDispatchOutcome; message: string | null }> => {
      try {
        const result = await moveCards({ cardIds, targetExamId, placement })
        if (result.ok) {
          showMoveToast(`${result.movedCount}枚を移動しました`, result)
          return { outcome: 'moved', message: null }
        }
        switch (result.reason) {
          // no-cards = mirror に対象が 1 枚も無い no-op。 error でも toast でもない
          // (useMoveCards の契約: mutation を発行していない)。
          case 'no-cards':
            return { outcome: 'no-cards', message: null }
          case 'target-exam-missing':
            return {
              outcome: 'target-exam-missing',
              message: MOVE_TARGET_MISSING_MESSAGE,
            }
          // 未知の理由が増えたときに silent な no-op へ倒れないよう error 側で受ける。
          default:
            return { outcome: 'failed', message: MOVE_FAILED_MESSAGE }
        }
      } catch {
        // tx 失敗は reject で来る (throwOnError: true)。 部分適用はない。
        return { outcome: 'failed', message: MOVE_FAILED_MESSAGE }
      }
    },
    [moveCards, showMoveToast],
  )

  // 一括バー (a) / 切り出し (b) 用の dispatch。 失敗文言は bar の inline error 枠に出す。
  const dispatchMove = useCallback(
    async (
      cardIds: string[],
      targetExamId: string,
      placement: MovePlacement,
    ): Promise<MoveDispatchOutcome> => {
      setMoveError(null)
      const { outcome, message } = await runMove(cardIds, targetExamId, placement)
      if (message !== null) setMoveError(message)
      return outcome
    },
    [runMove],
  )

  // 行メニュー「ここに取り込む」 (c) の dispatch (spec §7.2)。 取り込み先は常に現 exam、
  // 位置は行 card の直後。 失敗文言は返り値で picker に渡す (bar の枠は使えない)。
  // 実行中 flag は (a)(b) と同じ movePending を共有する — 移動は同時に 1 つだけ走る扱いにし、
  // picker の確定 button も一括バーの実行系 button も同じ flag で塞ぐ。
  const onPullInto = useCallback(
    async (cardIds: string[], anchorId: string): Promise<string | null> => {
      setMovePending(true)
      try {
        const { message } = await runMove(cardIds, examId, { kind: 'after', anchorId })
        return message
      } finally {
        setMovePending(false)
      }
    },
    [runMove, examId],
  )

  // TanStack table instance。 columns は module スコープ参照 (再採番なし)。
  // enableRowSelection: true + getRowId で card.id を row id とする。
  // rowSelection は controlled state (useState) で持つ。
  // meta に toggle / tagEditCallbacks / categories / options を渡し、
  // TagCell が cell render 時に table.options.meta 経由でアクセスする (TanStack 標準 pattern)。
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table の useReactTable は React Compiler 非対応 API だが、TanStack 側の既知 tradeoff であり抑止が推奨方針
  const table = useReactTable<ExamCardRow>({
    data,
    columns: examCardTableColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    getRowId: (row) => row.card.id,
    // T3: column resizing (非永続 — columnSizing は useState のみ、 examViewPrefs/sync_meta に書かない)。
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: { rowSelection, sorting, columnFilters, columnSizing, columnVisibility, columnPinning },
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: onColumnVisibilityChange,
    // S5-2: columnPinning controlled prop 配線 (既存 state と独立共存)。
    onColumnPinningChange: onColumnPinningChange,
    meta: {
      userId,
      toggle,
      tagEditCallbacks,
      categories: liveData?.categories ?? [],
      options: liveData?.options ?? [],
      openCard,
      // Grid-3 §7.2: 行メニュー「ここに取り込む」。 examId / gating / dispatch は行に依らず
      // 同一なので meta で 1 回配り、行固有の anchor は cell が row から取る。
      rowMenu: { currentExamId: examId, positionLocked, pending: movePending, onPullInto },
    } satisfies ExamCardTableMeta,
  })

  // Grid-2 T6: selection prune effect (§7.4 / HS-2 を単一 effect で吸収)。
  // visibleIds = 現在のフィルタ後 row id 集合。 selection をこの集合に prune することで
  //   - タグ操作後: card は data に残る = 可視継続 = 維持
  //   - 削除後: card が data から消える = 非可視 = prune で除外
  //   - フィルタ変更: 隠れる = 非可視 = prune で除外
  // を 1 effect で満たし「selection ⊆ 可視 (= N件 = 今見えている選択行)」不変条件 (HS-2) を保証する。
  const visibleIds = useMemo(
    () => table.getFilteredRowModel().rows.map((r) => r.id),
    // columnFilters / data は memo body から直接参照しないが、 getFilteredRowModel() の
    // 戻り値はこの 2 値の変化で更新される (table ref は安定なので deps から漏れると
    // filter/削除後に再計算されず prune が効かない)。 両者を明示的に deps に含める。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 上記理由で意図的に追加
    [table, columnFilters, data],
  )
  useEffect(() => {
    const visible = new Set(visibleIds)
    setRowSelection((prev) => {
      let changed = false
      const next: RowSelectionState = {}
      for (const id of Object.keys(prev)) {
        if (visible.has(id)) next[id] = prev[id]
        else changed = true
      }
      // no-op guard: 変化なしなら同一 ref を返し再レンダーループを防ぐ (必須)。
      return changed ? next : prev
    })
  }, [visibleIds])

  // 可視選択行 id。 prune effect により selection ⊆ 可視なので Object.keys = 可視選択 id。
  const selectedIds = useMemo(() => Object.keys(rowSelection), [rowSelection])

  // bulk tag/delete 配線: 結果を lastBulkResult に格納し action bar の失敗 UI に渡す。
  const onBulkTag = useCallback(
    async (categoryId: string, optionId: string, op: BulkTagOp) => {
      const r = await bulkTag(selectedIds, categoryId, optionId, op)
      setLastBulkResult({ op: op === 'add' ? '付与' : '除去', result: r })
    },
    [bulkTag, selectedIds],
  )
  const onBulkDelete = useCallback(async () => {
    // 削除後の selection は prune effect が自動除外する (data から消える = 非可視)。
    const r = await bulkDelete(selectedIds)
    setLastBulkResult({ op: '削除', result: r })
  }, [bulkDelete, selectedIds])

  // 選択が変わったら直前の失敗表示を捨てる (別の対象に対する stale な error を
  // 再マウントした bar に出さない)。
  useEffect(() => {
    setMoveError(null)
  }, [selectedIds])

  // 一括バー (a) の移動発行。 対象 = 実行時点の選択行 (行メニュー (c) は picker で
  // 選んだ card を渡すため、対象の決め方だけが違う)。
  const onMove = useCallback(
    async (targetExamId: string, placement: MovePlacement) => {
      setMovePending(true)
      try {
        return await dispatchMove(selectedIds, targetExamId, placement)
      } finally {
        setMovePending(false)
      }
    },
    [dispatchMove, selectedIds],
  )

  // 切り出し (b) = exam 作成 (server action) → pull → 末尾移動の逐次 3 段 (spec §6.1)。
  // exam は outbox に載せない (D-8) ため 1 op に畳まない。
  //
  // **pull は移動の前提**: useMoveCards は移動先 exam が mirror に居ることを検査して
  // からでないと mutation を発行しない。runGuardedPull は inflight-skip / lock-busy を
  // 通常経路で返す (直前の楽観 mutation が撃つ flush → pullBack と競合する) ため、
  // 1 回引いた上で **mirror に exam 行が現れるのを上限付きで待つ** (即時 retry は同じ skip が
  // 返るだけなので待機に置き換えた)。それでも届かなければ作成済み exam を ref に残し、
  // 次のクリックで createExam を飛ばして再開する。
  // ただし **pull が走った上で移動先が居ない場合は ref を破棄する** (削除された exam へ
  // 恒久的に resume して切り出しが詰まるのを防ぐ)。
  const onSplitOut = useCallback(async (): Promise<MoveDispatchOutcome> => {
    // 二重 submit の **同期** ガード。`movePending` state は次の render まで反映されないため、
    // 同一 tick に click が 2 発届くと両方が createExam に入り、空の「無題の試験」が 2 個
    // できる (Task 4 I-1 と同 class)。ref は代入した瞬間に見えるので、最初の await より前に
    // 立てて再入を弾く。state は表示 (button の disabled) 用としてそのまま残す。
    // 再入時は何もせず 'failed' を返す (popover は開いたまま・error も出さない)。
    if (splitInFlightRef.current) return 'failed'
    splitInFlightRef.current = true
    setMovePending(true)
    try {
      let examId = splitExamIdRef.current
      if (examId === null) {
        const created = await createExam(SPLIT_OUT_EXAM_NAME)
        const createdId = created.ok ? created.data?.examId : undefined
        if (createdId === undefined) {
          setMoveError(created.ok ? SPLIT_OUT_FAILED_MESSAGE : created.error)
          return 'failed'
        }
        examId = createdId
        splitExamIdRef.current = createdId
      }

      const pulled = await runGuardedPull({ reason: 'exam-create' }).catch(() => null)
      // pull の outcome ではなく **移動の実前提** (mirror に移動先 exam の行が居ること) を
      // 上限付きで待つ。skip は別 pull 進行中の常態で即 retry しても同じ結果になるため、
      // 進行中の pull が着地する時間を与える方が主操作 (1 回目の切り出し) が通る。
      // 戻り値は分岐に使わない: 上限に達しても従来どおり移動を試し、失敗分岐へ落とす。
      await waitForExamInMirror(examId, userId)

      const outcome = await dispatchMove(selectedIds, examId, { kind: 'end' })
      if (outcome === 'moved') splitExamIdRef.current = null
      if (outcome === 'target-exam-missing') {
        if (pulled === 'ran') {
          // pull が実際に走った (mirror は取り込み済み) のに移動先が居ない = その exam は
          // 「未同期」ではなく **消えている** (別端末で削除された等)。保持し続けると
          // createExam が二度と走らず切り出しが恒久的に詰まるので手放し、次のクリックで
          // 作り直す。文言も削除に対して同期を案内しないよう出し分ける。
          splitExamIdRef.current = null
          setMoveError(SPLIT_OUT_TARGET_GONE_MESSAGE)
        } else {
          // pull が skip された (lock-busy / inflight-skip) = mirror が古いだけかもしれない。
          // exam は残して次のクリックで pull + 移動から再開する (orphan を増やさない)。
          setMoveError(SPLIT_OUT_NOT_SYNCED_MESSAGE)
        }
      }
      return outcome
    } catch {
      setMoveError(SPLIT_OUT_FAILED_MESSAGE)
      return 'failed'
    } finally {
      splitInFlightRef.current = false
      setMovePending(false)
    }
  }, [dispatchMove, selectedIds, userId])

  const onUndoMove = useCallback(
    async (undo: MoveSuccess) => {
      setUndoPending(true)
      try {
        const result = await undoMove(undo)
        // 失敗は同じ slot を error 文言の toast で置き換える (undo button は消える)。
        showMoveToast(result.ok ? '元に戻しました' : UNDO_FAILURE_MESSAGE[result.reason])
      } catch {
        showMoveToast(UNDO_FAILED_MESSAGE)
      } finally {
        setUndoPending(false)
      }
    },
    [undoMove, showMoveToast],
  )

  // ---------------------------------------------------------------------------
  // row DnD (dnd-kit) — row-dnd sprint task-4: spec §3.1/§3.5/§4/§5 の配線。
  // sensors は tag 3 site と同じ hook を使うが、 起動条件だけ二役グリップ用に差し替える
  // (ROW_DND_SENSOR_OPTIONS — Mouse は 4px 超 / Touch long-press は共通 / Keyboard は
  // Enter を menu 用に残す)。
  // ---------------------------------------------------------------------------
  const sensors = useSortableSensors(ROW_DND_SENSOR_OPTIONS)
  // SortableContext の items = 基準順 (data) 全件の id 列。 仮想化で非表示の行も
  // dnd-kit sortable の index 計算には要るため、可視行 (virtualItems) だけでは不足する。
  const sortableItemIds = useMemo(() => data.map((r) => r.card.id), [data])
  // 並べ替えが意味を持つか。 category-list の sortableEnabled (list.length >= 2) と同じ判定を
  // 基準順全件 (data — columnFilters 非依存) に対して行う (TableBodyProps 冒頭コメント参照)。
  const dragAvailable = data.length >= 2
  const lockedReasonId = useId()
  // 読み上げ用のカード名。 生 id を読ませないための lookup で、文言は picker の checkbox
  // (row-menu の cardLabel) と同一定義を共有する。 data に無い id は空文字を返し、
  // buildJaAnnouncements 側の総称 fallback に委ねる。
  const getDragLabel = useCallback(
    (id: UniqueIdentifier) => {
      const card = data.find((r) => r.card.id === String(id))?.card
      return card ? cardLabel(card) : ''
    },
    [data],
  )
  // DndContext の accessibility は announcements の参照で memo される
  // (@dnd-kit/core の Accessibility → useDndMonitor)。 毎 render 新しい object を渡さない。
  const dragAnnouncements = useMemo(() => buildJaAnnouncements(getDragLabel), [getDragLabel])
  // ドラッグ中のプレビュー対象 card。 onDragStart で見つからなければ (stale id) null の
  // ままにする = DragOverlay の中身が非表示になる (spec §3.5)。
  const [activeDragCard, setActiveDragCard] = useState<ClientCard | null>(null)
  // handleRowDragEnd の同期再入ガード。 setMovePending (React state) は次 render まで
  // 反映されないため、 同一 tick に onDragEnd が 2 発届く経路を state だけでは弾けない
  // (onSplitOut の splitInFlightRef と同じ理由・同 class)。
  const dragCommitRef = useRef(false)

  // id 正規化はここ (onDragStart 冒頭) の 1 箇所のみ。 dnd-kit の active.id は
  // UniqueIdentifier (string | number) だが、以降 (data 検索) は string で扱う。
  const handleRowDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id)
      setActiveDragCard(data.find((r) => r.card.id === activeId)?.card ?? null)
    },
    [data],
  )

  const handleRowDragCancel = useCallback(() => {
    setActiveDragCard(null)
  }, [])

  // spec §5.1 の 6 手順(順序変更禁止)。 この順序は 2 つの制約を同時に満たすためにある:
  //   - ①-④ は全て同期処理。 同一 tick に 2 発目の onDragEnd が届いても、 1 発目が ⑤ で
  //     ref を立てた**後**にしか 2 発目の ① は評価されない (async 関数は最初の await
  //     (⑥ 内) に到達するまで同期実行され、その間は他の呼出に割り込まれない) ため、
  //     2 発目は必ず ① で弾ける。
  //   - ref は ⑤ (最初の await の直前) で初めて立てる。 ①-④ の early return
  //     (over 不在 / 自分自身 / id 不在 / 順序不変 / ソート・フィルタ適用中 / 他の移動が
  //     進行中) は ref に一切触れないため、 no-op drop が続いても ref が true のまま
  //     固まって以後の drag を恒久的にブロックする事故が構造的に起きない。
  const handleRowDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      const activeId = String(active.id)
      const overId = over ? String(over.id) : null

      // ① 再入検査 (読むだけ)。
      if (dragCommitRef.current) return
      // ② プレビューは結果に関わらずここで消す。
      setActiveDragCard(null)
      // ③ ソート/フィルタ適用中、または既に他の移動が進行中なら破棄 (spec §7.4 と同型)。
      if (positionLocked || movePending) return
      // ④ placement は **drop 時点の現行順** (= このコールバックが束縛している data、
      //    spec §5.1-4) に対して解く。drag 中に並走 mutation で順序が変わっても
      //    再計算しない (stale 検出はしない) — 「位置ずれのみで順序自体は決定的」という
      //    Grid-3 §2.5 が受容した class であり、 null を返す 4 条件 (over 不在 / 自分自身 /
      //    id 不在 / 順序不変) が凍結された契約 (placementForRowDrop 参照)。
      const placement = placementForRowDrop(
        data.map((r) => r.card.id),
        activeId,
        overId,
      )
      if (placement === null) return

      // ⑤ 最初の await 直前でだけ ref を立てる (このブロック冒頭のコメント参照)。
      dragCommitRef.current = true
      setMovePending(true)
      try {
        const result = await moveCards({
          cardIds: [activeId],
          targetExamId: examId,
          placement,
        })
        // ⑥ outcome ≠ ok は理由を問わず一律失敗扱い (undo なし・spec D-e)。
        //    既存 runMove (3 分岐解釈 + 一括バー用文言) は使わない — DnD は文言も
        //    表示先 (toast のみ) も別 (spec D-d)。
        if (result.ok) {
          showMoveToast('並び順を変更しました', result)
        } else {
          showMoveToast('並べ替えに失敗しました')
        }
      } catch {
        showMoveToast('並べ替えに失敗しました')
      } finally {
        dragCommitRef.current = false
        setMovePending(false)
      }
    },
    [data, positionLocked, movePending, moveCards, examId, showMoveToast],
  )

  // Fix-1 T2: action-bar 専用の bulk-bound createOptionAndAssign。
  // option を新規作成 (createOption) してから bulk add (onBulkTag) へ流す。
  // TagCell(meta) へ渡す tagEditCallbacks は不変 — action-bar のみに影響。
  // onBulkTag の後に宣言することで TDZ を回避する。
  const bulkCreateOptionAndAssign = useCallback(
    async (categoryId: string, name: string): Promise<void> => {
      const newOptionId = await createOption(userId, liveData?.options ?? [], categoryId, name)
      await onBulkTag(categoryId, newOptionId, 'add')
    },
    [userId, liveData?.options, onBulkTag],
  )

  const bulkTagEditCallbacks = useMemo(
    () => ({ ...tagEditCallbacks, createOptionAndAssign: bulkCreateOptionAndAssign }),
    [tagEditCallbacks, bulkCreateOptionAndAssign],
  )

  // Fix-3 T1: CSS 変数で列幅を配布 (TanStack v8 公式パターン)。
  // columnSizingInfo (resize 中に変化) と columnSizing (resize 確定後に変化) の
  // いずれかが変わった時のみ再計算する。table ref は useReactTable で安定なので deps 不要。
  // columnVisibility を含め、新たに表示された列の CSS 変数を emit する
  // (getFlatHeaders は visible 列のみ返すため、visibility 変化時も再計算が必要)。
  const columnSizeVars = useMemo(
    (): CSSProperties => {
      const headers = table.getFlatHeaders()
      const result: Record<string, number> = {}
      for (const header of headers) {
        result[`--header-${header.id}-size`] = header.getSize()
        result[`--col-${header.column.id}-size`] = header.column.getSize()
      }
      // S5-3: left-pinned 可視列に --col-{id}-start を追加 emit (spec D-5)。
      // resize 中は MemoizedTableBody が凍結されているが <table> 上の CSS 変数が更新されるため
      // pinned offset がリアルタイムに追従する(Fix-3 T1 パターン延長)。
      // getStart('left') は columnSizing に memo 依存 = drag 中も再計算される。
      for (const col of table.getLeftVisibleLeafColumns()) {
        result[`--col-${col.id}-start`] = col.getStart('left')
      }
      return result as CSSProperties
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- table ref は useReactTable で安定; 列幅変化は columnSizingInfo / columnSizing が検出する; columnVisibility を含め新たに表示された列の CSS 変数を emit する; columnPinning を追加して left-pinned 可視列の --col-{id}-start を emit する
    [table.getState().columnSizingInfo, table.getState().columnSizing, table.getState().columnVisibility, table.getState().columnPinning],
  )

  // S2-2: 内部スクロール container の ref。 element virtualizer の getScrollElement へ渡す。
  //   旧 window 実装の listOffset(document 座標)算出 + ResizeObserver(条件バー wrapper)
  //   + window resize listener は廃止 (element scroll では container 自身が offset 原点 =
  //   条件バー高や document 位置の変化に非依存で、 座標追従の JS が不要になる)。
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // S2b-1: rAF クリーンアップ(unmount 時に残った rAF をキャンセル)。
  useEffect(() => {
    return () => cancelAnimationFrame(rafIdRef.current)
  }, [])

  // S2b-1: scroll ハンドラ。rAF で throttle し boolean 変化時のみ setState + onCollapsedChange 通知。
  // virtualizer の getScrollElement/内部 listener とは独立 (同一要素への React onScroll 追加は干渉しない)。
  // scrollTop は書き換えない(scroll 保持)。
  const handleScroll = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = requestAnimationFrame(() => {
      const el = tableContainerRef.current
      if (!el) return
      const middleBandHeight =
        (condBarWrapperRef.current?.offsetHeight ?? 0) +
        (chromeRef?.current?.offsetHeight ?? 0)
      const next = computeCollapsed(
        el.scrollTop,
        el.scrollHeight,
        el.clientHeight,
        middleBandHeight,
        collapsedRef.current,
      )
      if (next !== collapsedRef.current) {
        collapsedRef.current = next
        setCollapsed(next)
        onCollapsedChange?.(next)
      }
    })
  }, [onCollapsedChange, chromeRef])

  // S5-2: 固定境界 id を render 冒頭で 1 回導出し、menu を持つ全列の pinning prop に渡す。
  // derivePinnedBoundary は columnPinning.left 末尾 id を返す(末尾 'select' → null)。
  const pinnedBoundary = derivePinnedBoundary(columnPinning)

  // undo 素材を optional chain 1 回で narrow しておく (JSX 側で非 null 断定を書かない)。
  const moveToastUndo = moveToast?.undo

  // row-dnd task-4: DragOverlay 自体は常時 mount、子だけを条件描画する (activeDragCard が
  // 無ければ null)。1 回だけ組み立て、portal するかどうかの分岐 (SSR/マウント前ガード)
  // だけを JSX 側の三項に残す (PullIntoDialog の content 変数と同型)。
  const dragOverlayNode = (
    <DragOverlay>{activeDragCard ? <RowDragPreview card={activeDragCard} /> : null}</DragOverlay>
  )

  return (
    // S2-2: app-shell 密封の flex 列。 親 (exam-detail-view の flex-1 min-h-0 スロット) を
    //   h-full で埋め、 [条件バー wrapper (flex-none)] + [table container (flex-1 overflow-auto)]
    //   に配分する。 min-h-0 で flex chain を切らさない (固定 px 高さ禁止・spec Global)。
    <div className="h-full flex flex-col min-h-0">
      {/* S2b-1: 条件バー wrapper — grid-rows 0fr/1fr で unmount せずに collapse。
          flex-none で可変高を吸収。transition 150ms + motion-reduce 非アニメ。
          collapsed 時は grid-rows-[0fr] + inner min-h-0 overflow-hidden でコンテンツをクリップ。
          condBarWrapperRef で offsetHeight を実測し scroll 閾値の短コンテンツ guard に使う。
          S2-5: 列ボタン (ColumnVisibilityToggle) は exam-detail-view の上部 chrome へ移設済。 */}
      <div
        ref={condBarWrapperRef}
        data-testid="cond-bar-wrapper"
        className={cn(
          'flex-none grid transition-[grid-template-rows] duration-150 motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={collapsed}>
          <div className="flex flex-wrap items-start gap-2">
            {/* S1-5: 動的条件バー (固定 FilterBar 撤去済 = 唯一のフィルタ UI)。 */}
            <ConditionBar
              table={table}
              editorContext={{
                categories: liveData?.categories ?? [],
                options: liveData?.options ?? [],
              }}
            />
          </div>
        </div>
      </div>
      {/* row-dnd task-4: DndContext は常時 mount する(条件 mount 禁止)。 型変化 tear-down で
          tbody subtree が丸ごと remount するリークを Fix-3 T1.1 で根治した後なので、
          provider の mount/unmount 切替で同じ class の事故を再導入しない。 並べ替え不能状態
          (ソート/フィルタ中・1 件以下・移動中) は SortableRow 内の 3 層 gating
          (locked/pending/dragAvailable → useSortable disabled) で表現し、 provider の
          有無では表現しない。 DragOverlay は末尾で document.body へ portal する
          (PullIntoDialog と同型の typeof document ガード)。 */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleRowDragStart}
        onDragEnd={handleRowDragEnd}
        onDragCancel={handleRowDragCancel}
        // dnd-kit 既定は英語 + 生 card id を読み上げるため日本語版に差し替える
        // (row-ux §7)。 instructions は行 DnD 専用 (Enter = メニュー) の文言。
        accessibility={{
          announcements: dragAnnouncements,
          screenReaderInstructions: ROW_DND_SR_INSTRUCTIONS,
        }}
      >
      {/* S2-2: 内部スクロール主体の container。 flex-1 min-h-0 で残余高を埋め overflow-auto で
          縦横スクロールを内包 (旧 overflow-x-auto = document 縦スクロール前提から差替)。
          M3: 選択時は fixed action bar (~106px、 wrap で増) が最終行を occlude しないよう
          container の内部下部に pb-32 (128px) を足す (密封後は container 側 padding が正)。
          S2b-1: onScroll → rAF throttle → computeCollapsed で collapsed 信号を導出。
          virtualizer の getScrollElement/内部 listener とは独立(干渉なし)。 */}
      <div
        ref={tableContainerRef}
        onScroll={handleScroll}
        className={cn('flex-1 min-h-0 overflow-auto', selectedIds.length > 0 && 'pb-32')}
      >
        {/* row-dnd task-4: gating 理由 (ソート/フィルタ中) の sr-only 説明。 handle の
            aria-describedby (exam-card-row-dnd.tsx) がこの id を参照する。 table レベルで 1 個。 */}
        <p id={lockedReasonId} className="sr-only">
          {ROW_DND_LOCKED_REASON}
        </p>
        {/* T3: w-full 撤廃 → getTotalSize() で列幅合計を明示し overflow-x スクロールを発火させる。
            border-collapse → border-separate border-spacing-0 に倒し切る (条件分岐なし)。
            理由: sticky セルで border-collapse は border 消失が既知挙動。
            border-separate では <tr> の border-b が効かないため border を td/th 側に移譲。 */}
        {/* Fix-3 T1: columnSizeVars を spread して CSS 変数を <table> に付与。
            resize 中は MemoizedTableBody を使い tbody を凍結する (pointermove = CSS 変数のみ更新)。 */}
        {/* row-dnd task-4: SortableContext は <table> の外側 (spec §3.1)。 items は基準順
            全件 (data 由来の sortableItemIds) — 可視行のみだと dnd-kit の index 計算が
            不足する。 */}
        <SortableContext items={sortableItemIds} strategy={verticalListSortingStrategy}>
        <table
          className="text-sm border-separate border-spacing-0"
          style={{ ...columnSizeVars, width: table.getTotalSize() }}
        >
        {/* S2-3: sticky top-0 z-10 で内部スクロール container 上端に見出し行を固定する。
            border-separate table では thead 単位の sticky が正しく動作する (border-collapse 禁忌だが
            本テーブルは border-separate border-spacing-0 を維持)。
            実挙動 (固定・非透過・Popover 非クリップ) は S2 締め stg smoke に委譲。 */}
        <thead className="sticky top-0 z-10">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const canSort = h.column.getCanSort()
                const sortDir = h.column.getIsSorted()
                const canResize = h.column.getCanResize()
                // ColumnHeaderMenu の label: column header が string のときそれを使い、
                // それ以外 (JSX header = select 列の checkbox 等) は column.id を fallback。
                // canSort 列は全て string header (question/lastCorrect/currentStreak/lastReview)。
                const headerLabel =
                  typeof h.column.columnDef.header === 'string'
                    ? h.column.columnDef.header
                    : h.column.id
                // S5-3: left-pinned 判定。sticky は relative と position 二重指定不可のため置換(spec D-5)。
                // sticky も positioned 要素のため absolute resize handle の anchor は不変(Codex 論点反映)。
                const isPinned = h.column.getIsPinned() === 'left'
                // S5-3: 最右可視 pinned 列にセパレータ border-r を付与(spec D-6・visible-leaf 基準)。
                const isLastPinned = isPinned && h.column.getIsLastColumn('left')
                return (
                  <th
                    key={h.id}
                    // T3: 非 pinned は relative (resize handle を absolute right-0 で配置するため)。
                    // S5-3: pinned は sticky z-10 に置換 (position 二重指定不可)。
                    // border-b を th に付与 (border-separate では tr border-b は効かない)。
                    // select 列のみ text-center align-middle で全選択チェックボックスを上下左右中央に揃える。
                    // S2-3: bg-background で不透明背景を付与 (thead sticky 時に tbody 行が透けないよう)。
                    className={cn(
                      isPinned ? 'sticky z-10' : 'relative',
                      'px-1 py-1 font-medium text-muted-foreground border-b border-border bg-background',
                      h.column.id === 'select' ? 'text-center align-middle cursor-pointer' : 'text-left',
                      // S5-3: 最右可視 pinned 列にセパレータ (spec D-6)。
                      isLastPinned && 'border-r',
                      // S2-6: cursor-pointer / select-none は trigger button 側へ集約(cell 全体 trigger 化)。
                    )}
                    // B: select 列 th 全域をクリック領域化 (行 td と一貫、全選択トグル)。
                    //    header checkbox 直 click は input 側 stopPropagation で二重発火を防ぐ。
                    //    他列は menu trigger 側が click を持つため th onClick は付けない。
                    onClick={
                      h.column.id === 'select'
                        ? () => table.toggleAllRowsSelected()
                        : undefined
                    }
                    // Fix-3 T1: CSS 変数参照に切替。th は memo 凍結対象外なのでリアルタイム更新される。
                    // S5-3: pinned th の left offset は CSS 変数参照(resize 中も追従・spec D-5)。
                    style={{
                      width: `calc(var(--header-${h.id}-size) * 1px)`,
                      ...(isPinned && { left: `calc(var(--col-${h.column.id}-start) * 1px)` }),
                    }}
                    // S1-1: th の即ソート onClick を撤去。canSort 列は ColumnHeaderMenu trigger 経由。
                  >
                    {h.isPlaceholder ? null : (() => {
                      // S2-6: filter dot / sort glyph を trigger 内へ配置(cell 全体を menu 起動対象化)。
                      //   dot の表示条件・見た目は不変(registry-gated + getIsFiltered)。 位置のみ trigger 内へ。
                      //   glyph は canSort 列のみ(▲/▼/▾)。
                      const dot =
                        h.column.id in cardTableFilterEditors && h.column.getIsFiltered() ? (
                          <span
                            role="img"
                            aria-label="フィルタ適用中"
                            className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
                          />
                        ) : null
                      const glyph = canSort ? (
                        <span
                          className="text-xs text-muted-foreground/60"
                          aria-hidden="true"
                        >
                          {/* S1-4: unsorted=▾ / asc=▲ / desc=▼ */}
                          {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '▾'}
                        </span>
                      ) : null

                      // S4-3: registry lookup で filterEditor を構築 (if/else chain 撤去)。
                      // tags は引き続き TagsEditor、新 5 列は TextColumnEditor が registry 経由で解決される。
                      // nested Popover リスク (tags): CardTagAddPopover が Radix Popover を持つため
                      // ColumnHeaderMenu (Radix Popover) 内に nested になる。
                      // Radix DismissableLayerBranch により通常は正常動作するが、
                      // 実開閉・クリップ・フォーカス挙動は stg smoke で最終確認する。
                      const colId = h.column.id
                      let filterEditor: ReactNode | undefined
                      if (colId in cardTableFilterEditors) {
                        const FE = cardTableFilterEditors[colId as keyof typeof cardTableFilterEditors]
                        const editorCtx = {
                          categories: liveData?.categories ?? [],
                          options: liveData?.options ?? [],
                        }
                        filterEditor = <FE column={h.column} ctx={editorCtx} />
                      }

                      // S4-3: menu gate = canSort || filterEditor 有り。
                      // question/explanation_text/memo は非 canSort だが filterEditor 有りで menu 出現。
                      // select/options は非 canSort かつ registry 外 → plain render のまま。
                      if (canSort || filterEditor !== undefined) {
                        // S5-2: menu を持つ全列に pinning prop を渡す。
                        // isBoundary = 自列が現在の固定境界かどうか。
                        // onSelect: 自列が境界なら null(全解除)、それ以外は自列を新境界にする。
                        // colId は filterEditor lookup 節で既に宣言済(上の const colId = h.column.id)。
                        return (
                          <ColumnHeaderMenu
                            column={h.column}
                            label={headerLabel}
                            filterEditor={filterEditor}
                            pinning={{
                              isBoundary: colId === pinnedBoundary,
                              onSelect: () =>
                                onColumnPinningChange({
                                  left: computePinnedLeft(
                                    colId === pinnedBoundary ? null : colId,
                                  ),
                                  right: [],
                                }),
                            }}
                          >
                            <span>{headerLabel}</span>
                            {dot}
                            {glyph}
                          </ColumnHeaderMenu>
                        )
                      }

                      // menu なし列(select/options): plain render。
                      //   dot/glyph 非対象ゆえ trigger 化しない(現状維持)。
                      return (
                        <span className="inline-flex items-center gap-1">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                        </span>
                      )
                    })()}
                    {/* T3: resize handle。select 列はスキップ (checkbox との干渉回避)。
                        stopPropagation で上位 th の click に menu が干渉しないよう分離する。 */}
                    {canResize && h.column.id !== 'select' && (
                      <div
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          h.getResizeHandler()(e)
                        }}
                        onTouchStart={(e) => {
                          e.stopPropagation()
                          h.getResizeHandler()(e)
                        }}
                        aria-hidden="true"
                      />
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        {/* Fix-3 T1.1: 型 swap を撤廃し単一型 MemoizedTableBody に固定する。
            旧実装: resize 中は <MemoizedTableBody> / 非 resize 時は <TableBody> の型 swap。
            型 swap は React の型変化 tear-down を引き起こし tbody subtree (300行×cell×Radix popover) を
            毎 resize サイクルで remount → listener ~66k / DOM ~174k の階段リーク根治。
            修正: 常に <MemoizedTableBody isResizing={...}> を render し型変化 tear-down を封じる。 */}
        <MemoizedTableBody
          table={table}
          isResizing={Boolean(table.getState().columnSizingInfo.isResizingColumn)}
          scrollElementRef={tableContainerRef}
          dragAvailable={dragAvailable}
          locked={positionLocked}
          pending={movePending}
          lockedReasonId={lockedReasonId}
        />
        </table>
        </SortableContext>
      </div>
      {/* 移動 toast (§7.5)。 action bar の外に置くのは、 移動成功で selection が空になり
          bar が unmount しても undo を残すため。 key = 操作 id で同一文言の連続表示でも
          auto-dismiss timer を張り直す (ActionToast の契約)。 */}
      {moveToast && (
        <ActionToast
          key={moveToast.id}
          message={moveToast.message}
          actionLabel={moveToastUndo ? '元に戻す' : undefined}
          onAction={moveToastUndo ? () => void onUndoMove(moveToastUndo) : undefined}
          actionPending={undoPending}
          onClose={() => setMoveToast(null)}
        />
      )}
      {/* document.body へ portal する — PullIntoDialog (exam-card-row-menu.tsx) と同型の
          SSR/マウント前ガード。 dropAnimation は既定のまま。 */}
      {typeof document === 'undefined'
        ? dragOverlayNode
        : createPortal(dragOverlayNode, document.body)}
      </DndContext>
      {selectedIds.length > 0 && (
        <ExamCardTableActionBar
          selectedIds={selectedIds}
          categories={liveData?.categories ?? []}
          options={liveData?.options ?? []}
          tagEditCallbacks={bulkTagEditCallbacks}
          onBulkTag={onBulkTag}
          onBulkDelete={onBulkDelete}
          lastResult={lastBulkResult}
          userId={userId}
          examId={examId}
          positionLocked={positionLocked}
          movePending={movePending}
          onMove={onMove}
          onSplitOut={onSplitOut}
          moveError={moveError}
        />
      )}
      {/* S2b-2: scroll-top ボタン。 collapsed かつ選択なし(action bar 非表示)の時のみ表示。
          非表示時は unmount(focus 消失許容)。z-30 < action bar z-40 だが同時表示なし。
          safe-area 対応は stg smoke 確認後に必要なら追加(先回り YAGNI)。 */}
      {collapsed && selectedIds.length === 0 && (
        <Button
          variant="outline"
          size="icon-lg"
          className="rounded-full shadow-sm fixed right-6 bottom-4 z-30"
          data-testid="scroll-top-button"
          aria-label="先頭へスクロール"
          onClick={() => tableContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <ChevronUp />
        </Button>
      )}
      {/* side peek: Portal 経由で fixed overlay 描画。DOM 位置は root 末尾(スクロールコンテナ外)。
          ActionBar(z-40) より上・popover/dialog 帯(z-50) より下 = z-[45](spec §3.8)。 */}
      <ExamCardSidePeek
        row={activeRow}
        cardTags={activeCardTags}
        categories={liveData?.categories ?? []}
        options={liveData?.options ?? []}
        userId={userId}
        onClose={handleClosePeek}
      />
    </div>
  )
}
