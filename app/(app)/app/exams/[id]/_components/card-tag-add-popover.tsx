'use client'

// CardTagAddPopover: 「+ タグを追加」 button trigger の 5 stage popover。
// stage 1 (category): カテゴリ選択 (combobox: CardTagOptionList kind='category')
//   sort_key ASC NULLS LAST, created_at ASC で sort + 名前 filter + 新規作成導線。
// stage 2 (option): 選択カテゴリの option 選択 (CardTagOptionList kind='option')
// stage 3 (editCategory): カテゴリ編集 (CardTagEditFields)
// stage 4 (editOption): option 編集 (CardTagEditFields)
// stage 5 (createCategoryType): カテゴリ新規作成 select_type 選択 (Tag-4c-2a-fix Task 3)
//   stage 1 combobox の「新規作成: {name}」 click で pendingCategoryName を保持し、
//   本 stage で single/multi 2 button のいずれかを click すると mutation 発火 +
//   stage='option' へ遷移する。
//
// Esc 挙動 (Notion 方式拡張):
//   editCategory → category / editOption → option / option → category
//   createCategoryType → category / category → close (shadcn 標準)
//
// popover close 時は全 state をリセット (stage='category', selectedCategoryId=null,
//   editTargetId=null, lastError=null, createError=null, pendingCategoryName=null,
//   isSubmittingCreate=false)。
//
// error state の分離:
//   - lastError: editCategory / editOption の rename/color/delete failure
//   - createError: createCategoryType / option 新規作成 failure (Tag-4c-2a Task 3)
//   stage 間で error 文言が混ざらないよう、 2 state を維持する。
//
// 設計参照: docs/superpowers/specs/2026-06-07-tag-4b-fix-popover-ui-design.md §4/§5
//           Tag-4c-1 Task 3 / Tag-4c-2a Task 3 / Tag-4c-2a-fix Task 3

import * as React from 'react'
import { Plus, ChevronLeft, CircleDot, CheckSquare } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'

import type { ClientTagCategory, ClientTagOption } from '@/lib/client-db'
import { sortByKeyThenCreated } from '@/lib/tags/sort-comparator'
import { useSortableSensors } from '@/lib/dnd/use-sortable-sensors'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { CardTagOptionList } from './card-tag-option-list'
import { CardTagEditFields } from './card-tag-edit-fields'
import type { TagEditCallbacks } from '@/lib/tags/tag-crud'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  categories: ClientTagCategory[]
  options: ClientTagOption[]
  /** 本 card 全カテゴリ横断の付与済み option_id 配列 */
  allAssignedOptionIds: string[]
  /** (categoryId, optionId) で呼ばれる toggle callback */
  onToggle: (categoryId: string, optionId: string) => void
  /** 編集系 callback 群。 selectOnly=true で tag 選択だけ行う場合は省略可 (Q-7)。 */
  tagEditCallbacks?: TagEditCallbacks
  /** stage1 D&D 並べ替えの差分 reindex 経路 (Tag-4c-2b T6 で配線済)。
   *  渡された場合: 親 DndContext.onDragEnd → handleStage1DragEnd → 本 callback を直接
   *  dispatch する (子 CardTagOptionList は `sortable` boolean のみ受け取り、 handle 表示と
   *  useSortable 配線を担当)。 渡されなかった場合は DndContext を mount せず D&D 配線を
   *  skip する (中間状態互換)。 */
  onReorderCategories?: (orderedIds: string[]) => Promise<void>
  /** stage2 D&D 並べ替えの差分 reindex 経路 (Tag-4c-2b T6 で配線済)。
   *  arg は当該 category の id + drag-end 後の option id 順。 onReorderCategories と
   *  同じ経路 (親 DndContext.onDragEnd → handleStage2DragEnd → 本 callback を直接 dispatch)。 */
  onReorderOptions?: (categoryId: string, orderedIds: string[]) => Promise<void>
  /** popover open 時の初期 stage。 default 'category' (= 既存挙動)。
   *  'option' を指定した場合 initialCategoryId と組合せて「カテゴリ起点で開く」 が可能。
   *  edit* / createCategoryType は initial 不可 (Grid-1 範囲外、 型で禁止)。
   *  Grid-1 T3。
   */
  initialStage?: 'category' | 'option'
  /** popover open 時の初期 selectedCategoryId。 default null (= 既存挙動)。
   *  initialStage='option' のときに categoryId を指定すると stage='option' で
   *  該当 category の option list を開く。 null/undefined の場合は防御的に
   *  stage='category' fallback (invalid input は無視)。 Grid-1 T3。
   */
  initialCategoryId?: string | null
  /** popover trigger の React element。 提供時は default 「+ タグを追加」 button を置き換え、
   *  Radix PopoverTrigger asChild で任意要素を trigger 化する。 未指定 = 既存挙動
   *  (固定 trigger button)。 Grid-1 T6 で TagCell が badge / +N / placeholder を trigger 化する。
   */
  trigger?: React.ReactNode
  /** 選択専用モード (default false = 既存挙動)。 true のとき「新規作成」 行と kebab (編集導線) を
   *  非表示にし、 filter + toggle 選択だけを許可する。 custom フィルタの tag 選択 UI で使用。
   *  既存呼出元 (filter-bar / tag-cell) は未指定のため挙動不変。 S2.3 Task 9。 */
  selectOnly?: boolean
}

