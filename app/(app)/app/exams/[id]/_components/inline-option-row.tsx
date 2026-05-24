'use client'

// 試験詳細 page (/app/exams/[id]) の 1 option 用 inline 編集 row。
// id / text / is_correct / explanation の 4 field を扱う。
//
// Optimistic UI + debounce(500ms) + row 共有 send + queue 設計 (spec §3.3 / §3.5)。
// row が真実 source の `committed: CardOption` を保持し、 cell は props.value
// 経由で表示のみ受け取る。 text/id/explanation cell の blur は callback で row に
// 委譲 → row 側で setCommitted + scheduleSend (500ms debounce)。 checkbox は
// debounce なしで即時 send、 進行中 text 編集 timer は cancel して checkbox 送信
// に text 新値を同梱する (race 予防、 spec §3.5)。
//
// 同 row 内 cell は inFlightRef + pendingPayloadRef で 1 並列 + queue に絞る。
// 異なる field の blur が連続しても、 完走後に最新 committed snapshot で再送信
// される (last write wins 保証)。
//
// checkboxInFlight (state) は checkbox 個別 disable UI 用。 text/explanation cell
// は別 field なので race にならず、 行内で同時 edit 可能 (spec §3.3 D)。
//
// 失敗時は committed を serverCommittedRef に rollback (text / is_correct / id /
// explanation 全 field 同時) + inline error。 edit mode に戻さない (E-1)。

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { CardOption } from '@/lib/db/schema'
import { updateCardField } from '../_actions/update-card-field'

type InlineOptionRowProps = {
  cardId: string
  option: CardOption
  allOptions: CardOption[]
  optionIndex: number
}

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

// id / text / is_correct / explanation 全 field 比較。 explanation は undefined
// と 未設定 を同一視 (CardOption の jsonb 表現に合わせる)。
function shallowEqualOption(a: CardOption, b: CardOption): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.is_correct === b.is_correct &&
    (a.explanation ?? undefined) === (b.explanation ?? undefined)
  )
}

const DEBOUNCE_MS = 500

