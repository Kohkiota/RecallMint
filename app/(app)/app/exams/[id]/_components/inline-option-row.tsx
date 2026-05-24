'use client'

// 試験詳細 page (/app/exams/[id]) の選択肢 inline 編集。
//
// 構造 (S2.0b-2 follow-up 修正で per-card 親 `InlineOptionList` に options state を
// lift up、 cross-row checkbox race を構造的に解消):
//
// - `InlineOptionList` (export): card 単位の親。 options 配列 (state) + send / queue /
//   debounce / mountedRef / serverCommittedRef / per-checkbox inFlight を集約。
//   全 row の payload 構築は **共有 options state の snapshot** で行うため、 user が
//   row 0 → row 1 → row 2 と高速連打しても各送信 payload は累積した最新状態を反映する
//   (旧実装は row 毎に allOptionsRef を保持し他 row の楽観値を見落としていた、 結果
//   「最後の 1 つだけ ON」 になる cross-row race を起こしていた)。
// - `InlineOptionRow` (un-export、 同 file 内 internal): controlled view。 内部 state
//   は cell の edit (editing / editValue) のみ。 送信機構は持たず callback
//   (onCheckboxToggle / onCellSave) で親に委譲。 'use client' top-level export は
//   serializable props 制約があり function callback prop は警告を出すため、 親
//   `InlineOptionList` のみを export し本 row は file-private で扱う。
//
// 送信 contract (親で集中管理):
// - id / text / explanation cell の blur: **500ms debounce** 後に send (連続編集は
//   timer reset で最後の値のみ)。 送信中 (inFlightRef=true) に来た新値は queue に
//   入り 1 並列を維持、 1 完走後に最新 snapshot で連鎖 send。
// - checkbox change: **debounce なし即時 send**。 進行中 text 編集 timer は cancel し、
//   text 楽観値は既に options state に反映済のため checkbox 送信 payload に同梱される。
// - 失敗時: options を `serverCommittedRef.current` に **全 row rollback** + inline
//   error。 queue は破棄して連続失敗 storm を防ぐ。
//
// StrictMode (`reactStrictMode: true` 開発時の effect setup → cleanup → setup 二重
// 実行) 対応: mountedRef は setup で **true reset** する。 reset しないと初回 cleanup
// 後 false 固定で send 内 setState が全 skip され rollback / error が dev 環境で動かない
// (jsdom test は `<StrictMode>` wrap 時のみ再現)。
//
// 並行 server update / OCC 検出は MVP scope 外 (v1.x で etag 検討、 S2.0b-1 既知制約
// を継承)。
//
// 既知制約 (MVP UX として許容):
// - revalidate (server からの prop 更新) は serverCommittedRef を信頼源として
//   options を上書きする。 in-flight / queue 中は skip (= 楽観値を保護) するが、 既に
//   送信成功した row の値で server から新 prop が来た場合、 他 row の **未確定楽観値も
//   同時に rollback されない** ように `setOptions(serverOptions)` は skip 条件付き。

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { CardOption } from '@/lib/db/schema'
import { updateCardField } from '../_actions/update-card-field'

// snake_case CardOption → camelCase (zod optionSchema が期待する形)。
// server 側 buildSetClause が camelCase → snake_case に戻す。
type ZodOption = {
  id: string
  text: string
  isCorrect: boolean
  explanation?: string
}

function toZodOption(o: CardOption): ZodOption {
  return {
    id: o.id,
    text: o.text,
    isCorrect: o.is_correct,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }
}

// id / text / is_correct / explanation 全 field 比較。 explanation は undefined と
// 未設定 を同一視 (CardOption の jsonb 表現に合わせる)。
function shallowEqualOption(a: CardOption, b: CardOption): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.is_correct === b.is_correct &&
    (a.explanation ?? undefined) === (b.explanation ?? undefined)
  )
}

function shallowEqualOptions(a: CardOption[], b: CardOption[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!shallowEqualOption(a[i]!, b[i]!)) return false
  }
  return true
}

