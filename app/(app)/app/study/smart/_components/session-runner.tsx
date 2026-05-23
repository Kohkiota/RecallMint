'use client'

// SessionRunner — スマート復習 1 session を管理する Client Component (S2.2.3 T1 で 3-button nav 追加)。
//
// Phase machine: selecting → judged → finished
//
// - selecting (両モード共通): 問題文 + 選択肢 + 3 button footer (前へ / 回答する / 次へ)
//   「回答する」 押下は判定のみ (集合一致で currentCorrect 確定 + judged 遷移)、 submit は呼ばない
//   「次へ」 押下は submit せず純遷移 (= スキップ)、 最後 card で finished
//   「前へ」 押下は idx-1 + 前 card selecting reset (submit なし)
// - judged (通常モード): 3 button footer (前へ / リトライ / 次へ primary)
//   「次へ」 で auto rating submit (correct→3 / incorrect→1) + 次 card 自動遷移
//   「リトライ」 で現 card を selecting reset (lastRating=null)、 submit なし
//   「前へ」 で idx-1 + 前 card selecting reset (judged 状態を捨てる、 submit なし)
// - judged (FSRS モード): 上段 4 rate (Again/Hard/Good/Easy) + 下段 3 button (前へ / リトライ / 次へ primary)
//   rate 押下で submit + lastRating セット、 自動次へなし (judged 維持で複数回押下 = 上書き submit)
//   client tally は lastRating === null の初回押下時のみ +1 (連打を 1 カウントに固定)
//   「次へ」 は rate 後のみ enable、 押下で submit せず純遷移 (= 既に submit 済み)
//   「リトライ」 は常時 enable、 現 card を selecting reset (lastRating も null)
//   「前へ」 は idx-1 + 前 card selecting reset (submit なし)
// - finished: 🎉 + 統計 + もう一度 / ダッシュボードへ
//
// 正解判定 = client 集合一致 (順序非依存)。 server 戻り値 data.correct は参照しない
// (FSRS モードで user rating と判定値が乖離するため)。
//
// submit タイミング (mode 別):
// - 通常モード: judged 「次へ」 押下時 (1 click で submit + 次 card 遷移を兼ねる)
// - FSRS モード: judged rate 押下時 (user 選択 rating で submit、 自動遷移なし)
// 失敗時は judged を維持し、 「次へ」 / rate ボタン再押下で retry 可能。

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

// FSRS rate ボタンの className を rating 別 + 押下済 (lastRating 一致) で切替 (S2.2.4)。
// 非選択: outline 風 (border + text 色) / 選択済: 背景 fill + 強コントラスト。
const RATE_BUTTON_BASE = 'h-14 text-base font-semibold'
const RATE_BUTTON_VARIANTS: Record<Rating, { selected: string; idle: string }> = {
  1: {
    selected: 'bg-red-100 text-red-900 border-red-400',
    idle: 'border-red-300 text-red-700 hover:bg-red-50',
  },
  2: {
    selected: 'bg-orange-100 text-orange-900 border-orange-400',
    idle: 'border-orange-300 text-orange-700 hover:bg-orange-50',
  },
  3: {
    selected: 'bg-emerald-100 text-emerald-900 border-emerald-400',
    idle: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
  },
  4: {
    selected: 'bg-blue-100 text-blue-900 border-blue-400',
    idle: 'border-blue-300 text-blue-700 hover:bg-blue-50',
  },
}

function rateButtonClass(rating: Rating, selected: boolean): string {
  const variant = RATE_BUTTON_VARIANTS[rating]
  return `${RATE_BUTTON_BASE} ${selected ? variant.selected : variant.idle}`
}

