'use client'

// 試験詳細 page (/app/exams/[id]) の選択肢 inline 編集。
//
// Stage 4 (Task 4.2) で **local-first 書込**に cutover (text field と同方針):
// cell blur / checkbox toggle / add / delete の各 commit で即時に
//   1. mirror 直書き  : getClientDb().cards.update(cardId, { options, correct_answer_ids })
//   2. outbox enqueue : enqueueEntityMutation({ entity_type: 'card', op: 'update_field', patch: { field: 'options', value } })
// を実行し、 server への実 drain は 500ms debounce 後に runGuardedEntityMutationFlush()
// を 1 回叩く (送信遅延ではなく drain trigger の debounce)。
// `value` は bulk endpoint の update_field/options が期待する camelCase ZodOption[]
// (= lib/cards/card-field-handlers.ts の CARD_FIELD_HANDLERS.options handler 内の
// optionsSchema が受ける形)。 `correct_answer_ids` は mirror に楽観反映するためだけ
// に client 側で is_correct から derive し、 server には送らない (server が
// CARD_FIELD_HANDLERS.options handler 内で is_correct から再生成、 Stage1 踏襲)。
//
// 構造:
// - `InlineOptionList` (export): card 単位の親。 useCardOptions hook を通じて
//   options working-set state (ghost row を含む表示 + payload 構築の真実 source)
//   + commit/drain を集約。 全 row の payload は共有 state の snapshot で build する
//   ため cross-row race が起きない。
// - `InlineOptionRow` (un-export): controlled view。 内部 state は cell の edit のみ。
//   commit 機構は持たず callback で親に委譲。
//
// rollback は pull-reconciliation に再構成: 拒否された編集は server に届かず、 次の
// pull/pull-back が server 確定値を mirror に bulkPut → serverOptions prop 経由で
// 降りてきて、 in-progress でなければ merge useEffect が working-set を更新する。
// component 内の同期 rollback / inFlight / queue / checkbox 個別 inFlight は撤去した
// (flush engine が Web Locks + in-flight Set + mutation_id UNIQUE で直列化・冪等化)。
//
// Ghost row (S2.0b-3 + follow-up merge fix): 「+ 選択肢を追加」 で working-set に
// 追加された text='' の optimistic row。 server zod が reject するため commit payload
// (mirror + enqueue 双方) からは sanitized で除外する。 working-set には残し user の
// 編集中値を保護。 serverOptions prop 変化時の merge では、 server に無い local ghost の
// うち「text あり (commit in-flight)」または「autoEditOptionId (+追加直後の編集対象)」
// のみ末尾保持し、 放置された空 ghost は drop する (1-a fix。 70d0714 の typing 保護は
// 維持しつつ末尾残留を解消)。 註: autoEditOptionId は add 時 set のみで reset しないため、
// 「空 ghost 追加後に既存 row を編集」 した場合のみ空 ghost が autoEdit 扱いで残るが、
// 永続化はされず報告 repro (連続 ghost 追加) の対象外。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { CardOption } from '@/lib/db/schema'
import { useCardOptions } from '../_hooks/use-card-options'
import { cn } from '@/lib/utils'

// ============================================================================
// InlineOptionList (per-card parent)
// ============================================================================

type InlineOptionListProps = {
  cardId: string
  options: CardOption[]
}

export function InlineOptionList({
  cardId,
  options: serverOptions,
}: InlineOptionListProps) {
  const {
    options,
    autoEditOptionId,
    canDelete,
    correctIds,
    handleCellSave,
    handleCheckboxToggle,
    handleAddOption,
    handleDeleteOption,
  } = useCardOptions(cardId, serverOptions)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">
          選択肢 ({options.length} 件)
        </p>
        {correctIds.length > 0 && (
          <p className="text-base font-medium text-emerald-700">
            ○ 正解: {correctIds.join(', ')}
          </p>
        )}
      </div>
      <ul className="mt-1 space-y-1.5">
        {options.map((opt, idx) => (
          <li key={opt.id}>
            <InlineOptionRow
              option={opt}
              autoEditTextOnMount={opt.id === autoEditOptionId}
              canDelete={canDelete}
              onCheckboxToggle={(nextChecked) =>
                handleCheckboxToggle(idx, nextChecked)
              }
              onCellSave={(nextOption) => handleCellSave(idx, nextOption)}
              onDelete={() => handleDeleteOption(idx)}
            />
          </li>
        ))}
      </ul>
      {/* S2.0b-3 「+ 選択肢を追加」 ボタン。 list 末尾に常時 dashed border で表示。 */}
      <button
        type="button"
        onClick={handleAddOption}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        + 選択肢を追加
      </button>
    </div>
  )
}

