'use client'

// CardTagOptionList: option / category 両用の combobox 共通 sub-component
// (Tag-4c-2a-fix Task 1 で kind discriminator を追加して generalize)。
// 新規追加 popover (stage 1 category list / stage 2 option list) と編集 popover
// の両方で使う。 このコンポーネント自体は popover を持たず、 親の PopoverContent
// 内にそのまま差し込まれる。
//
// 設計方針:
// - multi/single を selectType で切り替え。 multi は popover 開いたまま toggle、
//   single は toggle 後に onClose() を呼んで popover を閉じる (kind='option' のみ)。
// - 構造: <div><input /><ul></ul>[<li>新規作成</li>]</div>。 上部の input は常設
//   (combobox: filter + 新規作成導線)。 Tag-4c-2a で追加。
// - 0 件 (= filter hit 0 + 入力空) のときは placeholder のみ。 入力ありで
//   ヒット 0 件 + 完全一致なしのときは「新規作成」 行だけを出す (placeholder 出さない)。
// - kind='option': 完全一致時は新規作成行を抑制 (suppressCreateOnExactMatch=true default)。
//   kind='category': 同名許容のため suppressCreateOnExactMatch=false で呼ぶ。
// - kind='option' のみ Check icon を render し選択状態を可視化。 kind='category'
//   は selectedOptionIds 概念を持たないため Check icon を出さない。
// - a11y: 既存 option 行は role="menuitemcheckbox" (multi) / "menuitemradio" (single)、
//   aria-checked で選択状態を伝達。 kind='category' の場合は選択状態という概念がない
//   ので role="menuitem" を使う (Tag-4c-2a-fix Task 2、 review M-1 反映)。
//   新規作成行は通常の button (役割は名前で識別)。
// - kebab aria-label は kind で出し分け: kind='option' は「option 操作: {name}」、
//   kind='category' は「カテゴリ操作: {name}」 (Tag-4c-2a-fix Task 2、 stage1 category
//   list 移行時のラベル regression 防止)。
// - D&D 並べ替え対応: `sortable={true}` を渡すと handle を表示 + 各 row に
//   useSortable を配線する (Tag-4c-2b T4 + T5 fix I-2 で onReorder 経路から
//   repurpose)。 実 reorder dispatch は親 DndContext の onDragEnd → 親側 reorder
//   handler 経路で行うため、 本 component は callback を持たず boolean フラグだけ
//   受け取る (prop 名と実体の一致 = 子は「handle UI を出すか」 だけ判断、 親が
//   DndContext.onDragEnd で id 列を組んで親 handler を呼ぶ)。

import * as React from 'react'
import { Check, CheckSquare, CircleDot, Ellipsis, GripVertical, Plus } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { colorToClass } from '@/lib/tags/color-palette'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * combobox 行に必要な最小構造 (id / name / color / select_type)。
 * ClientTagOption / ClientTagCategory どちらも structural に satisfy する。
 * `options` prop の型を最小化することで kind='category' 呼出時に
 * `ClientTagCategory[]` を渡せるようにしている (Tag-4c-2a-fix Task 1)。
 *
 * `select_type` は kind='category' のときのみ意味があり、 row 行頭に小 icon
 * (single → CircleDot / multi → CheckSquare) を render する (Tag-4c-2a-fix-3
 * Fix-4)。 `ClientTagOption` は select_type を持たないため undefined となり、
 * icon は出ない。
 */
export type TagComboboxItem = {
  id: string
  name: string
  color?: string | null
  select_type?: 'single' | 'multi'
}