// ---------------------------------------------------------------------------
// Stage type
// ---------------------------------------------------------------------------

// Tag-4c-2a-fix Task 3: 旧 'createCategory' stage を撤廃、 'createCategoryType' のみ残す。
// (combobox 「新規作成: {name}」 → createCategoryType で select_type 確定 → option stage)
type Stage =
  | 'category'
  | 'option'
  | 'editCategory'
  | 'editOption'
  | 'createCategoryType'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagAddPopover({
  categories,
  options,
  allAssignedOptionIds,
  onToggle,
  tagEditCallbacks,
  onReorderCategories,
  onReorderOptions,
  initialStage,
  initialCategoryId,
  trigger,
  selectOnly = false,
}: Props) {
  const [open, setOpen] = React.useState(false)
  const [stage, setStage] = React.useState<Stage>('category')
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<string | null>(null)
  const [editTargetId, setEditTargetId] = React.useState<string | null>(null)
  const [lastError, setLastError] = React.useState<string | null>(null)
  // Tag-4c-2a Task 3 / Tag-4c-2a-fix Task 3: create 系 error。
  // lastError とは別に保持する (stage 間の error 文言混在を避けるため)。
  // createCategoryType stage + stage='option' の option 新規作成で共用。
  const [createError, setCreateError] = React.useState<string | null>(null)
  // Tag-4c-2a Task 3 fix (Important 2): createCategoryType / 新規作成行の二重発火ガード。
  // await 解決前の連打で entity_mutation を 2 件 enqueue するのを防ぐ。
  // 1 state で兼用 (user は同時に両方を発火できない)。
  const [isSubmittingCreate, setIsSubmittingCreate] = React.useState(false)
  // Tag-4c-2a-fix Task 2: 新 combobox 「新規作成」 行 click 時に入力 name を保持し、
  // createCategoryType stage へ持ち越すための state。 Task 3 で stage JSX に配線。
  const [pendingCategoryName, setPendingCategoryName] = React.useState<string | null>(null)
  // Tag-4c-2a-fix Task 3 / Tag-4c-2a-fix-2 Task 1: createCategoryType stage 表示直後に
  // 「マルチセレクト」 button へ初期 focus を当てる用 ref。 multi が default 設計 (spec §5)。
  const multiButtonRef = React.useRef<HTMLButtonElement | null>(null)
  // Tag-4c-2b T5: stage1 / stage2 の combobox filter 入力を popover 側でも保持する。
  // CardTagOptionList の onFilterChange callback で同期され、 filter 空のときだけ
  // DndContext を mount + onReorder を渡す (spec §4.5「filter 中は D&D 無効」 不変条件)。
  // 編集 stage / createCategoryType に移ると CardTagOptionList が unmount され filter
  // は再 mount 時に空 reset されるが、 popover 側の state は明示 reset しない
  // (DndContext は category/option stage の中だけで mount され、 他 stage では参照されない
  // ため、 stale 値が悪さしない)。 popover close は onOpenChange で全 reset 経路あり。
  const [stage1FilterText, setStage1FilterText] = React.useState('')
  const [stage2FilterText, setStage2FilterText] = React.useState('')

  // Tag-4c-2b T5 / Tag-4c-2c hotfix H4: dnd-kit sensors。 stage1/stage2 で共用。
  // 旧 PointerSensor 単独 (delay 250 / tolerance 5) は PC でも長押し要で違和感が出ていた
  // ため、 共有 hook `useSortableSensors` で MouseSensor (PC 即起動) + TouchSensor
  // (delay 250 / tolerance 5 で long-press + scroll/tap 誤発火抑制) + KeyboardSensor
  // (sortableKeyboardCoordinates で a11y) の 3 sensor 構成に分割。 manager (category-list
  // / option-list) でも同 hook を使い drift を回避する (spec §4.4)。
  const sensors = useSortableSensors()

  // selectOnly (フィルタ文脈) では作成導線を出さないため、検索ボックスの文言も
  // 「新規作成」を誘導しない検索専用文言へ切替える (作成導線本体は onCreateNew=undefined で
  // 既に非表示。 文言のみ揃える cosmetic)。 非フィルタ文脈 (tag-cell / action-bar 等) は不変。
  const categorySearchPlaceholder = selectOnly ? '検索' : '検索 or 新規作成'
  const categorySearchAriaLabel = selectOnly ? 'カテゴリを検索' : 'category を検索 / 新規作成'
  const optionSearchPlaceholder = selectOnly ? '検索' : undefined
  const optionSearchAriaLabel = selectOnly ? 'タグを検索' : undefined
  // フィルタ 0 件時の空表示も selectOnly では作成を誘導しない (default は「タグ名を入力し新規作成」)。
  const categoryEmptyPlaceholder = selectOnly ? '該当するカテゴリなし' : undefined
  const optionEmptyPlaceholder = selectOnly ? '該当するタグなし' : undefined

  // Fix C-3 軸 1: sort_key ASC NULLS LAST, created_at ASC + 数値順 (Tag-4c-2b) で
  // categories を並べる。 comparator 本体は `@/lib/tags/sort-comparator` の共有版
  // (有効数値=順序母数 / null・undefined・非数値・空文字=末尾) を使用。
  const sortedCategories = React.useMemo(
    () => [...categories].sort(sortByKeyThenCreated),
    [categories],
  )

  const selectedCategory =
    stage === 'option' && selectedCategoryId !== null
      ? (categories.find((c) => c.id === selectedCategoryId) ?? null)
      : null

  const categoryOptions = React.useMemo(() => {
    if (!selectedCategoryId) return []
    return options
      .filter((o) => o.category_id === selectedCategoryId)
      .sort(sortByKeyThenCreated)
  }, [options, selectedCategoryId])

  const selectedOptionIds = React.useMemo(
    () =>
      new Set(
        allAssignedOptionIds.filter((id) =>
          categoryOptions.some((o) => o.id === id),
        ),
      ),
    [allAssignedOptionIds, categoryOptions],
  )

  // 編集対象の entity を解決する。 editTargetId が null または外部で削除済みのとき null。
  const editTarget = React.useMemo(() => {
    if (stage === 'editCategory') {
      return categories.find((c) => c.id === editTargetId) ?? null
    }
    if (stage === 'editOption') {
      return options.find((o) => o.id === editTargetId) ?? null
    }
    return null
  }, [stage, editTargetId, categories, options])

  // Tag-4c-2a-fix Task 3 / Tag-4c-2a-fix-2 Task 1: createCategoryType stage 表示直後に
  // 「マルチセレクト」 button へ初期 focus を当てる (multi が default 設計、 spec §5)。
  React.useEffect(() => {
    if (stage === 'createCategoryType') {
      multiButtonRef.current?.focus()
    }
  }, [stage])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      // closed → 再開時は stage 1 から始まるよう全 state をリセット
      // (Tag-4c-2a-fix Task 3: 旧 createForm reset は不要、 createCategoryType stage は
      //  pendingCategoryName のみ保持。 popover close で null に戻す)
      setStage('category')
      setSelectedCategoryId(null)
      setEditTargetId(null)
      setLastError(null)
      setCreateError(null)
      setIsSubmittingCreate(false)
      setPendingCategoryName(null)
      // Tag-4c-2b T5: 次回 open 時に filter 空 + D&D 有効を保証するため、
      // popover 側で握る filter 鏡像も明示 reset (内部 CardTagOptionList は再 mount で
      // 自前 reset するが、 popover 側 state は close で残ると DndContext gate が
      // 次 open 直後に誤判定する可能性があるため両側で reset)。
      setStage1FilterText('')
      setStage2FilterText('')
    } else {
      // Grid-1 T3: open 時に initialStage / initialCategoryId で stage / selectedCategoryId を初期化。
      // initialStage='option' + initialCategoryId=null/undefined は防御的に 'category' fallback
      // (stage='option' 状態で selectedCategoryId=null は既存ロジックで option list が表示されないため)。
      const effectiveInitialStage: Stage =
        initialStage === 'option' && (initialCategoryId == null)
          ? 'category'
          : initialStage ?? 'category'
      setStage(effectiveInitialStage)
      setSelectedCategoryId(initialCategoryId ?? null)
    }
  }

  // Tag-4c-2a-fix Task 2: category 用 kebab handler は CardTagOptionList の
  // onRowAction callback に集約したため、 旧 handleCategoryKebabClick /
  // handleCategoryKebabKeyDown は削除。

  // Tag-4c-2b T5: stage1 / stage2 共通の DragEnd handler。 active/over が同 id の no-op、
  // または over が null (drop 圏外) のときは早期 return (spec §4.5)。 arrayMove で新順序
  // を構築し orderedIds として onReorder へ流す。 T6 で配線される handleReorderX が
  // reindexSortKeys (差分抽出) + Dexie tx atomic + enqueue を担う。
  const handleStage1DragEnd = (
    event: DragEndEvent,
    items: ClientTagCategory[],
    onReorder: (orderedIds: string[]) => Promise<void>,
  ) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex((c) => c.id === active.id)
    const newIndex = items.findIndex((c) => c.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(items, oldIndex, newIndex)
    void onReorder(next.map((c) => c.id))
  }

  const handleStage2DragEnd = (
    event: DragEndEvent,
    items: ClientTagOption[],
    categoryId: string,
    onReorder: (categoryId: string, orderedIds: string[]) => Promise<void>,
  ) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex((o) => o.id === active.id)
    const newIndex = items.findIndex((o) => o.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(items, oldIndex, newIndex)
    void onReorder(categoryId, next.map((o) => o.id))
  }

  // Tag-4c-2b T5: filter 空判定で D&D 有効を gate する (spec §4.5 不変条件)。
  // trim 後の空文字判定 (前方スペースのみの入力は「filter 空」 として扱う、
  // CardTagOptionList 内の filteredOptions ロジックと一致 = trimmed.length === 0)。
  // DndContext は親 stage 内では常時 mount し、 handle 表示の最終 gate は
  // CardTagOptionList.dndEnabled へ渡してそこで isSortable && dndEnabled の AND
  // で取る (filter 中の input remount を避けるため)。
  const isStage1DragEnabled = stage1FilterText.trim().length === 0
  const isStage2DragEnabled = stage2FilterText.trim().length === 0

  const handleOptionRowAction = (optionId: string) => {
    setEditTargetId(optionId)
    setStage('editOption')
    setLastError(null)
  }

  // Tag-4c-2a-fix Task 3 / Tag-4c-2a-fix-2 Task 1: createCategoryType stage の type 確定 handler。
  // 「シングルセレクト」「マルチセレクト」 button の共通 onClick (引数で分岐)。
  // Important 2: isSubmittingCreate で二重発火を防ぐ。 disabled に加え
  // handler 先頭でも短絡し、 await 解決前の連打で entity_mutation を 2 件
  // enqueue するのを防ぐ。
  const handleConfirmType = async (selectType: 'single' | 'multi') => {
    if (isSubmittingCreate || !pendingCategoryName || !tagEditCallbacks) return
    setIsSubmittingCreate(true)
    try {
      const { id } = await tagEditCallbacks.createCategory(
        pendingCategoryName,
        selectType,
      )
      setSelectedCategoryId(id)
      setStage('option')
      setPendingCategoryName(null)
      setCreateError(null)
    } catch {
      setCreateError('作成に失敗しました')
    } finally {
      setIsSubmittingCreate(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label="タグを追加"
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-700 hover:border-slate-400"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            <span>タグ</span>
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent
        className="min-w-56 max-w-sm p-0"
        // Tag-4c-2c hotfix H5 / H7a: popover が画面左右端で起動したとき端ギリギリに寄りすぎ
        // handle (24px) / kebab (28px) の操作が困難になる症状を Radix Popover の
        // collisionPadding={16} (端最小 16px (1rem) 余白) + sideOffset={4} (trigger 距離 4px) +
        // avoidCollisions={true} (Radix default、 端で自動 flip) で解消。
        // H7a: H5 で入れた 8px が OT 実機確認で端からの距離が不足判定、 16 (= 1rem) に bump。
        collisionPadding={16}
        sideOffset={4}
        avoidCollisions={true}
        onEscapeKeyDown={(e) => {
          // Tag-4c-2c hotfix H6: dnd-kit KeyboardSensor の cancel 経路は
          // `event.preventDefault()` を呼ぶ (node_modules/@dnd-kit/core/dist/
          // core.esm.js:1332 `handleCancel`)。 drag 中 Esc は drag cancel のみで
          // popover stage 階層 / popover close を起動しない構造を、 native event
          // の `defaultPrevented` を gate にして実現する。 通常 Esc (drag 中でない)
          // は既存 Notion 方式 stage 階層 / shadcn 標準 close に流れる。
          if (e.defaultPrevented) return
          // Notion 方式拡張 (5 stage、 Tag-4c-2a-fix Task 3 で createCategoryType に置換):
          // editCategory → category / editOption → option
          // createCategoryType → category (+ pendingCategoryName / createError reset)
          // option → category / category は shadcn 標準 (popover を close)
          if (stage === 'editCategory') {
            e.preventDefault()
            setStage('category')
          } else if (stage === 'editOption') {
            e.preventDefault()
            setStage('option')
          } else if (stage === 'createCategoryType') {
            e.preventDefault()
            setStage('category')
            setPendingCategoryName(null)
            setCreateError(null)
          } else if (stage === 'option') {
            e.preventDefault()
            setStage('category')
            // Important 1: option stage で発生した createError を持ち越さない。
            // (別カテゴリを次に選んだとき stale error が表示されるのを防ぐ)
            setCreateError(null)
          }
          // stage 'category' の Esc は何もしない → shadcn 標準で popover close
        }}
      >
        {/* ------------------------------------------------------------------ */}
        {/* Stage 1: カテゴリ選択 (Tag-4c-2a-fix Task 2: combobox 化)           */}
        {/* CardTagOptionList kind='category' に集約。 旧 ul/li + 末尾「+ カテゴリ */}
        {/* を追加」 button + 0 件 placeholder JSX は削除し、 内部 render に統合。 */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'category' && (
          <div className="py-1">
            {/* Tag-4c-2b T5: stage1 D&D 配線。 onReorderCategories が渡された
                ときだけ DndContext + SortableContext を mount。 filter 中の handle
                非表示は CardTagOptionList の dndEnabled={filter 空} で gate
                (DndContext は常時 mount、 input の filterText / focus が remount
                で吹き飛ばない構造)。 SortableContext.items は filter 状態に関わらず
                full sorted list の id 列を渡す (spec §4.2「reindex 全件前提」 と
                pair の不変条件)。 onReorderCategories 未指定 (T6 配線前 / 編集
                popover 経路) は素の CardTagOptionList を render し既存挙動互換。
                T5 fix I-2: 子へは sortable boolean のみ渡し (handle UI 表示 gate)、
                実 reorder dispatch は本 DndContext.onDragEnd → handleStage1DragEnd
                → onReorderCategories(orderedIds) 経路で行う (prop 名と実体一致)。 */}
            {onReorderCategories ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(e) =>
                  handleStage1DragEnd(e, sortedCategories, onReorderCategories)
                }
              >
                <SortableContext
                  items={sortedCategories.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <CardTagOptionList
                    kind="category"
                    options={sortedCategories}
                    onToggle={(categoryId) => {
                      setSelectedCategoryId(categoryId)
                      setStage('option')
                      setCreateError(null)
                    }}
                    onRowAction={selectOnly ? undefined : (categoryId) => {
                      setEditTargetId(categoryId)
                      setStage('editCategory')
                      setLastError(null)
                    }}
                    onCreateNew={selectOnly ? undefined : async (name) => {
                      setPendingCategoryName(name)
                      setStage('createCategoryType')
                      setCreateError(null)
                    }}
                    createError={null}
                    searchPlaceholder={categorySearchPlaceholder}
                    searchAriaLabel={categorySearchAriaLabel}
                    emptyPlaceholderText={categoryEmptyPlaceholder}
                    onFilterChange={setStage1FilterText}
                    sortable
                    dndEnabled={isStage1DragEnabled}
                  />
                </SortableContext>
              </DndContext>
            ) : (
              <CardTagOptionList
                kind="category"
                options={sortedCategories}
                onToggle={(categoryId) => {
                  setSelectedCategoryId(categoryId)
                  setStage('option')
                  setCreateError(null)
                }}
                onRowAction={selectOnly ? undefined : (categoryId) => {
                  setEditTargetId(categoryId)
                  setStage('editCategory')
                  setLastError(null)
                }}
                onCreateNew={selectOnly ? undefined : async (name) => {
                  setPendingCategoryName(name)
                  setStage('createCategoryType')
                  setCreateError(null)
                }}
                createError={null}
                searchPlaceholder={categorySearchPlaceholder}
                searchAriaLabel={categorySearchAriaLabel}
                emptyPlaceholderText={categoryEmptyPlaceholder}
              />
            )}
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 2: option 選択                                                */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'option' && selectedCategory !== null && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setStage('category')
                  // Important 1: option stage で残った createError を持ち越さない。
                  setCreateError(null)
                }}
                aria-label="カテゴリ選択へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>カテゴリ選択へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t py-1">
              {/* Tag-4c-2b T5: stage2 D&D 配線。 onReorderOptions が渡された
                  ときだけ DndContext + SortableContext を mount。 handle 表示の
                  最終 gate は CardTagOptionList.dndEnabled (filter 空判定) で行う。
                  stage1 と同じ filter ↔ D&D 整合不変条件 (spec §4.5)。
                  selectedCategory は本 block 内で non-null 保証されている。
                  T5 fix I-2: 子へは sortable boolean のみ渡し、 実 reorder dispatch は
                  本 DndContext.onDragEnd → handleStage2DragEnd で categoryId を
                  curry → onReorderOptions(categoryId, orderedIds) 経路で行う
                  (旧 onReorder closure wrapper を削除 = prop 名と実体一致)。 */}
              {onReorderOptions ? (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(e) =>
                    handleStage2DragEnd(
                      e,
                      categoryOptions,
                      selectedCategory.id,
                      onReorderOptions,
                    )
                  }
                >
                  <SortableContext
                    items={categoryOptions.map((o) => o.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <CardTagOptionList
                      options={categoryOptions}
                      selectedOptionIds={selectedOptionIds}
                      selectType={selectedCategory.select_type}
                      onToggle={(optId) => onToggle(selectedCategory.id, optId)}
                      onClose={() => setOpen(false)}
                      onRowAction={selectOnly ? undefined : handleOptionRowAction}
                      selectedCategoryId={selectedCategoryId}
                      searchPlaceholder={optionSearchPlaceholder}
                      searchAriaLabel={optionSearchAriaLabel}
                      emptyPlaceholderText={optionEmptyPlaceholder}
                      onCreateNew={selectOnly ? undefined : async (name) => {
                        if (!tagEditCallbacks || isSubmittingCreate) return
                        // 型 narrowing のみ (optional 化)。実経路では必ず override 済み。
                        if (!tagEditCallbacks.createOptionAndAssign) return
                        setIsSubmittingCreate(true)
                        try {
                          await tagEditCallbacks.createOptionAndAssign(
                            selectedCategory.id,
                            name,
                          )
                          setCreateError(null)
                        } catch {
                          setCreateError('作成に失敗しました')
                        } finally {
                          setIsSubmittingCreate(false)
                        }
                      }}
                      createError={createError}
                      onFilterChange={setStage2FilterText}
                      sortable
                      dndEnabled={isStage2DragEnabled}
                    />
                  </SortableContext>
                </DndContext>
              ) : (
                <CardTagOptionList
                  options={categoryOptions}
                  selectedOptionIds={selectedOptionIds}
                  selectType={selectedCategory.select_type}
                  onToggle={(optId) => onToggle(selectedCategory.id, optId)}
                  onClose={() => setOpen(false)}
                  onRowAction={selectOnly ? undefined : handleOptionRowAction}
                  selectedCategoryId={selectedCategoryId}
                  searchPlaceholder={optionSearchPlaceholder}
                  searchAriaLabel={optionSearchAriaLabel}
                  emptyPlaceholderText={optionEmptyPlaceholder}
                  onCreateNew={selectOnly ? undefined : async (name) => {
                    if (!tagEditCallbacks || isSubmittingCreate) return
                    // 型 narrowing のみ (optional 化)。実経路では必ず override 済み。
                    if (!tagEditCallbacks.createOptionAndAssign) return
                    setIsSubmittingCreate(true)
                    try {
                      await tagEditCallbacks.createOptionAndAssign(
                        selectedCategory.id,
                        name,
                      )
                      setCreateError(null)
                    } catch {
                      setCreateError('作成に失敗しました')
                    } finally {
                      setIsSubmittingCreate(false)
                    }
                  }}
                  createError={createError}
                />
              )}
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 3: カテゴリ編集 (editCategory)                               */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'editCategory' && editTargetId !== null && editTarget !== null && tagEditCallbacks && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => setStage('category')}
                aria-label="カテゴリ選択へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>カテゴリ選択へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t px-3 py-3">
              {/* Tag-4c-2a-fix-2 Fix-3: editTargetId 変化で再 mount → useEffect 再発火で全選択 focus */}
              <CardTagEditFields
                key={editTargetId ?? 'none'}
                kind="category"
                name={editTarget.name}
                color={editTarget.color ?? null}
                onRename={async (n) => {
                  try {
                    await tagEditCallbacks.renameCategory(editTargetId, n)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onColorChange={async (c) => {
                  try {
                    await tagEditCallbacks.setCategoryColor(editTargetId, c)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onDelete={async () => {
                  try {
                    await tagEditCallbacks.deleteCategory(editTargetId)
                    setEditTargetId(null)
                    setStage('category')
                    setLastError(null)
                  } catch {
                    setLastError('削除に失敗しました')
                  }
                }}
                countImpact={async () => {
                  return await tagEditCallbacks.countCategoryImpact(editTargetId)
                }}
                errorMessage={lastError}
              />
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 4: option 編集 (editOption)                                  */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'editOption' && editTargetId !== null && editTarget !== null && tagEditCallbacks && (
          <>
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => setStage('option')}
                aria-label="option 一覧へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>option 一覧へ戻る</span>
              </button>
            </div>
            <div className="mt-1 border-t px-3 py-3">
              {/* Tag-4c-2a-fix-2 Fix-3: editTargetId 変化で再 mount → useEffect 再発火で全選択 focus */}
              <CardTagEditFields
                key={editTargetId ?? 'none'}
                kind="option"
                name={editTarget.name}
                color={editTarget.color ?? null}
                onRename={async (n) => {
                  try {
                    await tagEditCallbacks.renameOption(editTargetId, n)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onColorChange={async (c) => {
                  try {
                    await tagEditCallbacks.setOptionColor(editTargetId, c)
                    setLastError(null)
                  } catch (e) {
                    setLastError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onDelete={async () => {
                  try {
                    await tagEditCallbacks.deleteOption(editTargetId)
                    setEditTargetId(null)
                    setStage('option')
                    setLastError(null)
                  } catch {
                    setLastError('削除に失敗しました')
                  }
                }}
                countImpact={async () => {
                  return await tagEditCallbacks.countOptionImpact(editTargetId)
                }}
                errorMessage={lastError}
              />
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Stage 5: カテゴリ新規作成 select_type 選択 (createCategoryType)    */}
        {/* Tag-4c-2a-fix Task 3: stage 1 combobox 「新規作成: {name}」 → 本 stage */}
        {/* で single/multi を確定すると mutation 発火 + stage='option' へ遷移。 */}
        {/* ------------------------------------------------------------------ */}
        {stage === 'createCategoryType' && tagEditCallbacks && (
          <div className="py-1">
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setStage('category')
                  setPendingCategoryName(null)
                  setCreateError(null)
                }}
                aria-label="カテゴリ選択へ戻る"
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <ChevronLeft aria-hidden="true" className="h-3 w-3" />
                <span>カテゴリ選択へ戻る</span>
              </button>
            </div>
            {/* Tag-4c-2a-fix-4 Task 2 Fix-3: 2 button block の outer から余分 `px-2`
                を削除し `pb-1` のみ残す。 button class 内の `px-2 py-1.5` で content
                左端 padding を持つため、 outer にも `px-2` を付けると二重になり
                他 stage の row content 左端 (8px) より右へずれていた。 outer から
                除去することで CardTagOptionList の row content と左端を揃える。
                (Fix-2 旧見出し削除 / Fix-3 multi icon CheckSquare=SquareCheckBig は
                 Tag-4c-2a-fix-3 で実施済み。) */}
            <div className="pb-1">
              <button
                type="button"
                disabled={isSubmittingCreate}
                onClick={() => handleConfirmType('single')}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-slate-100 rounded"
              >
                <CircleDot className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <span>シングルセレクト</span>
              </button>
              <button
                type="button"
                ref={multiButtonRef}
                disabled={isSubmittingCreate}
                onClick={() => handleConfirmType('multi')}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-slate-100 rounded"
              >
                <CheckSquare className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <span>マルチセレクト</span>
              </button>
            </div>
            {createError && (
              <p role="alert" className="px-2 text-xs text-red-600">
                {createError}
              </p>
            )}
          </div>
        )}

        {/* Tag-4c-2a Task 4 (spec B-2): 「タグ管理 →」 footer link は撤去。
            タグ管理画面への動線は別 entry (header メニュー等) に集約する設計。 */}
      </PopoverContent>
    </Popover>
  )
}
