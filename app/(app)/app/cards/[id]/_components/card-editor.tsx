'use client'

// card 編集 page の本体。 cards テーブルの editable 5 列
// (title / question_text / options / correct_answer_ids / explanation_text) を
// 編集する controlled form。 correct_answer_ids は持たず、 各 option の 正解
// checkbox (pattern A: 行ごとに独立、 check 数で単一/複数/0 が自動的に決まる) から
// server 側 updateCard が再生成する。
//
// 保存成功で試験詳細 page にリダイレクトする。 dirty guard (beforeunload /
// 自前 confirm) は T10 で撤廃 — S2.0b の inline 編集で dirty 概念が cell 単位に
// 変わるため page 全体 guard は持たない方針。 保存後リダイレクトで意義も薄い。

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import type { CardOption } from '@/lib/db/schema'
import { nextOptionId } from '@/lib/cards/next-option-id'
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
  // page header に差し込む削除 UI (server 側で組み立てた DeleteCardButton)。
  deleteSlot?: React.ReactNode
}

// `nextOptionId` は S2.0b-3 で `lib/cards/next-option-id.ts` に切り出し済 (試験詳細
// page の inline 編集でも同じ採番 logic を使うため共通化)。 旧来の export 経路で
// import していた caller (本 file の addOption と card-editor.test.tsx) は新 lib
// から import する形に更新済。

function toEditorOptions(options: CardOption[]): EditorOption[] {
  return options.map((o) => ({
    id: o.id,
    text: o.text,
    isCorrect: o.is_correct,
    explanation: o.explanation ?? '',
  }))
}

// dirty 判定用の安定スナップショット (保存ボタンの活性判定に使う)。
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
  deleteSlot,
}: CardEditorProps) {
  const router = useRouter()
  const [title, setTitle] = useState(initialTitle)
  const [questionText, setQuestionText] = useState(initialQuestionText)
  const [options, setOptions] = useState<EditorOption[]>(() =>
    toEditorOptions(initialOptions),
  )
  const [explanationText, setExplanationText] = useState(
    initialExplanationText ?? '',
  )
  // 初期スナップショット。 保存成功時はリダイレクトするため更新不要 (定数)。
  const [baseline] = useState(() =>
    serialize(
      initialTitle,
      initialQuestionText,
      toEditorOptions(initialOptions),
      initialExplanationText ?? '',
    ),
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const current = serialize(title, questionText, options, explanationText)
  const dirty = current !== baseline
  const correctIds = options.filter((o) => o.isCorrect).map((o) => o.id)
  const correctCount = correctIds.length

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
    setErrorMsg(null)
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
        // 保存成功 → 元の試験詳細 page へ自動遷移。
        router.push(`/app/exams/${examId}`)
      } else {
        setErrorMsg(result.error)
      }
    })
  }

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-1 text-sm text-slate-600">
        <Link href="/app" className="hover:text-slate-900">
          ダッシュボード
        </Link>
        <span className="text-slate-400">/</span>
        <Link href="/app/exams" className="hover:text-slate-900">
          試験一覧
        </Link>
        <span className="text-slate-400">/</span>
        <Link
          href={`/app/exams/${examId}`}
          className="hover:text-slate-900"
        >
          {examName}
        </Link>
        <span className="text-slate-400">/</span>
        <span className="font-medium text-slate-900">{title || '(無題)'}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-bold">カードを編集</h1>
        {deleteSlot}
      </div>

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
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-slate-500">
                    {opt.id}
                  </span>
                  <label className="flex items-center gap-1.5 text-sm font-medium">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={opt.isCorrect}
                      onChange={(e) =>
                        setOption(i, { isCorrect: e.target.checked })
                      }
                    />
                    正解
                  </label>
                </div>
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

      <p className="text-sm font-bold text-slate-700">
        正解: {correctIds.length > 0 ? correctIds.join(', ') : '未設定'}
      </p>

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
          正解が選択されていません。 このまま保存することもできます。
        </p>
      )}

      {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onSave} disabled={!dirty || isPending}>
          {isPending ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="outline" asChild>
          <Link href={`/app/exams/${examId}`}>試験に戻る</Link>
        </Button>
      </div>
    </div>
  )
}