// ============================================================================
// InlineOptionRow (controlled view, presentational)
// ============================================================================

type InlineOptionRowProps = {
  option: CardOption
  // S2.0b-3: 「+ 選択肢を追加」 直後に new row の text cell を auto-edit するための
  // marker。 InlineOptionCell の useState initializer に渡って mount 時のみ有効。
  autoEditTextOnMount: boolean
  // options.length === 1 の row では削除 button を disabled に。
  canDelete: boolean
  onCheckboxToggle: (nextChecked: boolean) => void
  onCellSave: (nextOption: CardOption) => void
  onDelete: () => void
}

// 内部実装: server boundary を跨いで使われないため、 function callback props を
// 安全に取れる (= 'use client' top-level export 制約を回避するため un-export 化)。
//
// レイアウト (S2.0b-3): CSS Grid で 1 つの explanation cell instance を viewport で
// 配置場所だけ切替える。
// - Mobile (md 未満): 4 列 grid `[auto / 5rem / 1fr / auto]`
//     row 1: [✓] [id] [本文] [削除] / row 2: [解説 col-span-full]
// - Desktop (md 以上): 5 列 grid `[auto / 5rem / 1fr / 1fr / auto]`
//     row 1: [✓] [id] [本文] [解説] [削除]
function InlineOptionRow({
  option,
  autoEditTextOnMount,
  canDelete,
  onCheckboxToggle,
  onCellSave,
  onDelete,
}: InlineOptionRowProps) {
  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onCheckboxToggle(e.target.checked)
  }

  return (
    <div
      className={
        option.is_correct
          ? 'rounded border border-emerald-300 bg-emerald-100 p-2 md:py-1 text-sm'
          : 'rounded border border-border/60 p-2 md:py-1 text-sm'
      }
    >
      <div className="grid items-start gap-2 md:gap-1 grid-cols-[auto_5rem_minmax(0,1fr)_auto] md:grid-cols-[auto_5rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:self-center cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            aria-label="選択肢 正解フラグ 編集"
            checked={option.is_correct}
            onChange={handleCheckboxChange}
            className="h-6 w-6 md:h-4 md:w-4 cursor-pointer accent-emerald-600"
          />
        </label>
        <div>
          <InlineOptionCell
            kind="id"
            ariaLabel="選択肢 id 編集"
            value={option.id}
            onSave={(value) => onCellSave({ ...option, id: value })}
            displayClassName="text-sm font-mono text-slate-700"
            placeholder="(id)"
          />
        </div>
        <div className="min-w-0">
          <InlineOptionCell
            kind="text"
            ariaLabel="選択肢 本文 編集"
            value={option.text}
            onSave={(value) => onCellSave({ ...option, text: value })}
            displayClassName={
              option.is_correct
                ? 'text-sm font-bold text-emerald-900'
                : 'text-sm text-slate-800'
            }
            autoEditOnMount={autoEditTextOnMount}
          />
        </div>
        {/* explanation: mobile = row 2 全幅 / desktop = row 1 col 4 単独 */}
        <div className="row-start-2 col-span-full min-w-0 md:row-start-1 md:col-start-4 md:col-span-1">
          <InlineOptionCell
            kind="explanation"
            ariaLabel="選択肢 解説 編集"
            value={option.explanation ?? ''}
            onSave={(value) => {
              // 空文字は jsonb から explanation key を drop する (payload bloat 防止、
              // server zod は optional)。
              if (value === '') {
                const { explanation: _drop, ...rest } = option
                onCellSave(rest)
              } else {
                onCellSave({ ...option, explanation: value })
              }
            }}
            displayClassName="text-xs text-slate-600"
            placeholder="解説 (クリックで追加)"
          />
        </div>
        {/* delete: mobile = row 1 col 4 (auto-flow) / desktop = row 1 col 5 (explicit) */}
        <button
          type="button"
          aria-label="選択肢を削除"
          onClick={onDelete}
          disabled={!canDelete}
          className="md:col-start-5 inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:self-center shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
        >
          <span className="text-xl leading-none md:text-base" aria-hidden="true">
            ×
          </span>
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// InlineOptionCell (cell-level editing primitive)
// ============================================================================

type InlineOptionCellProps = {
  kind: 'id' | 'text' | 'explanation'
  ariaLabel: string
  value: string // row の option から派生する display 値 (props 化)
  onSave: (value: string) => void
  displayClassName?: string
  placeholder?: string
  // S2.0b-3: 「+ 選択肢を追加」 直後に new row の text cell を mount 即 edit にする
  // ための one-shot marker。 useState initializer のみ参照、 mount 後は無視。
  autoEditOnMount?: boolean
}

// 表示値は props.value (row の option) を使い、 cell は edit 中の editValue / editing
// のみ持つ。 dirty-guard: 編集中は props.value で editValue を上書きしない。
//
// レイアウト (`InlineTextField` と同方針): display / edit の box 寸法を完全一致させて
// edit 切替時の layout shift を防ぐ。 multiline (text / explanation) は useLayoutEffect
// で scrollHeight に追従させて auto-resize。
export function InlineOptionCell({
  kind,
  ariaLabel,
  value,
  onSave,
  displayClassName,
  placeholder = '(クリックで追加)',
  autoEditOnMount = false,
}: InlineOptionCellProps) {
  const [editValue, setEditValue] = useState<string>(value)
  // initializer は mount 時のみ評価 (subsequent prop change は無視、 one-shot 性)。
  const [editing, setEditing] = useState<boolean>(() => autoEditOnMount)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // dirty-guard: 編集中でなければ props.value (= 親 options[idx]) を editValue に同期。
  // 編集中は user 入力を保護。 React 19 "store info from previous renders" pattern:
  // useEffect を外し、 render 中の guarded setState で同期 (cascading render 回避)。
  const [lastSyncedValue, setLastSyncedValue] = useState(value)
  if (!editing && value !== lastSyncedValue) {
    setLastSyncedValue(value)
    setEditValue(value)
  }

  // multiline textarea の auto-resize: 編集中 + editValue 変化に追従。 useLayoutEffect
  // で paint 前同期実行。 single-line input (kind='id') では instanceof 判定で no-op。
  useLayoutEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!(el instanceof HTMLTextAreaElement)) return
    // '0px' で一旦潰してから scrollHeight を測る。 'auto' だと textarea 既定
    // rows=2 の 2 行枠が clientHeight として残り scrollHeight=2 行で固定され、
    // 1 行内容でも 2 行高さに膨らむ (display とズレる)。 '0px' なら真の内容高を返す。
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [editing, editValue])

  const startEdit = () => {
    setEditing(true)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      startEdit()
    }
  }

  const handleBlur = () => {
    setEditing(false)
    // commit / debounce / short-circuit 判定は全て親 (handleCellSave → commit) で実施。
    onSave(editValue)
  }

  const multiline = kind !== 'id'

  // display / edit で共通の box 寸法 (`InlineTextField` の sharedBoxChrome と同じ値)。
  const sharedBoxChrome = 'block w-full min-h-11 rounded-md p-2 md:min-h-8 md:py-1'

  if (editing) {
    const commonProps = {
      'aria-label': ariaLabel,
      value: editValue,
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => setEditValue(e.target.value),
      onBlur: handleBlur,
      ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
        inputRef.current = el
      },
    }
    return (
      <div className="space-y-1">
        {multiline ? (
          <Textarea
            {...(commonProps as React.ComponentProps<typeof Textarea> & {
              ref: React.Ref<HTMLTextAreaElement>
            })}
            // rows 固定値は使わない (useLayoutEffect が scrollHeight 追従で auto-resize)。
            className={cn(sharedBoxChrome, 'resize-none overflow-hidden', displayClassName)}
          />
        ) : (
          <Input
            {...(commonProps as React.ComponentProps<typeof Input> & {
              ref: React.Ref<HTMLInputElement>
            })}
            type="text"
            className={cn(sharedBoxChrome, displayClassName)}
          />
        )}
      </div>
    )
  }

  const isEmpty = value.length === 0
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={startEdit}
      onKeyDown={onKeyDown}
      className={cn(
        sharedBoxChrome,
        'border border-transparent cursor-text transition-colors hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        isEmpty && 'text-slate-400 italic',
        displayClassName,
      )}
    >
      {isEmpty ? (
        <span>{placeholder}</span>
      ) : (
        <span className="whitespace-pre-wrap break-words">
          {value}
          {/* white-space:pre-wrap は末尾の単一改行に line box を作らず、 末尾改行を
              持つ値が textarea(edit) より 1 行低く表示される。 末尾が改行のときだけ
              装飾 <br> を 1 つ補い、 edit と行数/高さを一致させる (落とされるのは常に
              最後の 1 行のみなので 1 個で N 個ぶん揃う)。 <br> は textContent に寄与
              しないためコピーは値そのまま。 */}
          {value.endsWith('\n') && <br aria-hidden="true" />}
        </span>
      )}
    </div>
  )
}
