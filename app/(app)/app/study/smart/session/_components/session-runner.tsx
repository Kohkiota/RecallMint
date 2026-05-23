'use client'

// SessionRunner — スマート復習 1 session を管理する Client Component (S2.2 T4 再設計)。
//
// Phase machine: selecting → judged → (mode 別 submit + 遷移) → finished
//
// - selecting: 問題文 + 選択肢 (click toggle 可) + 「回答する」 button (空選択で disabled)
// - judged: 解説 + 正解/不正解判定 + (通常モード) 「次へ」 純遷移 /
//           (FSRS モード) Again/Hard/Good/Easy 押下で submit + 自動次へ
// - finished: 🎉 + 統計 + もう一度 / ダッシュボードへ
//
// 正解判定 = client 集合一致 (順序非依存)。 server 戻り値 data.correct は参照しない
// (FSRS モードで user rating と判定値が乖離するため)。
//
// submit タイミング (mode 別):
// - 通常モード: 「回答する」押下時に judged 遷移と同時に submit (rating=3 or 1)。
//   解説を読む間に server 書き込みが完了し、 「次へ」 tap は純遷移。
// - FSRS モード: 「回答する」 押下時は判定 + 解説表示のみ (未 submit)。
//   rate ボタン押下で submit + 自動次へ。

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Card, CardOption } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import { submitReview } from '../_actions/submit-review'
import { equalSet } from '../_lib/equal-set'

type Phase = 'selecting' | 'judged' | 'finished'
type Rating = 1 | 2 | 3 | 4

type SessionRunnerProps = {
  cards: Card[]
  fsrsMode: boolean
}

// opt.text 先頭に opt.id と同じ ID prefix が混入したケースのみ strip (B2 fix, S2.2 T4 review I-1)。
// ID 直後が数字の場合は同一数値 token (例: "1990s") として strip しない。
// 旧実装の `^\d+\s*[.)）]?\s*` regex は本文先頭の数字を機械的に削っており、
// "1990s" → "s"、 "1.5g" → "5g" 等を破壊するため A 案 (startsWith + ID 直後文字種判定) に変更。
function stripPrefix(text: string, optId: string): string {
  if (!text.startsWith(optId)) return text
  const after = text.slice(optId.length)
  if (/^\d/.test(after)) return text
  return after.replace(/^\s*[.)）]?\s*/, '')
}

