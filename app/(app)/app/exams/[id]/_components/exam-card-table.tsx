'use client'

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

import { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
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
} from '@tanstack/react-table'
import { getClientDb } from '@/lib/client-db'
import {
  SYNC_META_KEYS,
  examViewPrefsSchema,
  examViewPrefsV2Schema,
  examViewPrefsToV2,
  getJsonSyncMeta,
  setJsonSyncMeta,
} from '@/lib/sync/sync-meta'
import { sortLikeServer } from './inline-card-list'
import { examCardTableColumns, type ExamCardRow, type ExamCardTableMeta } from './exam-card-table-columns'
import { joinCardTags } from '@/lib/cards/join-card-tags'
import { ExamCardTableFilterBar } from './exam-card-table-filter-bar'
import { ColumnVisibilityToggle } from './exam-card-table-column-toggle'
import { ExamCardTableActionBar } from './exam-card-table-action-bar'
import { useCardTagToggle } from '../_hooks/use-card-tag-toggle'
import { useBulkCardTags, type BulkResult, type BulkTagOp } from '../_hooks/use-bulk-card-tags'
import { useBulkCardDelete } from '../_hooks/use-bulk-card-delete'
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
} from './card-tags-section'

type ExamCardTableProps = {
  examId: string
  userId: string
}

