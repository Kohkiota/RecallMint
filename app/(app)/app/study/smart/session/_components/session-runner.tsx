'use client'

// SessionRunner — スマート復習の 1 session を管理する Client Component。
//
// Phase machine: asking → showing-explanation → (repeat) → finished
//
// - asking: 問題文 + 選択肢 (ハイライトなし) + Again/Hard/Good/Easy rate buttons
// - showing-explanation: 正解選択肢 emerald 強調 + option/card 解説 + 次へ button
// - finished: 🎉 + 統計 + もう一度 / ダッシュボードへ

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Card, CardOption } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import { submitReview } from '../_actions/submit-review'

type Phase = 'asking' | 'showing-explanation' | 'finished'
type Rating = 1 | 2 | 3 | 4

type SessionRunnerProps = {
  cards: Card[]
}

export function SessionRunner({ cards }: SessionRunnerProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('asking')
  const [idx, setIdx] = useState(0)
  const [tally, setTally] = useState({ answered: 0, correct: 0 })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const current = cards[idx]

  const handleRate = (rating: Rating) => {
    setError(null)
    startTransition(async () => {
      const result = await submitReview(current.id, rating)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setTally((t) => ({
        answered: t.answered + 1,
        correct: t.correct + (result.data?.correct ? 1 : 0),
      }))
      setPhase('showing-explanation')
    })
  }

  const handleNext = () => {
    const nextIdx = idx + 1
    if (nextIdx >= cards.length) {
      setPhase('finished')
    } else {
      setIdx(nextIdx)
      setPhase('asking')
      setError(null)
    }
  }

  // -----------------------------------------------------------------------
  // 完了画面
  // -----------------------------------------------------------------------
  if (phase === 'finished') {
    const pct =
      tally.answered > 0
        ? Math.round((tally.correct / tally.answered) * 100)
        : 0
    return (
      <div className="mx-auto max-w-xl space-y-6 px-4 py-8 text-center">
        <p className="text-5xl">🎉</p>
        <div className="space-y-1">
          <p className="text-2xl font-bold">セッション完了</p>
          <p className="text-slate-600">
            {tally.answered} 枚 / {tally.correct} 正解 / 正答率 {pct}%
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button
            onClick={() => router.refresh()}
            className="w-full sm:w-auto"
          >
            もう一度
          </Button>
          <Button variant="outline" asChild className="w-full sm:w-auto">
            <Link href="/app">ダッシュボードへ</Link>
          </Button>
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // Session UI (asking / showing-explanation)
  // -----------------------------------------------------------------------
  const options: CardOption[] = Array.isArray(current.options)
    ? current.options
    : []

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      {/* ヘッダー: タイトル + 進行インジケーター */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">スマート復習</h1>
        <span className="text-sm text-slate-500">
          {idx + 1} / {cards.length}
        </span>
      </div>

      {/* 問題文 */}
      <div className="rounded-lg border border-border bg-slate-50 p-4">
        <p className="text-xs font-medium text-slate-500">問題</p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900 sm:text-base">
          {current.questionText}
        </p>
      </div>

      {/* 選択肢 */}
      <ul className="space-y-2">
        {options.map((opt) => {
          const isCorrect = opt.is_correct
          const showHighlight = phase === 'showing-explanation' && isCorrect
          return (
            <li
              key={opt.id}
              className={
                showHighlight
                  ? 'rounded border border-emerald-300 bg-emerald-100 p-3 text-sm font-bold text-emerald-900'
                  : 'rounded border border-border/60 p-3 text-sm text-slate-800'
              }
            >
              <p className="whitespace-pre-wrap">
                {phase === 'showing-explanation' && (
                  <span className="mr-1.5">
                    {isCorrect ? '○' : '×'}
                  </span>
                )}
                <span className="mr-2 font-medium">{opt.id}</span>
                {opt.text}
              </p>
              {phase === 'showing-explanation' && opt.explanation && (
                <p className="mt-1 whitespace-pre-wrap text-xs font-normal text-slate-500">
                  解説: {opt.explanation}
                </p>
              )}
            </li>
          )
        })}
      </ul>

      {/* カード全体の解説 (showing-explanation のみ) */}
      {phase === 'showing-explanation' && current.explanationText && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-medium text-slate-500">解説</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
            {current.explanationText}
          </p>
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {/* Rate buttons (asking phase) */}
      {phase === 'asking' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Button
            onClick={() => handleRate(1)}
            disabled={pending}
            variant="outline"
            className="h-14 text-base font-semibold"
          >
            Again
          </Button>
          <Button
            onClick={() => handleRate(2)}
            disabled={pending}
            variant="outline"
            className="h-14 text-base font-semibold"
          >
            Hard
          </Button>
          <Button
            onClick={() => handleRate(3)}
            disabled={pending}
            className="h-14 text-base font-semibold"
          >
            Good
          </Button>
          <Button
            onClick={() => handleRate(4)}
            disabled={pending}
            variant="outline"
            className="h-14 text-base font-semibold border-emerald-300 text-emerald-700 hover:bg-emerald-50"
          >
            Easy
          </Button>
        </div>
      )}

      {/* 次へ button (showing-explanation phase) */}
      {phase === 'showing-explanation' && (
        <div className="flex justify-end">
          <Button onClick={handleNext} className="w-full sm:w-auto">
            次へ
          </Button>
        </div>
      )}
    </div>
  )
}
