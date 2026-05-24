'use client'

// 試験詳細 page (/app/exams/[id]) の inline 編集 cell (1 field 用 reusable)。
// click で display → edit、 blur で値が変わっていれば server action 呼出、
// 失敗時は edit mode 維持 + alert 表示、 値変更なしは server 呼ばず復帰。
// nullable field (sort_key / explanation_text / memo) は null → '' で初期化、
// 空文字 → null 正規化は server 側 zod に任せる。

import { useEffect, useRef, useState, useTransition } from 'react'
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

export function InlineTextField({
  cardId,
  field,
  initialValue,
  ariaLabel,
  multiline = false,
  placeholder = '(クリックで追加)',
  displayClassName,
}: InlineTextFieldProps) {
  const [value, setValue] = useState<string>(initialValue ?? '')
  // server 成功で表示テキストを同 component 内で更新するため、 「現時点で
  // server に保存済の値」 を local state として持ち回す (revalidatePath は走るが
  // server component 親再 fetch 前に楽観的に display 反映するため)。
  const [committedValue, setCommittedValue] = useState<string | null>(
    initialValue,
  )
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // edit mode 切替時に auto-focus
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // initialValue が server revalidate で変わった時 (親 server component 再 render)
  // のみ committed と value を同期。 編集中 / 楽観的更新後の同 render では走らせ
  // ない (initialValue を deps に置き、 effect 内で editing/pending を guard)。
  useEffect(() => {
    if (editing || pending) return
    setCommittedValue(initialValue)
    setValue(initialValue ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue])

  const startEdit = () => {
    if (pending) return
    setEditing(true)
    setError(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // a11y: keyboard 対応 (Enter / Space で edit 開始)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      startEdit()
    }
  }

  const handleBlur = () => {
    // pending 中の blur 二重発火を防ぐ (transition 完了前の再 focus → blur で
    // updateCardField が重複呼出される race を予防、 review I1)
    if (pending) return
    const original = committedValue ?? ''
    if (value === original) {
      // 変更なし → server 呼ばず復帰
      setEditing(false)
      setError(null)
      return
    }
    // TODO (concurrent edit sync, review I2): 別 tab / user が同 card を編集中の
    // 場合、 committedValue は古い initialValue のままで「変更なし」 判定が誤る
    // 可能性。 MVP scope 外 (同時編集は想定外)、 v1.x で OCC / etag 検討。
    startTransition(async () => {
      const result = await updateCardField(cardId, field, value)
      if (!result.ok) {
        setError(result.error)
        // edit mode 維持、 再 focus で retry 可能
        return
      }
      setError(null)
      setCommittedValue(value)
      setEditing(false)
    })
  }

  if (editing) {
    const commonProps = {
      'aria-label': ariaLabel,
      value,
      disabled: pending,
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
        {pending && (
          <p role="status" className="text-xs text-slate-500">
            保存中…
          </p>
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
  const displayText = committedValue ?? ''
  const isEmpty = displayText.length === 0
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
        <span className="whitespace-pre-wrap break-words">{displayText}</span>
      )}
    </div>
  )
}
