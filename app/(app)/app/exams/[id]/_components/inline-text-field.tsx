'use client'

// 試験詳細 page (/app/exams/[id]) の inline 編集 cell (1 field 用 reusable)。
// Optimistic UI + debounce(500ms) + queue 設計 (spec §3.2)。
// blur で display 即時反映 → 500ms 後に server send。 連続 blur は timer reset
// で最後の値のみ送信、 進行中 send があれば queue 入りで完走後に再送信。
// 失敗時は display を直前の server 値に rollback + error 表示 (edit mode に
// 戻さない、 E-1)。
// nullable field (sort_key / explanation_text / memo) は null → '' で初期化、
// 空文字 → null 正規化は server 側 zod に任せる。

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  updateCardField,
  type UpdateCardFieldName,
} from '../_actions/update-card-field'

type InlineTextFieldProps = {
  cardId: string
  // sort_key / title / question_text / explanation_text / memo のいずれか
  // (options は別 dispatch、 本 component は単一 text 値のみ扱う)
  field: Extract<
    UpdateCardFieldName,
    'sort_key' | 'title' | 'question_text' | 'explanation_text' | 'memo'
  >
  initialValue: string | null
  ariaLabel: string
  multiline?: boolean
  placeholder?: string
  // display mode の追加 className (font / color 等 cell 表現を上書きするため)
  displayClassName?: string
}

const DEBOUNCE_MS = 500

export function InlineTextField({
  cardId,
  field,
  initialValue,
  ariaLabel,
  multiline = false,
  placeholder = '(クリックで追加)',
  displayClassName,
}: InlineTextFieldProps) {
  const initialString = initialValue ?? ''
  // input 編集中の値
  const [value, setValue] = useState<string>(initialString)
  // display 表示値 (= optimistic 反映先)。 string 固定で内部保持し、 null 戻し
  // は serverCommittedRef からの rollback も含めて initialValue 由来の文字列を
  // そのまま使う (空文字判定は length === 0)。
  const [committedValue, setCommittedValue] = useState<string>(initialString)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // 最後に server で成功した値 (rollback target)。 初期値は initialString。
  const serverCommittedRef = useRef<string>(initialString)
  const inFlightRef = useRef<boolean>(false)
  const pendingValueRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // unmount 後の setState を抑止 (cleanup race 防止)
  const mountedRef = useRef<boolean>(true)

  // edit mode 切替時に auto-focus
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // initialValue が server revalidate 等で外部変化した時、 編集中 / 送信中 /
  // queue 中でなければ local state を新値に同期する。 上記いずれかなら user の
  // 編集 / 未確定送信を保護するため触らない。
  useEffect(() => {
    if (
      editing ||
      inFlightRef.current ||
      pendingValueRef.current !== null
    ) {
      return
    }
    setCommittedValue(initialString)
    setValue(initialString)
    serverCommittedRef.current = initialString
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue])

  // mount / unmount 同期: setup で mountedRef=true reset、 cleanup で false + timer
  // clear。 setup 側で reset しないと React Strict Mode (next.config.ts で有効) の
  // 二重 effect 実行で initial mount cleanup 後に false 固定となり、 以降の send
  // 内 setState (rollback / error / queue 完走) が全て skip される。
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

  const send = async (target: string) => {
    // 進行中 send があれば queue 入りで早期 return (B-2)
    if (inFlightRef.current) {
      pendingValueRef.current = target
      return
    }
    inFlightRef.current = true
    const result = await updateCardField(cardId, field, target)
    inFlightRef.current = false

    if (!mountedRef.current) return

    if (!result.ok) {
      // 失敗 → display rollback + error 表示、 queue は捨てる (連続失敗防止)
      setError(result.error)
      setCommittedValue(serverCommittedRef.current)
      pendingValueRef.current = null
      return
    }

    serverCommittedRef.current = target

    // queue に残っていれば最新値で再送信
    if (pendingValueRef.current !== null) {
      const next = pendingValueRef.current
      pendingValueRef.current = null
      void send(next)
    }
  }

  const scheduleSend = (target: string) => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void send(target)
    }, DEBOUNCE_MS)
  }

  const startEdit = () => {
    setEditing(true)
    // edit 開始時は error を残す (失敗直後の rollback display から再 click した
    // ユーザーが何が起きたか把握できるよう)。 blur 時の handleBlur で必要に応じ
    // クリアする。
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // a11y: keyboard 対応 (Enter / Space で edit 開始)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      startEdit()
    }
  }

  const handleBlur = () => {
    // 1. editing を即時 false に (display 復帰)
    setEditing(false)
    // 2. 真に「飛んでる send も queue も無い + 値も serverCommitted と一致」
    //    時のみ short-circuit。 in-flight or queue 中は値が一致していても
    //    scheduleSend(value) して queue に最新意図を入れる。 そうしないと:
    //    serverCommittedRef="A" → "B" 入力 blur → send("B") inflight → 即
    //    "A" に戻し blur で短絡 → server に "B" 確定で display="A" との
    //    不整合 (= 最新 revert がロスト) が起きる (spec §3.2 を拡張、
    //    spec doc 自体の更新は T4 closure で controller が実施予定)。
    const noPendingWork =
      !inFlightRef.current && pendingValueRef.current === null
    if (noPendingWork && value === serverCommittedRef.current) {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      setCommittedValue(serverCommittedRef.current)
      setError(null)
      return
    }
    // 3. display 即時反映 (Optimistic UI、 C-1)
    setCommittedValue(value)
    // 4. 前回 error クリア (新規 blur で再挑戦が始まる)
    setError(null)
    // 5. debounce 500ms 後に send (in-flight 中なら queue 経由で完走後に再送信)
    scheduleSend(value)
  }

  if (editing) {
    const commonProps = {
      'aria-label': ariaLabel,
      value,
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => setValue(e.target.value),
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
            rows={4}
          />
        ) : (
          <Input
            {...(commonProps as React.ComponentProps<typeof Input> & {
              ref: React.Ref<HTMLInputElement>
            })}
            type="text"
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
    )
  }

  // display mode
  const displayText = committedValue
  const isEmpty = displayText.length === 0
  return (
    <div className="space-y-1">
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
          <span className="whitespace-pre-wrap break-words">{displayText}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