const DEBOUNCE_MS = 500

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
  // 表示 + payload 構築の真実 source (全 row 共有)。
  const [options, setOptions] = useState<CardOption[]>(serverOptions)
  const [error, setError] = useState<string | null>(null)
  // checkbox 個別 inFlight (UI 上、 該当 checkbox のみ disabled で text/explanation
  // cell は edit 可能 = spec §3.3 D)。
  const [checkboxInFlightByIdx, setCheckboxInFlightByIdx] = useState<
    Record<number, boolean>
  >({})

  // server 確定値 (rollback target)。
  const serverCommittedRef = useRef<CardOption[]>(serverOptions)
  // 並列制御 (送信は 1 並列 + queue 深さ 1 で上書き)。
  const inFlightRef = useRef<boolean>(false)
  const pendingPayloadRef = useRef<CardOption[] | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef<boolean>(true)
  // options state を closure ではなく ref 経由で参照するための同期 ref。
  // render 毎に assign することで send / handleCellSave / handleCheckboxToggle が
  // 常に最新 options を読める。
  const optionsRef = useRef<CardOption[]>(options)
  optionsRef.current = options

  // 親再 fetch (revalidate) で serverOptions が変わったら state / serverCommittedRef
  // を同期。 send / queue 中は skip し楽観値を保護する。
  useEffect(() => {
    if (inFlightRef.current || pendingPayloadRef.current !== null) return
    setOptions(serverOptions)
    serverCommittedRef.current = serverOptions
    optionsRef.current = serverOptions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOptions])

  // StrictMode 対応: setup で mountedRef=true reset、 cleanup で false + timer clear。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  const send = async (target: CardOption[]): Promise<void> => {
    if (inFlightRef.current) {
      pendingPayloadRef.current = target
      return
    }
    inFlightRef.current = true
    const payload: ZodOption[] = target.map(toZodOption)
    const result = await updateCardField(cardId, 'options', payload)
    inFlightRef.current = false

    if (!mountedRef.current) return

    if (!result.ok) {
      // 失敗 → 全 row rollback、 queue 破棄 (連続失敗 storm 防止)
      setError(result.error)
      setOptions(serverCommittedRef.current)
      optionsRef.current = serverCommittedRef.current
      pendingPayloadRef.current = null
      return
    }

    serverCommittedRef.current = target

    if (pendingPayloadRef.current !== null) {
      const next = pendingPayloadRef.current
      pendingPayloadRef.current = null
      // queue 連鎖 send は await する: checkbox onChange handler が完走を待たないと
      // checkboxInFlight を解除できないため (旧 InlineOptionRow と同じ仕様)。
      // pendingPayloadRef は上書き運用で深さ 1 固定のため、 await chain は microtask
      // 経由で 1 promise link しか積まず stack / memory リスクなし。
      await send(next)
    }
  }

  const scheduleSend = (target: CardOption[]) => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void send(target)
    }, DEBOUNCE_MS)
  }

  // cell blur 経由の保存 (id / text / explanation)。 idx で row 特定、 nextOption は
  // cell が組み立てた CardOption (= 元 option を該当 field のみ書換えたもの)。
  const handleCellSave = (idx: number, nextOption: CardOption) => {
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = nextOption
    const noPendingWork =
      !inFlightRef.current && pendingPayloadRef.current === null
    if (noPendingWork && shallowEqualOptions(nextAll, serverCommittedRef.current)) {
      // server に投げる必要なし。 state / error も触らない (display 一致のため)
      return
    }
    setOptions(nextAll)
    optionsRef.current = nextAll
    setError(null)
    scheduleSend(nextAll)
  }

  // checkbox 即時送信: 進行中 text 編集の debounce timer は cancel (text 楽観値は
  // 既に options state に反映済のため、 nextAll snapshot に自動同梱される)。
  // 同 row の checkbox 連打は disabled で 1 度に 1 度のみ受付、 別 row への click は
  // queue 経由で順次 1 並列 send。
  const handleCheckboxToggle = async (idx: number, nextChecked: boolean) => {
    if (checkboxInFlightByIdx[idx]) return // UI 上 disabled で到達しないはず
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const nextAll = optionsRef.current.slice()
    nextAll[idx] = { ...nextAll[idx]!, is_correct: nextChecked }
    setOptions(nextAll)
    optionsRef.current = nextAll
    setError(null)
    setCheckboxInFlightByIdx((m) => ({ ...m, [idx]: true }))
    await send(nextAll)
    if (mountedRef.current) {
      setCheckboxInFlightByIdx((m) => ({ ...m, [idx]: false }))
    }
  }

  return (
    <div>
      <ul className="mt-1 space-y-1.5">
        {options.map((opt, idx) => (
          <li key={opt.id}>
            <InlineOptionRow
              option={opt}
              checkboxInFlight={!!checkboxInFlightByIdx[idx]}
              onCheckboxToggle={(nextChecked) =>
                handleCheckboxToggle(idx, nextChecked)
              }
              onCellSave={(nextOption) => handleCellSave(idx, nextOption)}
            />
          </li>
        ))}
      </ul>
      {/* error は per-card 親レベルで 1 度だけ render (送信は 1 並列のため同時 2 件の
          失敗は発生しえない、 共有表示で UX 上も矛盾なし)。 旧実装は row 内に置いていた
          が、 lift-up 後は alert 多重 hit を避けるため list 直下に集約。 */}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

// ============================================================================
// InlineOptionRow (controlled view, presentational)
// ============================================================================

type InlineOptionRowProps = {
  option: CardOption
  checkboxInFlight: boolean
  onCheckboxToggle: (nextChecked: boolean) => void
  onCellSave: (nextOption: CardOption) => void
}

// 内部実装: server boundary を跨いで使われないため、 function callback props を
// 安全に取れる (= 'use client' top-level export 制約を回避するため un-export 化)。
// テストでは `InlineOptionList` 経由で render する。 error は list level に集約済の
// ため row props には載せない。
function InlineOptionRow({
  option,
  checkboxInFlight,
  onCheckboxToggle,
  onCellSave,
}: InlineOptionRowProps) {
  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onCheckboxToggle(e.target.checked)
  }

  return (
    <div
      className={
        option.is_correct
          ? 'rounded border border-emerald-300 bg-emerald-100 p-2 text-sm'
          : 'rounded border border-border/60 p-2 text-sm'
      }
    >
      <div className="flex flex-wrap items-start gap-2">
        <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            aria-label="選択肢 正解フラグ 編集"
            checked={option.is_correct}
            disabled={checkboxInFlight}
            onChange={handleCheckboxChange}
            className="h-6 w-6 cursor-pointer accent-emerald-600"
          />
        </label>
        <div className="w-20 shrink-0">
          <InlineOptionCell
            kind="id"
            ariaLabel="選択肢 id 編集"
            value={option.id}
            onSave={(value) => onCellSave({ ...option, id: value })}
            displayClassName="text-sm font-mono text-slate-700"
            placeholder="(id)"
          />
        </div>
        <div className="flex-1 min-w-0">
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
          />
        </div>
      </div>
      <div className="mt-1">
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
}

// 表示値は props.value (row の option) を使い、 cell は edit 中の editValue / editing
// のみ持つ。 error は親 (InlineOptionList) に集約。
function InlineOptionCell({
  kind,
  ariaLabel,
  value,
  onSave,
  displayClassName,
  placeholder = '(クリックで追加)',
}: InlineOptionCellProps) {
  const [editValue, setEditValue] = useState<string>(value)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // 編集中でなければ props.value (= 親 options[idx]) を editValue に同期する。
  // 編集中は user 入力を保護。
  useEffect(() => {
    if (editing) return
    setEditValue(value)
  }, [value, editing])

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
    // debounce / queue / short-circuit 判定は全て親 (handleCellSave) で実施。
    onSave(editValue)
  }

  const multiline = kind !== 'id'

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
            rows={kind === 'explanation' ? 2 : 3}
          />
        ) : (
          <Input
            {...(commonProps as React.ComponentProps<typeof Input> & {
              ref: React.Ref<HTMLInputElement>
            })}
            type="text"
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
      className={`min-h-11 cursor-text rounded-md p-2 transition-colors hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
        isEmpty ? 'text-slate-400 italic' : ''
      } ${displayClassName ?? ''}`}
    >
      {isEmpty ? (
        <span>{placeholder}</span>
      ) : (
        <span className="whitespace-pre-wrap break-words">{value}</span>
      )}
    </div>
  )
}