export function SessionRunner({ cards, fsrsMode }: SessionRunnerProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('selecting')
  const [idx, setIdx] = useState(0)
  const [tally, setTally] = useState({ answered: 0, correct: 0 })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [currentCorrect, setCurrentCorrect] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const current = cards[idx]

  // ---------------------------------------------------------------------------
  // 共通遷移ハンドラ
  // ---------------------------------------------------------------------------
  const goNext = () => {
    const nextIdx = idx + 1
    if (nextIdx >= cards.length) {
      setPhase('finished')
      return
    }
    setIdx(nextIdx)
    setPhase('selecting')
    setSelectedIds([])
    setCurrentCorrect(null)
    setError(null)
  }

  const toggleOption = (optId: string) => {
    if (phase !== 'selecting') return
    setSelectedIds((prev) =>
      prev.includes(optId) ? prev.filter((id) => id !== optId) : [...prev, optId],
    )
  }

  // ---------------------------------------------------------------------------
  // 「回答する」 押下
  // ---------------------------------------------------------------------------
  const handleAnswer = () => {
    if (!current) return
    const options: CardOption[] = Array.isArray(current.options) ? current.options : []
    const correctIds = options.filter((o) => o.is_correct).map((o) => o.id)
    const correct = equalSet(selectedIds, correctIds)

    setError(null)

    if (fsrsMode) {
      // FSRS: 判定 + 解説表示のみ。 rate 押下まで submit しない。
      setCurrentCorrect(correct)
      setPhase('judged')
      return
    }

    // 通常モード: その場で submit (rating mapping: correct→3 / incorrect→1)。
    const rating: Rating = correct ? 3 : 1
    setCurrentCorrect(correct)
    startTransition(async () => {
      const result = await submitReview(current.id, rating)
      if (!result.ok) {
        setError(result.error)
        // submit 失敗時は判定 cache (currentCorrect) を破棄し selecting phase 維持。
        // 同じ選択で 「回答する」 を再押下すれば retry できる (素出し error UI で UX 上十分、
        // S2.2 T4 review I-3 で plan 緩和済)。
        setCurrentCorrect(null)
        return
      }
      setTally((t) => ({
        answered: t.answered + 1,
        correct: t.correct + (correct ? 1 : 0),
      }))
      setPhase('judged')
    })
  }

  // ---------------------------------------------------------------------------
  // FSRS rate 押下
  // ---------------------------------------------------------------------------
  const handleRate = (rating: Rating) => {
    if (!current) return
    setError(null)
    const correctAtSubmit = currentCorrect
    startTransition(async () => {
      const result = await submitReview(current.id, rating)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setTally((t) => ({
        answered: t.answered + 1,
        correct: t.correct + (correctAtSubmit ? 1 : 0),
      }))
      goNext()
    })
  }

  // ---------------------------------------------------------------------------
  // 通常モード 「次へ」 (純遷移、 submit を含まない)
  // ---------------------------------------------------------------------------
  const handleNext = () => {
    goNext()
  }

  // ---------------------------------------------------------------------------
  // 完了画面
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Session UI (selecting / judged)
  // ---------------------------------------------------------------------------
  const options: CardOption[] = Array.isArray(current.options) ? current.options : []
  const isJudged = phase === 'judged'

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      {/* ヘッダー */}
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

      {/* 選択肢 (button 化、 selecting 中 click 可、 judged 後 disabled) */}
      <ul className="space-y-2">
        {options.map((opt) => {
          const isCorrect = opt.is_correct
          const selected = selectedIds.includes(opt.id)
          const showCorrectHl = isJudged && isCorrect
          const showSelectedHl = !isJudged && selected
          const classes = showCorrectHl
            ? 'w-full rounded border border-emerald-300 bg-emerald-100 p-3 text-left text-sm font-bold text-emerald-900'
            : showSelectedHl
              ? 'w-full rounded border border-emerald-400 bg-emerald-50 p-3 text-left text-sm text-slate-900'
              : 'w-full rounded border border-border/60 p-3 text-left text-sm text-slate-800 hover:bg-slate-50'
          const displayText = stripPrefix(opt.text, opt.id)
          return (
            <li key={opt.id}>
              <button
                type="button"
                onClick={() => toggleOption(opt.id)}
                disabled={isJudged}
                aria-pressed={selected}
                className={classes}
              >
                <span className="whitespace-pre-wrap">
                  {isJudged && (
                    <span className="mr-1.5">{isCorrect ? '○' : '×'}</span>
                  )}
                  <span className="mr-2 font-medium">{opt.id}</span>
                  {displayText}
                </span>
                {isJudged && opt.explanation && (
                  <span className="mt-1 block whitespace-pre-wrap text-xs font-normal text-slate-500">
                    解説: {opt.explanation}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {/* 判定 banner (judged 中、 currentCorrect が確定している時) */}
      {isJudged && currentCorrect !== null && (
        <p
          className={
            currentCorrect
              ? 'rounded bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700'
              : 'rounded bg-red-50 px-3 py-2 text-sm font-semibold text-red-700'
          }
        >
          {currentCorrect ? '正解' : '不正解'}
        </p>
      )}

      {/* カード解説 (judged 中) */}
      {isJudged && current.explanationText && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-medium text-slate-500">解説</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
            {current.explanationText}
          </p>
        </div>
      )}

      {/* error */}
      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {/* selecting phase: 「回答する」 */}
      {!isJudged && (
        <div className="flex justify-end">
          <Button
            onClick={handleAnswer}
            disabled={pending || selectedIds.length === 0}
            className="w-full sm:w-auto"
          >
            回答する
          </Button>
        </div>
      )}

      {/* judged phase footer (mode 別) */}
      {isJudged && !fsrsMode && (
        <div className="flex justify-end">
          <Button onClick={handleNext} className="w-full sm:w-auto">
            次へ
          </Button>
        </div>
      )}

      {isJudged && fsrsMode && (
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
    </div>
  )
}