export function ExamCardTable({ examId, userId }: ExamCardTableProps) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  // 初期ソート: question 列昇順 = sortKey 昇順 = sortLikeServer 順 (spec §6)。
  const [sorting, setSorting] = useState<SortingState>([{ id: 'question', desc: false }])
  // Grid-2 T3: columnFilters は非永続 (examViewPrefs に保存しない、 リロードで初期化)。
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  // T3: columnSizing は非永続 (examViewPrefs / sync_meta に書かない、 リロードで初期化)。
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
  // Edit-2 Task 4: columnVisibility は examViewPrefs.hiddenColumns として永続化。
  // 初期は空 (= 全列表示)。 mount effect で sync_meta から load し setState する。
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  // 永続化ガード: mount load 完了前に persist effect が初期空 state を書き込んで
  // 既存 record (table が前回保存した hiddenColumns) を上書きするのを防ぐ。
  const visibilityLoadedRef = useRef(false)

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
      .sort(sortLikeServer)
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

  // createOptionAndAssign の placeholder (TagCell 側で cardId-bound に差し替え)。
  // 実際の呼出では TagCell が自分の cardId を使った closure に上書きするため、
  // ExamCardTable レベルでは cardId = '' の placeholder で OK。
  const createOptionAndAssignPlaceholder = useCallback(
    (_categoryId: string, _name: string): Promise<void> => {
      // TagCell 側で override されるため、 ここに到達する呼び出しは発生しない。
      // 万が一呼ばれた場合は no-op (card が特定できないため書込不可)。
      return Promise.resolve()
    },
    [],
  )

  const tagEditCallbacks: TagEditCallbacks = useMemo(
    () => ({
      renameCategory: handleRenameCategory,
      setCategoryColor: handleSetCategoryColor,
      deleteCategory: handleDeleteCategory,
      renameOption: handleRenameOption,
      setOptionColor: handleSetOptionColor,
      deleteOption: handleDeleteOption,
      countCategoryImpact,
      countOptionImpact,
      createCategory,
      createOptionAndAssign: createOptionAndAssignPlaceholder,
    }),
    [createCategory, createOptionAndAssignPlaceholder],
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
    state: { rowSelection, sorting, columnFilters, columnSizing, columnVisibility },
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    meta: {
      userId,
      toggle,
      tagEditCallbacks,
      categories: liveData?.categories ?? [],
      options: liveData?.options ?? [],
    } satisfies ExamCardTableMeta,
  })

  // Edit-2 Task 4: mount で sync_meta から hiddenColumns を load し columnVisibility に反映。
  // hiddenColumns(string[]) を { [id]: false } map に変換して setState。 load 完了で
  // visibilityLoadedRef を立て、 以降の persist effect を解禁する (初期空 state での上書き防止)。
  useEffect(() => {
    let cancelled = false
    void getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema).then((saved) => {
      if (cancelled) return
      if (saved) {
        const { hiddenColumns } = examViewPrefsToV2(saved)
        if (hiddenColumns.length > 0) {
          const map: VisibilityState = {}
          for (const id of hiddenColumns) map[id] = false
          setColumnVisibility(map)
        }
      }
      visibilityLoadedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Edit-2 Task 4: columnVisibility 変更時に READ-MODIFY-WRITE で永続化 (fire-and-forget)。
  // load 完了前 (visibilityLoadedRef=false) は early-return し、 初期空 state で既存
  // record を上書きしない。 view は現在値を read して保持し、 hiddenColumns のみ更新する。
  // hidden id は value===false の列 (select 列は除外 = 常に表示)。
  useEffect(() => {
    if (!visibilityLoadedRef.current) return
    const hiddenColumns = Object.keys(columnVisibility).filter(
      (id) => columnVisibility[id] === false && id !== 'select',
    )
    void getJsonSyncMeta(SYNC_META_KEYS.examViewPrefs, examViewPrefsSchema)
      .then((saved) => {
        const view = saved ? examViewPrefsToV2(saved).view : 'table'
        return setJsonSyncMeta(
          SYNC_META_KEYS.examViewPrefs,
          { version: 2, view, hiddenColumns },
          examViewPrefsV2Schema,
        )
      })
      .catch(() => {})
  }, [columnVisibility])

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

  // Fix-1 T2: action-bar 専用の bulk-bound createOptionAndAssign。
  // option を新規作成 (createOption) してから bulk add (onBulkTag) へ流す。
  // filter-bar / TagCell(meta) へ渡す tagEditCallbacks は不変 — action-bar のみに影響。
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

  return (
    // M3 (T7 stg smoke): 選択時のみ下部 padding を確保し、 fixed bottom action bar
    // (高さ ~106px、 失敗メッセージで wrap すると更に増える) が最終行を occlude しない
    // ようにする (mobile 短 viewport 375px で確認)。 pb-32 (128px) で wrap 時も余裕を持つ。
    <div className={selectedIds.length > 0 ? 'pb-32' : undefined}>
      {/* Edit-2 Task 4: 列表示/非表示 toggle を filter bar と並べる (右寄せ)。 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <ExamCardTableFilterBar
          table={table}
          categories={liveData?.categories ?? []}
          options={liveData?.options ?? []}
          tagEditCallbacks={tagEditCallbacks}
        />
        <ColumnVisibilityToggle table={table} />
      </div>
      <div className="overflow-x-auto">
        {/* T3: w-full 撤廃 → getTotalSize() で列幅合計を明示し overflow-x-auto を発火させる。
            border-collapse → border-separate border-spacing-0 に倒し切る (条件分岐なし)。
            理由: sticky セルで border-collapse は border 消失が既知挙動。
            border-separate では <tr> の border-b が効かないため border を td/th 側に移譲。 */}
        <table
          className="text-sm border-separate border-spacing-0"
          style={{ width: table.getTotalSize() }}
        >
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const isSticky =
                  (h.column.columnDef.meta as { sticky?: boolean } | undefined)
                    ?.sticky === true
                const canSort = h.column.getCanSort()
                const sortDir = h.column.getIsSorted()
                const canResize = h.column.getCanResize()
                return (
                  <th
                    key={h.id}
                    // T3: relative が必要 (resize handle を absolute right-0 で配置するため)。
                    // border-b を th に付与 (border-separate では tr border-b は効かない)。
                    className={[
                      'relative px-3 py-2 text-left font-medium text-muted-foreground border-b border-border',
                      isSticky
                        ? 'sticky left-0 z-10 bg-background'
                        : '',
                      canSort ? 'cursor-pointer select-none' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ width: h.getSize() }}
                    onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                  >
                    {h.isPlaceholder ? null : (
                      <span className="inline-flex items-center gap-1">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {canSort && (
                          <span
                            className="text-xs text-muted-foreground/60"
                            aria-hidden="true"
                          >
                            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '⇅'}
                          </span>
                        )}
                      </span>
                    )}
                    {/* T3: resize handle。select 列はスキップ (checkbox との干渉回避)。
                        stopPropagation で sort onClick が発火しないよう分離する。 */}
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
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              data-testid={`row-${row.original.card.id}`}
              className="hover:bg-muted/50"
            >
              {row.getVisibleCells().map((cell) => {
                const isSticky =
                  (
                    cell.column.columnDef.meta as
                      | { sticky?: boolean }
                      | undefined
                  )?.sticky === true
                return (
                  <td
                    key={cell.id}
                    // T3: border-b を td に付与 (border-separate では tr border-b は効かない)。
                    className={[
                      'px-3 py-2 border-b border-border',
                      isSticky
                        ? 'sticky left-0 z-10 bg-background'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      {selectedIds.length > 0 && (
        <ExamCardTableActionBar
          selectedIds={selectedIds}
          categories={liveData?.categories ?? []}
          options={liveData?.options ?? []}
          tagEditCallbacks={bulkTagEditCallbacks}
          onBulkTag={onBulkTag}
          onBulkDelete={onBulkDelete}
          lastResult={lastBulkResult}
        />
      )}
    </div>
  )
}
