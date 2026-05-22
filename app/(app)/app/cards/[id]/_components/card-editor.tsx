'use client'

// card 編集 page の本体。 cards テーブルの editable 5 列
// (title / question_text / options / correct_answer_ids / explanation_text) を
// 編集する controlled form。 correct_answer_ids は持たず、 各 option の 正答
// checkbox (pattern A: 行ごとに独立、 check 数で単一/複数/0 が自動的に決まる) から
// server 側 updateCard が再生成する。
//
// 離脱 guard: dirty 時に beforeunload (タブ閉じ / リロード) と、 自前 breadcrumb /
// 戻る link の confirm() で in-app 離脱を防ぐ。

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import type { CardOption } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { updateCard } from '../_actions/update-card'

type EditorOption = {
  id: string
  text: string
  isCorrect: boolean
  explanation: string
}

type CardEditorProps = {
  cardId: string
  examId: string
  examName: string
  initialTitle: string
  initialQuestionText: string
  initialOptions: CardOption[]
  initialExplanationText: string | null
}

// 新規 option の id を card 内で衝突しないように採番する。
// 既存が英字のみ → 次の英字 / 数字のみ → 次の数字 / それ以外 (英字 z 枯渇含む)
// → opt-N。 純粋関数なので単体 test 用に export する。
export function nextOptionId(existing: string[]): string {
  const taken = new Set(existing)
  if (existing.length > 0 && existing.every((id) => /^[a-z]$/.test(id))) {
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c)
      if (!taken.has(ch)) return ch
    }
  }
  if (existing.length > 0 && existing.every((id) => /^\d+$/.test(id))) {
    return String(Math.max(...existing.map((id) => parseInt(id, 10))) + 1)
  }
  let n = 1
  while (taken.has(`opt-${n}`)) n++
  return `opt-${n}`
}

function toEditorOptions(options: CardOption[]): EditorOption[] {
  return options.map((o) => ({
    id: o.id,
    text: o.text,
    isCorrect: o.is_correct,
    explanation: o.explanation ?? '',
  }))
}

// dirty 判定用の安定スナップショット。
function serialize(
  title: string,
  questionText: string,
  options: EditorOption[],
  explanationText: string,
): string {
  return JSON.stringify({ title, questionText, options, explanationText })
}