type Props = {
  options: TagComboboxItem[]
  /** kind='option' で必須意味、 kind='category' では undefined / 空 Set を受け取り、
   *  Check icon を出さない (defensive: undefined access しない)。 */
  selectedOptionIds?: Set<string>
  /** kind='option' のみ意味あり。 kind='category' では undefined。
   *  single 自動 close を含む既存ロジックは kind='option' のときのみ走る。 */
  selectType?: 'single' | 'multi'
  onToggle: (optionId: string) => void
  /** single 選択時に popover を閉じるための callback。 親 popover から渡す。 */
  onClose?: () => void
  /** option 行末尾の kebab (「...」) click 時に optionId で呼ばれる callback。
   *  提供時のみ kebab を表示する。 Tag-4c-1 Task 3 で追加。 */
  onRowAction?: (optionId: string) => void
  /** 親 category id。 変化を監視して filterText を reset する (stage 遷移時 cleanup)。
   *  Tag-4c-2a Task 2 で追加。 kind='option' のとき意味あり、 kind='category' では
   *  undefined で reset 不要。 */
  selectedCategoryId?: string | null
  /** 「新規作成: {入力値}」 行 click で呼ばれる callback。 引数は trim 済 input。
   *  Tag-4c-2a Task 2 で追加。 popover 側 (CardTagAddPopover) で配線される。 */
  onCreateNew?: (name: string) => Promise<void>
  /** popover 側で握っている作成 error。 非 null のとき inline error を表示する。
   *  Tag-4c-2a Task 2 で追加。 */
  createError?: string | null
  /** 表示モード判定 (Tag-4c-2a-fix Task 1):
   *  - 'option' (default): Check icon を出す / single 自動 close を行う / aria-label
   *    / placeholder の default 文言は option 文脈
   *  - 'category': Check icon 非表示、 single 自動 close も無し */
  kind?: 'option' | 'category'
  /** 完全一致時に新規作成行を抑制するか (Tag-4c-2a-fix Task 1):
   *  - true (default, option 既存挙動): 完全一致名入力時に新規作成行を出さない
   *  - false (category 想定): 同名許容のため完全一致でも新規作成行を出す */
  suppressCreateOnExactMatch?: boolean
  /** 上部 input の placeholder text。 default「検索 or 新規作成」 (kind 非依存)。
   *  Tag-4c-2a-fix Task 1 で追加。 */
  searchPlaceholder?: string
  /** 上部 input の aria-label。 default「option を検索 / 新規作成」、 kind='category'
   *  呼出側で「category を検索 / 新規作成」 等に上書きする。
   *  Tag-4c-2a-fix Task 1 で追加。 */
  searchAriaLabel?: string
  /** items 0 件 + 新規作成行も出ないときの placeholder 文言の上書き。
   *  default「タグ名を入力し新規作成」 (Tag-4c-2a-fix-4 Task 1 で短文化、
   *  stage B (新規 category 作成直後の option 0 件) 用 popover 膨張源を除去)。
   *  Tag-4c-2a-fix Task 1 で追加。 */
  emptyPlaceholderText?: string
  /** D&D 並べ替え対応を有効化する (Tag-4c-2b T5 fix I-2 で onReorder から repurpose)。
   *  true のとき handle button を render + 各 row に useSortable を配線する
   *  (親が DndContext + SortableContext で囲んだ前提)。 実 reorder dispatch は
   *  親 DndContext の onDragEnd → 親側 reorder handler 経路で行うため、 子は
   *  callback を持たず boolean フラグのみ受け取る (prop 名と実体の一致)。
   *  default false / 未指定 → handle 非表示 + useSortable 呼ばない (既存挙動)。 */
  sortable?: boolean
  /** filter 入力 (text input) 変化を親に伝える callback (Tag-4c-2b T5)。
   *  popover 親が「filter 空のときだけ handle を出す」 不変条件 (spec §4.5) を
   *  成立させるため、 内部 filterText state を親へ漏らす経路。 trim 前の生入力を渡す
   *  (空文字判定は親で trim して行う)。 未指定 → 既存挙動 (filter は内部 state のまま)。 */
  onFilterChange?: (text: string) => void
  /** D&D handle を表示するか (Tag-4c-2b T5)。 親 popover が filter 空判定で gate する。
   *  default true (T4 既存挙動互換、 親が gate しない場合は sortable + items >= 2
   *  だけで handle が出る)。 false のときは sortable=true でも handle 非表示にし、
   *  SortableContext + useSortable は引き続き正常動作する (DndContext は親で常時
   *  mount され input の focus/filterText が remount で吹き飛ばないようにするための
   *  gate)。 */
  dndEnabled?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardTagOptionList({
  options,
  selectedOptionIds,
  selectType,
  onToggle,
  onClose,
  onRowAction,
  selectedCategoryId,
  onCreateNew,
  createError,
  kind = 'option',
  suppressCreateOnExactMatch = true,
  searchPlaceholder = '検索 or 新規作成',
  searchAriaLabel = 'option を検索 / 新規作成',
  emptyPlaceholderText = 'タグ名を入力し新規作成',
  sortable = false,
  onFilterChange,
  dndEnabled = true,
}: Props) {
  const [filterText, setFilterText] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  // mount 時に input へ focus (stage2 表示直後の自動 focus、 spec §C-1a)
  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // category 変化で filter をリセットする (stage 遷移時 cleanup)
  React.useEffect(() => {
    setFilterText('')
    // Tag-4c-2b T5: 親 popover が gate に使う filterText も同期 reset。
    onFilterChange?.('')
    // onFilterChange は値書込専用 side channel (React useState setter は identity
    // 安定 + 親で setStageNFilterText を直接渡す経路)、 effect の trigger は
    // selectedCategoryId 単独で十分。 onFilterChange を deps に入れると親 callback の
    // identity 変化で意図せず filter が再 reset される副作用が出るため除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategoryId])

  const trimmed = filterText.trim()
  const lower = trimmed.toLowerCase()
  const filteredOptions = options.filter((o) =>
    o.name.toLowerCase().includes(lower),
  )
  const exactMatchExists = options.some(
    (o) => o.name.trim().toLowerCase() === lower,
  )
  // suppressCreateOnExactMatch=false の場合は完全一致でも新規作成行を表示する
  // (category list は同名許容のためこちらを使う)。
  const showCreateRow =
    trimmed.length > 0 && (!suppressCreateOnExactMatch || !exactMatchExists)

  // option list 0 件 + 新規作成行も非表示 (= 入力空 + options 空、 または入力空 + filter hit 0)
  // のときのみ placeholder を出す。 入力ありで新規作成行が出るときは placeholder 出さない。
  const showEmptyPlaceholder = filteredOptions.length === 0 && !showCreateRow

  // D&D 並べ替え可否判定 (Tag-4c-2b T4 / T5 / T5 fix I-2):
  // - sortable=false (default) → 既存挙動 (handle 非表示、 useSortable 呼ばない)
  // - options.length < 2 → 並べ替え不要なので handle 非表示 (spec §7 D-3 (a))
  //   ※ filteredOptions ではなく props の options (全 list) で判定する。 filter で
  //     2+ 件から 1 件に絞られた途中状態でも、 filter 中は dndEnabled=false で
  //     handle が消える別 gate があるため、 ここの母数は全件で OK
  //     (filter 中の handle 非表示は dndEnabled が一手に担う)。
  // - dndEnabled=false (親 gate) → handle 非表示 (T5: filter 中は親が false にする
  //   ことで「filter 中は drag 起動しない」 不変条件を成立)
  // Hook ルール (条件付き呼出不可) のため row 自体を sub-component に分け、
  // sortable 時のみ SortableRow を render する。
  const isSortable = !!sortable && options.length >= 2 && dndEnabled

  const handleClick = (optionId: string) => {
    onToggle(optionId)
    // single 自動 close は kind='option' のときのみ走る (spec Task 1 制約)。
    if (kind === 'option' && selectType === 'single') {
      onClose?.()
    }
  }

  const handleCreateNewClick = async () => {
    if (!onCreateNew) return
    try {
      await onCreateNew(trimmed)
      setFilterText('')
      onFilterChange?.('')
    } catch {
      // error は popover 側で createError 経由表示。 filter は空に戻す方が再試行で別名
      // 入力しやすい。
      setFilterText('')
      onFilterChange?.('')
    }
  }

  return (
    <div>
      <div className="px-2 pb-1">
        <input
          ref={inputRef}
          type="text"
          value={filterText}
          onChange={(e) => {
            setFilterText(e.target.value)
            // Tag-4c-2b T5: 親 popover が filter 空判定で DndContext mount を gate
            // するため、 内部 filterText を親へ漏らす (onFilterChange 未指定なら no-op)。
            onFilterChange?.(e.target.value)
          }}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
      </div>
      {showEmptyPlaceholder ? (
        <p className="px-2 py-3 text-center text-sm text-slate-500">
          {emptyPlaceholderText}
        </p>
      ) : (
        <ul role="menu">
          {filteredOptions.map((option) => {
            // kind='category' では selectedOptionIds 概念がないため undefined を許容。
            // Check icon の render 判定にしか使わないため defensive に false 落ち。
            const selected =
              kind === 'option' && (selectedOptionIds?.has(option.id) ?? false)
            // kind='category' は選択状態という概念がないため role="menuitem"。
            // kind='option' のときは selectType に応じて checkbox/radio を使い分け。
            const role =
              kind === 'category'
                ? 'menuitem'
                : selectType === 'multi'
                  ? 'menuitemcheckbox'
                  : 'menuitemradio'

            // sortable と static で同一の row 内 JSX (main button + kebab) を共有。
            // 差分は handle button の有無 + <li> 自体 (ref/style) のみ。
            const rowInner = (
              <RowInner
                option={option}
                kind={kind}
                role={role}
                selected={selected}
                onMainClick={() => handleClick(option.id)}
                onRowAction={onRowAction}
              />
            )

            return isSortable ? (
              <SortableRow key={option.id} option={option} kind={kind}>
                {rowInner}
              </SortableRow>
            ) : (
              <StaticRow key={option.id}>{rowInner}</StaticRow>
            )
          })}
          {showCreateRow && (
            <li>
              <button
                type="button"
                onClick={handleCreateNewClick}
                aria-label={`新規作成: ${trimmed}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700',
                  'transition-colors hover:bg-slate-100',
                )}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="break-all">新規作成: {trimmed}</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {createError && (
        <p role="alert" className="mt-1 px-2 text-xs text-red-600">
          {createError}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row sub-components (Tag-4c-2b T4)
// ---------------------------------------------------------------------------

// row 内の main button + 任意 kebab。 sortable / static 共通の JSX を 1 箇所に
// 寄せて drift を防ぐ。 handle button (sortable のみ) は SortableRow が外側に
// 差し込み、 本 inner には含めない (= main / kebab には listeners/attributes が
// 絶対乗らないという event 分離契約の構造表現)。
type RowInnerProps = {
  option: TagComboboxItem
  kind: 'option' | 'category'
  role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio'
  selected: boolean
  onMainClick: () => void
  onRowAction?: (optionId: string) => void
}

function RowInner({
  option,
  kind,
  role,
  selected,
  onMainClick,
  onRowAction,
}: RowInnerProps) {
  return (
    <>
      <button
        type="button"
        role={role}
        // kind='category' (role='menuitem') では aria-checked を付けない
        // (a11y: menuitem は checked state を持たない)。
        aria-checked={kind === 'option' ? selected : undefined}
        aria-label={option.name}
        onClick={onMainClick}
        className={cn(
          'flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
          'transition-colors hover:bg-slate-100',
        )}
      >
        {/* select_type icon: kind='category' のみ。 single → CircleDot,
            multi → CheckSquare。 option 行 (kind='option') では出さない
            (Tag-4c-2a-fix-3 Fix-4)。 */}
        {kind === 'category' && option.select_type === 'single' && (
          <CircleDot
            className="h-3.5 w-3.5 text-slate-400"
            aria-hidden="true"
          />
        )}
        {kind === 'category' && option.select_type === 'multi' && (
          <CheckSquare
            className="h-3.5 w-3.5 text-slate-400"
            aria-hidden="true"
          />
        )}
        {/* color pill */}
        <span
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium break-all',
            colorToClass(option.color),
          )}
          aria-hidden="true"
        >
          {option.name}
        </span>
        {/* check icon: selected のみ表示 */}
        {selected && (
          <Check
            className="ml-auto h-4 w-4 shrink-0 text-slate-700"
            data-testid={`check-${option.id}`}
            aria-hidden="true"
          />
        )}
      </button>
      {/* kebab: onRowAction が渡されたときのみ表示。
          aria-label は kind で出し分け (Tag-4c-2a-fix Task 2)。 */}
      {onRowAction && (
        <button
          type="button"
          aria-label={
            kind === 'category'
              ? `カテゴリ操作: ${option.name}`
              : `option 操作: ${option.name}`
          }
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onRowAction(option.id)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              onRowAction(option.id)
            }
          }}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center cursor-pointer hover:bg-slate-100 rounded"
        >
          <Ellipsis className="h-4 w-4 text-slate-500" aria-hidden="true" />
        </button>
      )}
    </>
  )
}

// 既存挙動踏襲: useSortable 呼ばない、 handle button 出さない。
// onReorder 未指定 (= 親が SortableContext で囲まない) のときに使う。
function StaticRow({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center">{children}</li>
}

// D&D 並べ替え用: useSortable を常に呼ぶ + handle button を行頭に追加。
// 親が DndContext + SortableContext で囲んだ前提でのみ render される
// (CardTagOptionList の isSortable 判定経由)。 event 分離契約 (handle のみに
// listeners/attributes/touch-none、 main/kebab に絶対 spread しない) は
// この構造で表現される。
function SortableRow({
  option,
  kind,
  children,
}: {
  option: TagComboboxItem
  kind: 'option' | 'category'
  children: React.ReactNode
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
      {/* handle button: listeners/attributes はここだけに spread。 main button /
          kebab に絶対乗せない (event 分離契約、 spec §4.1)。 touch-none も
          handle のみで main の縦 scroll / tap を殺さない。 */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...listeners}
        {...attributes}
        aria-label={`${kind === 'category' ? 'カテゴリ' : 'option'}を並べ替え: ${option.name}`}
        className="inline-flex h-7 w-6 cursor-grab items-center justify-center touch-none text-slate-400 hover:text-slate-600"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {children}
    </li>
  )
}