export function InlineOptionRow({
  cardId,
  option,
  allOptions,
  optionIndex,
}: InlineOptionRowProps) {
  // row の真実 source。 display は committed から派生して cell に props.value 渡し。
  const [committed, setCommitted] = useState<CardOption>(option)
  const [error, setError] = useState<string | null>(null)
  // checkbox 単体の inFlight UI (送信中該当 checkbox のみ disabled)。
  // text/explanation cell は別 field なので edit 可能を維持 (spec §3.3 D)。
  const [checkboxInFlight, setCheckboxInFlight] = useState(false)

  // row 共有の send 制御。 1 並列 + queue。
  const serverCommittedRef = useRef<CardOption>(option)
  const inFlightRef = useRef<boolean>(false)
  const pendingPayloadRef = useRef<CardOption | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef<boolean>(true)
  // allOptions / optionIndex は payload 構築に必要だが、 send 内で stale closure
  // にならないよう ref 経由で最新を参照する。
  const allOptionsRef = useRef<CardOption[]>(allOptions)
  const optionIndexRef = useRef<number>(optionIndex)
  useEffect(() => {
    allOptionsRef.current = allOptions
    optionIndexRef.current = optionIndex
  }, [allOptions, optionIndex])

  // 親再 fetch で option が変わったら committed / serverCommittedRef を同期。
  // 編集中 (cell side で管理) は row 側からは判定不能のため、 ここでは inFlight /
  // queue 中だけ skip する (cell の edit value は cell 内で保護)。
  useEffect(() => {
    if (inFlightRef.current || pendingPayloadRef.current !== null) return
    setCommitted(option)
    serverCommittedRef.current = option
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option])

  // StrictMode 対応: setup で mountedRef=true reset、 cleanup で false + timer
  // clear。 reset しないと dev mode で send 内 setState 全 skip (T2 と同方針)。
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

  const send = async (target: CardOption): Promise<void> => {
    if (inFlightRef.current) {
      pendingPayloadRef.current = target
      return
    }
    inFlightRef.current = true
    const nextAll = allOptionsRef.current.map((o, i) =>
      i === optionIndexRef.current ? target : o,
    )
    const payload: ZodOption[] = nextAll.map(toZodOption)
    const result = await updateCardField(cardId, 'options', payload)
    inFlightRef.current = false

    if (!mountedRef.current) return

    if (!result.ok) {
      // 失敗 → rollback (全 field 同時、 is_correct も含む)、 queue 破棄 (連続失敗防止)
      setError(result.error)
      setCommitted(serverCommittedRef.current)
      pendingPayloadRef.current = null
      return
    }

    serverCommittedRef.current = target

    if (pendingPayloadRef.current !== null) {
      const next = pendingPayloadRef.current
      pendingPayloadRef.current = null
      // queue 再帰 send は await する (T2 InlineTextField は void で fire-and-forget、
      // T3 は handleCheckboxChange が queue 完走を待たないと checkboxInFlight を
      // 解除できないので await が必須)。 pendingPayloadRef は上書き運用で深さ 1 固定
      // のため、 await chain は microtask 経由で 1 promise link しか積まず stack
      // overflow / memory leak リスクなし。 「T2 と統一」 のつもりで void 化すると
      // checkbox disabled が server 確定より先に外れ regression するので変更注意。
      await send(next)
    }
  }

  const scheduleSend = (target: CardOption) => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void send(target)
    }, DEBOUNCE_MS)
  }

  // text/id/explanation cell 共通 onSave (cell blur 経由)。
  // 「真に飛んでる send も queue も無く、 値も serverCommitted と一致」 のときだけ
  // short-circuit。 in-flight or queue 中は値一致でも scheduleSend して queue に
  // 最新意図を入れる (T2 で発覚した revert-during-inflight 対応、 必須 #2)。
  const handleCellSave = (next: CardOption) => {
    const noPendingWork =
      !inFlightRef.current && pendingPayloadRef.current === null
    if (noPendingWork && shallowEqualOption(next, serverCommittedRef.current)) {
      // server に投げる必要なし。 committed / error は触らない (display 一致のため)
      return
    }
    setCommitted(next)
    setError(null)
    scheduleSend(next)
  }

  const handleCheckboxChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (checkboxInFlight) return // UI 上 disabled で到達しないはず
    const nextChecked = e.target.checked
    // 進行中 text 編集の保留 timer をキャンセル: 保留分は committed に既に楽観反映
    // されており、 checkbox 送信時の最新 committed snapshot に同梱される (spec §3.5)。
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const nextOption: CardOption = { ...committed, is_correct: nextChecked }
    setCommitted(nextOption)
    setError(null)
    setCheckboxInFlight(true)
    // checkbox は debounce なし即時 send。 queue 経由なら send 内で await 連鎖で
    // 完走を待つので、 ここで await すれば真に「checkbox 値が server 反映完了」
    // した時点で disable 解除できる。
    await send(nextOption)
    if (mountedRef.current) setCheckboxInFlight(false)
  }

  return (
    <div
      className={
        committed.is_correct
          ? 'rounded border border-emerald-300 bg-emerald-100 p-2 text-sm'
          : 'rounded border border-border/60 p-2 text-sm'
      }
    >
      <div className="flex flex-wrap items-start gap-2">
        <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            aria-label="選択肢 正解フラグ 編集"
            checked={committed.is_correct}
            disabled={checkboxInFlight}
            onChange={handleCheckboxChange}
            className="h-6 w-6 cursor-pointer accent-emerald-600"
          />
        </label>
        <div className="w-20 shrink-0">
          <InlineOptionCell
            kind="id"
            ariaLabel="選択肢 id 編集"
            value={committed.id}
            onSave={(value) => handleCellSave({ ...committed, id: value })}
            displayClassName="text-sm font-mono text-slate-700"
            placeholder="(id)"
          />
        </div>
        <div className="flex-1 min-w-0">
          <InlineOptionCell
            kind="text"
            ariaLabel="選択肢 本文 編集"
            value={committed.text}
            onSave={(value) => handleCellSave({ ...committed, text: value })}
            displayClassName={
              committed.is_correct
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
          value={committed.explanation ?? ''}
          onSave={(value) => {
            // 空文字は jsonb から explanation key を drop する。 値があるときだけ
            // explanation を残す (T2 server action validation は optional だが、
            // payload bloat を防ぐため client で drop)。
            if (value === '') {
              const { explanation: _drop, ...rest } = committed
              handleCellSave(rest)
            } else {
              handleCellSave({ ...committed, explanation: value })
            }
          }}
          displayClassName="text-xs text-slate-600"
          placeholder="解説 (クリックで追加)"
        />
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

type InlineOptionCellProps = {
  kind: 'id' | 'text' | 'explanation'
  ariaLabel: string
  value: string // row の committed から派生する display 値 (props 化)
  onSave: (value: string) => void
  displayClassName?: string
  placeholder?: string
}

// row 共有 committed 化に伴い state を簡素化:
// - 表示値は props.value (row の committed) を使う
// - cell は edit 中の editValue / editing のみ持つ
// - error は row に集約 (cellError 廃止)
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

  // 編集中でなければ props.value (= row の committed) を editValue に同期する。
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
    // debounce / queue / short-circuit 判定は全て row 側 (handleCellSave) で実施。
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