export function SessionRunner({ cards, fsrsMode }: SessionRunnerProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('selecting')
  const [idx, setIdx] = useState(0)
  const [tally, setTally] = useState({ answered: 0, correct: 0 })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [currentCorrect, setCurrentCorrect] = useState<boolean | null>(null)
  // lastRating: FSRS 判定後の rate 押下済 flag (null=未押下、 数値=押下済)
  // 通常モードでは「次へ」 submit 成功時にもセット (consistency 目的、 通常モードでは
  // button 再表示されないので機能影響なし)。 tally 重複防止の真実 source は
  // submittedCardIds 側に移管したので、 ここでは「次へ」 button enable 制御専用。
  const [lastRating, setLastRating] = useState<Rating | null>(null)
  // submittedCardIds: 「過去に submit が成功した card.id 集合」。 tally +1 の真実 source。
  // resetCardState では touch しないため、 リトライ / 前へ戻り後の再 submit でも
  // isFirstSubmit が再 true にならず、 二重加算を構造的に防ぐ。
  const [submittedCardIds, setSubmittedCardIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const current = cards[idx]

  // ---------------------------------------------------------------------------
  // card 切替時の共通 reset (selecting に戻し、 判定 / rate / error も全 clear)
  // ---------------------------------------------------------------------------
  const resetCardState = () => {
    setSelectedIds([])
    setCurrentCorrect(null)
    setLastRating(null)
    setError(null)
    setPhase('selecting')
  }

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
    resetCardState()
  }

  const goPrev = () => {
    if (idx === 0) return
    setIdx(idx - 1)
    resetCardState()
  }

  const toggleOption = (optId: string) => {
    if (phase !== 'selecting') return
    setSelectedIds((prev) =>
      prev.includes(optId) ? prev.filter((id) => id !== optId) : [...prev, optId],
    )
  }

  // ---------------------------------------------------------------------------
  // selecting 「回答する」: 集合一致で判定し judged に遷移するだけ (submit は呼ばない)
  // ---------------------------------------------------------------------------
  const handleAnswer = () => {
    if (!current) return
    const options: CardOption[] = Array.isArray(current.options) ? current.options : []
    const correctIds = options.filter((o) => o.is_correct).map((o) => o.id)
    const correct = equalSet(selectedIds, correctIds)
    setCurrentCorrect(correct)
    setError(null)
    setPhase('judged')
  }

  // ---------------------------------------------------------------------------
  // selecting 「次へ」: submit せず純遷移 (= 答えなかった card のスキップ)
  // ---------------------------------------------------------------------------
  const handleSkipNext = () => {
    goNext()
  }

  // ---------------------------------------------------------------------------
  // 「前へ」: 両 phase 共通、 idx-1 + reset (submit なし、 idx=0 で no-op)
  // ---------------------------------------------------------------------------
  const handlePrev = () => {
    goPrev()
  }

  // ---------------------------------------------------------------------------
  // 「リトライ」: judged → selecting reset、 idx 不変 (submit なし)
  // ---------------------------------------------------------------------------
  const handleRetry = () => {
    resetCardState()
  }

  // ---------------------------------------------------------------------------
  // submit 共通 (rating 指定、 成功時 callback で次動作分岐)
  // ---------------------------------------------------------------------------
  const runSubmit = (rating: Rating, onSuccess: () => void) => {
    if (!current) return
    if (currentCorrect === null) return
    const correctSnapshot = currentCorrect
    const cardId = current.id
    // card 単位で初回 submit のみ tally 加算。 rate 連打 / リトライ後再回答 /
    // 前へ戻り後再回答 いずれも 1 枚 1 カウント。 server 側は submit-review-tx の
    // UPDATE で常に最新 rating で上書き (= 二重登録なし)。
    const isFirstSubmit = !submittedCardIds.has(cardId)
    startTransition(async () => {
      const result = await submitReview(cardId, rating)
      if (!result.ok) {
        setError(result.error)
        // judged 維持 → 同 button で retry 可 (失敗時は submittedCardIds touch しない)
        return
      }
      if (isFirstSubmit) {
        setTally((t) => ({
          answered: t.answered + 1,
          correct: t.correct + (correctSnapshot ? 1 : 0),
        }))
        // immutable update: 既存 Set を copy + add (React 同一参照判定を回避)
        setSubmittedCardIds((s) => new Set(s).add(cardId))
      }
      // setLastRating は FSRS judged 「次へ」 enable 用 flag。 通常モードでは
      // onSuccess (goNext) 内 resetCardState で null に戻るため値は使われないが、
      // runSubmit の分岐を増やさず両モード共通で set。
      setLastRating(rating)
      onSuccess()
    })
  }

  // 通常モード「次へ」: client 判定結果から rating 自動決定 (correct→3 / incorrect→1)、
  // submit 成功時に goNext (lastRating セットも consistency 目的で発火)
  const handleNextNormal = () => {
    if (currentCorrect === null) return
    const rating: Rating = currentCorrect ? 3 : 1
    runSubmit(rating, () => goNext())
  }

  // FSRS モード judged rate 押下: user 選択 rating でそのまま submit (自動次へなし、 judged 維持)
  // 連打可 = 最後 rating で上書き submit (submit-review-tx の UPDATE で自然反映)
  const handleRateFsrs = (rating: Rating) => {
    runSubmit(rating, () => {
      // judged 維持、 idx 前進なし
    })
  }

  // FSRS モード judged 「次へ」: rate 押下済 (= submit 済) を前提に submit せず純遷移
  const handleNextFsrsAfterRate = () => {
    if (lastRating === null) return
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
  const isFirstCard = idx === 0

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

      {/* selecting phase footer: 3 button (前へ / 回答する primary / 次へ) */}
      {!isJudged && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Button
            onClick={handlePrev}
            disabled={isFirstCard || pending}
            variant="outline"
            className="h-12"
          >
            ← 前へ
          </Button>
          <Button
            onClick={handleAnswer}
            disabled={selectedIds.length === 0 || pending}
            className="h-12"
          >
            回答する
          </Button>
          <Button
            onClick={handleSkipNext}
            disabled={pending}
            variant="outline"
            className="h-12"
          >
            次へ →
          </Button>
        </div>
      )}

      {/* judged phase footer 通常モード: 3 button (前へ / リトライ / 次へ primary) */}
      {isJudged && !fsrsMode && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Button
            onClick={handlePrev}
            disabled={isFirstCard || pending}
            variant="outline"
            className="h-12"
          >
            ← 前へ
          </Button>
          <Button
            onClick={handleRetry}
            disabled={pending}
            variant="outline"
            className="h-12"
          >
            ↺ リトライ
          </Button>
          <Button
            onClick={handleNextNormal}
            disabled={pending}
            className="h-12"
          >
            次へ →
          </Button>
        </div>
      )}

      {/* judged phase footer FSRS モード: 上段 4 rate + 下段 3 nav */}
      {isJudged && fsrsMode && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Button
              onClick={() => handleRateFsrs(1)}
              disabled={pending}
              variant="outline"
              className={rateButtonClass(1, lastRating === 1)}
            >
              Again
            </Button>
            <Button
              onClick={() => handleRateFsrs(2)}
              disabled={pending}
              variant="outline"
              className={rateButtonClass(2, lastRating === 2)}
            >
              Hard
            </Button>
            <Button
              onClick={() => handleRateFsrs(3)}
              disabled={pending}
              variant="outline"
              className={rateButtonClass(3, lastRating === 3)}
            >
              Good
            </Button>
            <Button
              onClick={() => handleRateFsrs(4)}
              disabled={pending}
              variant="outline"
              className={rateButtonClass(4, lastRating === 4)}
            >
              Easy
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
            <Button
              onClick={handlePrev}
              disabled={isFirstCard || lastRating === null || pending}
              variant="outline"
              className="h-12"
            >
              ← 前へ
            </Button>
            <Button
              onClick={handleRetry}
              disabled={pending}
              variant="outline"
              className="h-12"
            >
              ↺ リトライ
            </Button>
            <Button
              onClick={handleNextFsrsAfterRate}
              disabled={lastRating === null || pending}
              className="h-12"
            >
              次へ →
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