export function CardEditor({
  cardId,
  examId,
  examName,
  initialTitle,
  initialQuestionText,
  initialOptions,
  initialExplanationText,
}: CardEditorProps) {
  const [title, setTitle] = useState(initialTitle)
  const [questionText, setQuestionText] = useState(initialQuestionText)
  const [options, setOptions] = useState<EditorOption[]>(() =>
    toEditorOptions(initialOptions),
  )
  const [explanationText, setExplanationText] = useState(
    initialExplanationText ?? '',
  )
  // 保存成功時に現在値へ更新し、 dirty を false に戻す基準スナップショット。
  const [baseline, setBaseline] = useState(() =>
    serialize(
      initialTitle,
      initialQuestionText,
      toEditorOptions(initialOptions),
      initialExplanationText ?? '',
    ),
  )
  const [message, setMessage] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null)
  const [isPending, startTransition] = useTransition()

  const current = serialize(title, questionText, options, explanationText)
  const dirty = current !== baseline
  const correctCount = options.filter((o) => o.isCorrect).length

  // dirty 時のみ beforeunload でタブ閉じ / リロードを警告。
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // returnValue は modern TS lib で deprecated marking されているが、 一部
      // legacy browser (Edge 旧 / Safari) は preventDefault のみでは dialog を
      // 出さず returnValue を見るため cross-browser 互換で維持 (upload-form.tsx
      // と同方針)。 TS deprecation hint 6385 は build を block しない。
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // breadcrumb / 戻る link の click を dirty なら confirm で guard。
  const guardLeave = (e: React.MouseEvent) => {
    if (dirty && !window.confirm('保存していない変更があります。移動しますか?')) {
      e.preventDefault()
    }
  }

  const setOption = (index: number, patch: Partial<EditorOption>) => {
    setOptions((prev) =>
      prev.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    )
  }
  const moveOption = (index: number, delta: number) => {
    setOptions((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }
  const removeOption = (index: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== index))
  }
  const addOption = () => {
    setOptions((prev) => [
      ...prev,
      {
        id: nextOptionId(prev.map((o) => o.id)),
        text: '',
        isCorrect: false,
        explanation: '',
      },
    ])
  }

  const onSave = () => {
    setMessage(null)
    startTransition(async () => {
      const result = await updateCard(cardId, {
        title,
        questionText,
        options: options.map((o) => ({
          id: o.id,
          text: o.text,
          isCorrect: o.isCorrect,
          explanation: o.explanation,
        })),
        // 空文字は schema の string | null 契約に合わせ null で送る。
        explanationText: explanationText || null,
      })
      if (result.ok) {
        // baseline は server 応答ではなく現在の editor state から再計算する。
        // server は空 explanation を省略保存するが editor は '' のまま保持するため、
        // local state 基準にしないと保存直後に dirty が復活してしまう。
        setBaseline(serialize(title, questionText, options, explanationText))
        setMessage({ kind: 'success', text: '保存しました' })
      } else {
        setMessage({ kind: 'error', text: result.error })
      }
    })
  }

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-1 text-sm text-slate-600">
        <Link href="/app" onClick={guardLeave} className="hover:text-slate-900">
          ダッシュボード
        </Link>
        <span className="text-slate-400">/</span>
        <Link
          href="/app/exams"
          onClick={guardLeave}
          className="hover:text-slate-900"
        >
          試験一覧
        </Link>
        <span className="text-slate-400">/</span>
        <Link
          href={`/app/exams/${examId}`}
          onClick={guardLeave}
          className="hover:text-slate-900"
        >
          {examName}
        </Link>
        <span className="text-slate-400">/</span>
        <span className="font-medium text-slate-900">{title || '(無題)'}</span>
      </nav>

      <h1 className="text-2xl font-bold">カードを編集</h1>

      <div className="space-y-2">
        <Label htmlFor="card-title">タイトル</Label>
        <Input
          id="card-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="card-question">問題文</Label>
        <Textarea
          id="card-question"
          rows={5}
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>選択肢</Label>
        <ul className="space-y-3">
          {options.map((opt, i) => (
            <li key={opt.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={opt.isCorrect}
                    onChange={(e) =>
                      setOption(i, { isCorrect: e.target.checked })
                    }
                  />
                  正答
                </label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => moveOption(i, -1)}
                    disabled={i === 0}
                    aria-label={`選択肢 ${i + 1} を上へ`}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => moveOption(i, 1)}
                    disabled={i === options.length - 1}
                    aria-label={`選択肢 ${i + 1} を下へ`}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => removeOption(i)}
                    disabled={options.length === 1}
                    aria-label={`選択肢 ${i + 1} を削除`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <Textarea
                aria-label={`選択肢 ${i + 1} の本文`}
                rows={2}
                value={opt.text}
                onChange={(e) => setOption(i, { text: e.target.value })}
              />
              <Textarea
                aria-label={`選択肢 ${i + 1} の解説`}
                rows={2}
                placeholder="この選択肢の解説 (任意)"
                value={opt.explanation}
                onChange={(e) => setOption(i, { explanation: e.target.value })}
              />
            </li>
          ))}
        </ul>
        <Button type="button" variant="outline" size="sm" onClick={addOption}>
          選択肢を追加
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="card-explanation">解説 (任意)</Label>
        <Textarea
          id="card-explanation"
          rows={4}
          value={explanationText}
          onChange={(e) => setExplanationText(e.target.value)}
        />
      </div>

      {correctCount === 0 && (
        <p className="text-sm text-amber-700">
          正答が選択されていません。 このまま保存することもできます。
        </p>
      )}

      {message && (
        <p
          className={
            message.kind === 'success'
              ? 'text-sm text-emerald-700'
              : 'text-sm text-red-600'
          }
        >
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onSave} disabled={!dirty || isPending}>
          {isPending ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="outline" asChild>
          <Link href={`/app/exams/${examId}`} onClick={guardLeave}>
            試験に戻る
          </Link>
        </Button>
      </div>
    </div>
  )
}
