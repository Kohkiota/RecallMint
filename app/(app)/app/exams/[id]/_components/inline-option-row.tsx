'use client'

// 試験詳細 page (/app/exams/[id]) の 1 option 用 inline 編集 row。
// id / text / is_correct / explanation の 4 field を扱う。 id / text / explanation は
// click → input/textarea → blur で保存、 is_correct は checkbox onChange で即時保存。
// 1 field 更新でも options 配列全体を updateCardField('options', ...) で送る
// (T2 server action の API)。 他 option は touch しない。 server 側で is_correct
// から correct_answer_ids が再生成されるので client は触らない。
//
// pending は 4 field で共有 (useTransition)。 1 field の保存中に他 field を
// 編集開始させないことで race を防ぐ (InlineTextField の review I1 と同方針)。
// is_correct は楽観的に checked を切替 → 失敗時 rollback。
//
// MVP 既知制約 (review I1 / I3、 v1.x で OCC / etag 検討):
// - 同 row 内で複数 cell を並列編集する操作は非対応 (1 field 保存中の他 cell 操作は
//   pending guard で no-op、 編集中 cell の未保存 value は次回 click で復元)
// - 保存中に server revalidate で他 source から option が更新された場合、 useEffect
//   deps が [option] のみで pending=true 中の同期 effect が skip され reflect 遅延あり

import { useEffect, useRef, useState, useTransition } from 'react'
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

export function InlineOptionRow({
  cardId,
  option,
  allOptions,
  optionIndex,
}: InlineOptionRowProps) {
  const [committed, setCommitted] = useState<CardOption>(option)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // 親再 fetch で option / allOptions が変わったら committed を同期。
  // 編集中 / pending 中は触らない (InlineTextField の同方針)。
  useEffect(() => {
    if (pending) return
    setCommitted(option)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option])

  // 該当 index の option を nextOption に置換した allOptions を ZodOption[] に
  // 変換して server に送る。 他 option は touch しない。
  const buildAndSave = (
    nextOption: CardOption,
    onSuccess: () => void,
    onFailure: (msg: string) => void,
  ) => {
    const nextAll: CardOption[] = allOptions.map((o, i) =>
      i === optionIndex ? nextOption : o,
    )
    const payload: ZodOption[] = nextAll.map(toZodOption)
    startTransition(async () => {
      const result = await updateCardField(cardId, 'options', payload)
      if (!result.ok) {
        onFailure(result.error)
        return
      }
      setError(null)
      onSuccess()
    })
  }

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (pending) return
    const nextChecked = e.target.checked
    const prevCommitted = committed
    const nextOption: CardOption = { ...committed, is_correct: nextChecked }
    // 楽観的更新
    setCommitted(nextOption)
    buildAndSave(
      nextOption,
      () => {
        // 成功: committed は楽観的更新済 (何もしない)
      },
      (msg) => {
        setError(msg)
        // rollback
        setCommitted(prevCommitted)
      },
    )
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
            disabled={pending}
            onChange={handleCheckboxChange}
            className="h-6 w-6 cursor-pointer accent-emerald-600"
          />
        </label>
        <div className="w-20 shrink-0">
          <InlineOptionCell
            kind="id"
            ariaLabel="選択肢 id 編集"
            initialValue={committed.id}
            pending={pending}
            onSave={(value, done, fail) => {
              const nextOption: CardOption = { ...committed, id: value }
              buildAndSave(
                nextOption,
                () => {
                  setCommitted(nextOption)
                  done()
                },
                (msg) => fail(msg),
              )
            }}
            displayClassName="text-sm font-mono text-slate-700"
            placeholder="(id)"
          />
        </div>
        <div className="flex-1 min-w-0">
          <InlineOptionCell
            kind="text"
            ariaLabel="選択肢 本文 編集"
            initialValue={committed.text}
            pending={pending}
            onSave={(value, done, fail) => {
              const nextOption: CardOption = { ...committed, text: value }
              buildAndSave(
                nextOption,
                () => {
                  setCommitted(nextOption)
                  done()
                },
                (msg) => fail(msg),
              )
            }}
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
          initialValue={committed.explanation ?? ''}
          pending={pending}
          onSave={(value, done, fail) => {
            const nextExplanation = value === '' ? undefined : value
            const nextOption: CardOption = nextExplanation
              ? { ...committed, explanation: nextExplanation }
              : (() => {
                  const { explanation: _drop, ...rest } = committed
                  return rest
                })()
            buildAndSave(
              nextOption,
              () => {
                setCommitted(nextOption)
                done()
              },
              (msg) => fail(msg),
            )
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
      {pending && (
        <p role="status" className="mt-1 text-xs text-slate-500">
          保存中…
        </p>
      )}
    </div>
  )
}

type InlineOptionCellProps = {
  kind: 'id' | 'text' | 'explanation'
  ariaLabel: string
  initialValue: string
  pending: boolean
  onSave: (
    value: string,
    onSuccess: () => void,
    onFailure: (msg: string) => void,
  ) => void
  displayClassName?: string
  placeholder?: string
}

// 1 cell (id / text / explanation 共通)。 InlineTextField とほぼ同じ動作だが、
// 保存は callback 経由で options 配列構築を呼出側に委譲する。
function InlineOptionCell({
  kind,
  ariaLabel,
  initialValue,
  pending,
  onSave,
  displayClassName,
  placeholder = '(クリックで追加)',
}: InlineOptionCellProps) {
  const [value, setValue] = useState<string>(initialValue)
  const [committed, setCommitted] = useState<string>(initialValue)
  const [editing, setEditing] = useState(false)
  const [cellError, setCellError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  useEffect(() => {
    if (editing || pending) return
    setCommitted(initialValue)
    setValue(initialValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue])

  const startEdit = () => {
    if (pending) return
    setEditing(true)
    setCellError(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      startEdit()
    }
  }

  const handleBlur = () => {
    if (pending) return
    if (value === committed) {
      setEditing(false)
      setCellError(null)
      return
    }
    onSave(
      value,
      () => {
        setCommitted(value)
        setEditing(false)
        setCellError(null)
      },
      (msg) => {
        setCellError(msg)
      },
    )
  }

  const multiline = kind !== 'id'

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
        {cellError && (
          <p role="alert" className="text-xs text-red-600">
            {cellError}
          </p>
        )}
      </div>
    )
  }

  const isEmpty = committed.length === 0
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
        <span className="whitespace-pre-wrap break-words">{committed}</span>
      )}
    </div>
  )
}
