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
//   「次へ」 で fire-and-forget submit (correct→3 / incorrect→1) + 即時 次 card 遷移
//   「リトライ」 で現 card を selecting reset (lastRating=null)、 submit なし
//   「前へ」 で idx-1 + 前 card selecting reset (judged 状態を捨てる、 submit なし)
// - judged (FSRS モード): 上段 4 rate (Again/Hard/Good/Easy) + 下段 3 button (前へ / リトライ / 次へ primary)
//   rate 押下は **state 更新のみ** (setLastRating + 初回 tally/submittedCardIds 加算)、
//   Dexie write は発火しない。 lastRating は click 時即セットでハイライト即時反映、
//   連打可 = last write wins (rate ボタンは pending で disable しない)。
//   client tally は submittedCardIds で初回押下のみ +1 (連打を 1 カウントに固定)。
//   実 submit (Dexie write) は judged + rated 状態で 「次へ」 / 「前へ」 押下時に
//   lastRating で 1 件発火 (= rate-then-confirm 仕様、 spec §3.2 / §3.6)。
//   「次へ」 は rate 後のみ enable、 押下で runSubmit(lastRating) + goNext
//   「リトライ」 は常時 enable、 現 card を selecting reset (lastRating も null)
//   「前へ」 は idx-1 + 前 card selecting reset (FSRS judged + rated でのみ submit)
// - finished: 🎉 + 統計 + もう一度 / ダッシュボードへ
//
// 正解判定 = client 集合一致 (順序非依存)。 server 戻り値 data.correct は参照しない
// (FSRS モードで user rating と判定値が乖離するため)。
//
// submit タイミング (mode 別、 fire-and-forget):
// - 通常モード: judged 「次へ」 押下時 (1 click で setLastRating/tally → 即 next card →
//   submit を await せず発火、 失敗時のみ error 表示)
// - FSRS モード: judged rate 押下では submit せず state 更新のみ。 実 submit は
//   judged + rated 状態で 「次へ」 / 「前へ」 押下時に lastRating で 1 件発火
//   (= rate-then-confirm、 spec §3.2 / §3.6)。 連打は state 上書きのみで Dexie
//   write は走らない (= 確定タイミングで 1 件のみ record)。
// 失敗時:
// - rate / 通常モード「次へ」 共通: inline error 表示のみ、 state 巻き戻しなし
// - 通常モード「次へ」 で submit 失敗時は既に次 card に遷移済 (= 巻き戻さず error のみ)
// - 多段失敗: c1 「次へ」 で fail 中に user が c2 → c3 と進んだ場合、 fail promise
//   resolve 時点では idx が c3 に居るため error は c3 card 画面上に表示される。
//   どの card に対する失敗か UI 上区別できない (MVP UX として user spec で許容)。
//   将来 UX を厳密化する場合は cardId snapshot guard (`current?.id === capturedId`)
//   または error 文字列に card idx を prefix する案がある。
//
// fire-and-forget の安全性根拠: runSubmit の Dexie write / flush は内部 async IIFE で
// try/catch して握り潰す (失敗は pending のまま次 flush で retry)。 ゆえに呼出側で
// `.catch` 不要、 unhandled promise rejection を発生させない。 server 反映は bulk API
// 経路 (§14.8) が担い、 revalidate を使わないため active page の RSC payload race も起きない。
//
// unmount 中の fire-and-forget: SessionRunner unmount (完了画面からの navigation
// 等) 中に submit が resolve しても、 React 18+ の setState on unmounted は silent
// no-op (旧 warning は React 18 で削除済) のため害なし。 mountedRef は不要。

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Card, CardOption } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import { MdTableText, MdTableBlock } from '@/components/markdown/md-table-text'
import { CardImageGallery } from '@/app/(app)/app/exams/[id]/_components/card-image-gallery'
import { isAssetKey } from '@/lib/validation/card'
import { equalSet } from '../_lib/equal-set'
import {
  completeStudySession,
  countPendingAnswerEvents,
  flushAllPendingEvents,
  flushPendingEvents,
  recordAnswerEvent,
} from '@/lib/sync/review-events'
import { classifyFlushResults } from '@/lib/sync/review-flush'
import { pullBack } from '@/lib/sync/pull-back'
import { deriveCorrectAnswerIds } from '@/lib/cards/domain/card-rules'

// S-cache-1: pending answer_events がこの件数に達した時点で bulk flush。
// §14.7.1 「pending 5 件以上 / セッション終了 / ネット復活 / アプリ起動・復帰」 の
// 5 件しきい値。 他トリガー (ネット復活 / 起動・復帰 / visibilitychange) は
// 後続 sprint で実装、 本 sprint は「5 件 / セッション終了」 のみ配線する。
const FLUSH_THRESHOLD = 5

type Phase = 'selecting' | 'judged' | 'finished'
type Rating = 1 | 2 | 3 | 4

type SessionRunnerProps = {
  cards: Card[]
  fsrsMode: boolean
  // S-cache-1: 演習開始時に呼出 client が uuidv4 で発行する session_id。
  // Dexie study_sessions の PK に対応、 全 answer_events を紐付ける。
  // 親 (SessionLauncher) が Dexie に session 行を入れてから渡す。
  sessionId: string
  // セッション見出し。 省略時は 'スマート復習'。 custom mode など呼出側が差し替え可能。
  heading?: string
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

// FSRS rate ボタンの className を rating 別 + 押下済 (lastRating 一致) で切替 (S2.2.4, S2.2.5)。
// idle: outline 風 (border + text 色)、 button variant="outline" (bg-background ベース)。
// selected: 濃色 fill + 白文字、 button variant="default" 側に当てて bg-primary を override。
// S2.2.4 で bg-{c}-100 (薄色) を outline 上に重ねる方式だと bg-background と cn() merge で
// 視覚的 fill が確実に出ない不具合があったため、 S2.2.5 で variant 切替 + 濃色 (bg-{c}-600) に変更。
//
// transition-none: 共通 Button base の `transition-all` を rate ボタンに限り上書きして
// 色/背景の transition を切る。 これがないと rate 切替時に前選択 (濃色→outline) と
// 新選択 (outline→濃色 fill) の 2 個が ~150ms cross-fade し、 色が滲んで「もっさり」体感に
// なる。 setLastRating は元々同期即時だが見た目のフェードだけが遅延源だったため、 snap
// 切替に倒す。 twMerge が後勝ちで base の transition-all を transition-none に解決する。
// scope は rate ボタン 4 個のみ (RATE_BUTTON_BASE は rateButtonClass 経由でしか使われない)。
const RATE_BUTTON_BASE = 'h-14 text-base font-semibold transition-none'
const RATE_BUTTON_VARIANTS: Record<Rating, { selected: string; idle: string }> = {
  1: {
    selected: 'bg-red-600 text-white border-red-600 hover:bg-red-700',
    idle: 'border-red-300 text-red-700 hover:bg-red-50',
  },
  2: {
    selected: 'bg-orange-600 text-white border-orange-600 hover:bg-orange-700',
    idle: 'border-orange-300 text-orange-700 hover:bg-orange-50',
  },
  3: {
    selected: 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700',
    idle: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
  },
  4: {
    selected: 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700',
    idle: 'border-blue-300 text-blue-700 hover:bg-blue-50',
  },
}

function rateButtonClass(rating: Rating, selected: boolean): string {
  const variant = RATE_BUTTON_VARIANTS[rating]
  return `${RATE_BUTTON_BASE} ${selected ? variant.selected : variant.idle}`
}

export function SessionRunner({ cards, fsrsMode, sessionId, heading = 'スマート復習' }: SessionRunnerProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('selecting')
  const [idx, setIdx] = useState(0)
  const [tally, setTally] = useState({ answered: 0, correct: 0 })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [currentCorrect, setCurrentCorrect] = useState<boolean | null>(null)
  // lastRating: FSRS 判定後の rate 押下済 flag (null=未押下、 数値=押下済)
  // 通常モードでは「次へ」 submit 成功時にもセット (consistency 目的、 通常モードでは
  // button 再表示されないので機能影響なし)。 tally 重複防止の真実 source は
  // submittedCardIds 側に移管したので、 ここでは「次へ」 / 「前へ」 button enable
  // 制御 + runSubmit の rating payload 兼用 (Step 3b、 spec §3.2)。
  const [lastRating, setLastRating] = useState<Rating | null>(null)
  // submittedCardIds: 「click 時点で 1 枚分の試行として確定された card.id 集合」。
  // tally +1 の真実 source。 fire-and-forget 化により add は click 同期で実行され、
  // submit 失敗でも rollback しない (= last write wins な MVP UX で、 「触ったら 1 枚」)。
  // resetCardState では touch しないため、 リトライ / 前へ戻り後の再 submit でも
  // isFirstSubmit が再 true にならず、 二重加算を構造的に防ぐ。
  const [submittedCardIds, setSubmittedCardIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [error, setError] = useState<string | null>(null)

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
    const correctIds = deriveCorrectAnswerIds(options)
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
  // 「前へ」: 両 phase 共有の handler。
  // - FSRS judged + rated (= lastRating !== null) の場合のみ runSubmit で 1 件 Dexie write
  //   + 前 card 遷移 (Step 3b、 詳細 spec §3.2 / §3.3)。
  // - selecting / 通常 judged / FSRS rate 前 (= lastRating === null) は既存挙動維持
  //   (submit 呼ばず goPrev のみ)。
  // idx === 0 早期 return は runSubmit 空打ち防止 (goPrev 内にも guard あるが、
  // 関数先頭で弾けば logical flow が読みやすい)。
  // ---------------------------------------------------------------------------
  const handlePrev = () => {
    if (idx === 0) return
    if (fsrsMode && phase === 'judged' && lastRating !== null) {
      runSubmit(lastRating, () => goPrev())
    } else {
      goPrev()
    }
  }

  // ---------------------------------------------------------------------------
  // 「リトライ」: judged → selecting reset、 idx 不変 (submit なし)
  // ---------------------------------------------------------------------------
  const handleRetry = () => {
    resetCardState()
  }

  // ---------------------------------------------------------------------------
  // submit 共通 (rating 指定、 即時 state 更新 → onAfter で navigation 分岐 →
  // submit を fire-and-forget で発火、 失敗時 inline error のみ)
  // ---------------------------------------------------------------------------
  const runSubmit = (rating: Rating, onAfter: () => void) => {
    if (!current) return
    if (currentCorrect === null) return
    const correctSnapshot = currentCorrect
    const cardId = current.id
    // card 単位で初回 submit のみ tally 加算。 rate 連打 / リトライ後再回答 /
    // 前へ戻り後再回答 いずれも 1 枚 1 カウント。 server 側は review-events/bulk 経路
    // (lib/reviews/ingest-review-events) の UPDATE で常に最新 rating で上書き (= 二重登録なし)。
    const isFirstSubmit = !submittedCardIds.has(cardId)

    // 1) Optimistic 即時 state 更新 (server 応答待ちなし)。
    //    setError(null) は同 card / 別 card に持ち越さないため毎回 clear。
    setError(null)
    if (isFirstSubmit) {
      setTally((t) => ({
        answered: t.answered + 1,
        correct: t.correct + (correctSnapshot ? 1 : 0),
      }))
      // immutable update: 既存 Set を copy + add (React 同一参照判定を回避)。
      // 失敗時も rollback しない: client tally は試行数 = answered としての扱いで、
      // last write wins な fire-and-forget 設計と整合する (= server 側は最新 submit
      // が確定するまで未確定だが、 client UX としては 「触ったら 1 枚」)。
      setSubmittedCardIds((s) => new Set(s).add(cardId))
    }
    setLastRating(rating)

    // 2) onAfter (= goNext or no-op) を即時実行。 通常モード「次へ」 はここで
    //    次 card に進む。 FSRS rate は no-op で judged 維持。
    onAfter()

    // 3) S-cache-1: Dexie answer_events に即 insert (debounce なし、 §14.7.1)、
    //    pending が FLUSH_THRESHOLD に達したら bulk flush。 失敗は inline error に
    //    出さず pending のまま次 flush で再試行 (= 旧 submitReview の error UI は
    //    廃止、 セッション終了 useEffect の final flush でもう一度試行する)。
    //    rating は通常モードは client 判定 (correct→3 / incorrect→1)、 FSRS モードは
    //    user 選択値 (1-4) をそのまま payload に乗せて server に届ける。
    void (async () => {
      try {
        await recordAnswerEvent({
          session_id: sessionId,
          card_id: cardId,
          selected_answer_ids: [...selectedIds],
          is_correct: correctSnapshot,
          answered_at: new Date().toISOString(),
          rating,
        })
        const pending = await countPendingAnswerEvents(sessionId)
        if (pending >= FLUSH_THRESHOLD) {
          const r = await flushPendingEvents(sessionId)
          // daily=threshold のとき threshold flush が実 sync を担う(session 完了 flush は残件 0 で skip)。
          // 実 sync 成功(syncedEventIds 非空 → classify 'ok')のときだけ pull-back して FSRS 値を mirror へ戻す。
          // skip(attempted:0 → classify 'no-pending')や失敗では不発。
          if (classifyFlushResults([r]) === 'ok') pullBack('threshold-flush')
        }
      } catch {
        // Dexie write / flush の background 失敗は UI に出さず、 次 trigger で再試行。
      }
    })()
  }

  // ---------------------------------------------------------------------------
  // phase='finished' で study_sessions を completed に + 全 session group flush。
  // §14.7.1 「セッション終了 → bulk flush」 のトリガ。
  // completeStudySession で完了 status を Dexie に書いてから group flush する順序を維持。
  // 失敗は silent (Dexie 側 pending が残るので次 session 開始や online 復帰時に拾える前提)。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'finished') return
    void (async () => {
      try {
        await completeStudySession(sessionId)
      } catch {}
      try {
        const results = await flushAllPendingEvents()
        // 通常復習はこの直叩き経路で queue を drain するため controller hook では拾えない。
        // flush 成功 (全件 synced) のときのみ pull-back: FSRS 再計算後のサーバー値を mirror へ戻す。
        if (classifyFlushResults(results) === 'ok') pullBack('session-complete')
      } catch {}
    })()
  }, [phase, sessionId])

  // 通常モード「次へ」: client 判定結果から rating 自動決定 (correct→3 / incorrect→1)、
  // 即時 next card に遷移 + submit fire-and-forget (失敗時は次 card 上に error 表示)
  const handleNextNormal = () => {
    if (currentCorrect === null) return
    const rating: Rating = currentCorrect ? 3 : 1
    runSubmit(rating, () => goNext())
  }

  // FSRS モード judged rate 押下: **state 更新のみ** (Dexie write しない)。
  // 連打可 = 最後 rating で setLastRating 上書きのみ、 tally / submittedCardIds は
  // 初回押下時のみ +1 (= runSubmit 内の isFirstSubmit gate と同一加算式を inline)。
  // 実 submit (Dexie write) は judged + rated 状態で 「次へ」 / 「前へ」 押下時に
  // 1 件発火 (= rate-then-confirm 仕様、 spec §3.2 / §3.6)。
  const handleRateFsrs = (rating: Rating) => {
    if (!current) return
    if (currentCorrect === null) return
    const cardId = current.id
    const correctSnapshot = currentCorrect
    const isFirstSubmit = !submittedCardIds.has(cardId)
    setError(null)
    if (isFirstSubmit) {
      setTally((t) => ({
        answered: t.answered + 1,
        correct: t.correct + (correctSnapshot ? 1 : 0),
      }))
      setSubmittedCardIds((s) => new Set(s).add(cardId))
    }
    setLastRating(rating)
    // Dexie write は handleNextFsrsAfterRate / handlePrev (FSRS judged + rated)
    // に移譲 (Step 3b、 spec §3.2 / §3.6)
  }

  // FSRS モード judged 「次へ」: rate 押下済 (= lastRating セット済) の card を
  // runSubmit で 1 件 Dexie write + 次 card 遷移 (Step 3b、 詳細 spec §3.2 / §3.6)。
  // lastRating === null guard は defensive (UI で button disabled だが handler 内 guard も keep)。
  // runSubmit 内 isFirstSubmit gate が二重加算を防止 (Task 3 で rate click 時に submittedCardIds.add 済)。
  const handleNextFsrsAfterRate = () => {
    if (lastRating === null) return
    runSubmit(lastRating, () => goNext())
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
          <Button
            variant="outline"
            onClick={() => router.push('/app')}
            className="w-full sm:w-auto"
          >
            ダッシュボードへ
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
  // Sprint I W4: テキスト無しでも解説画像だけで解説節を出すため(4 面化で生まれるエッジ)。
  const hasExplanationImage = (Array.isArray(current.images) ? current.images : []).some(
    (i) => i.key && isAssetKey(i.key) && i.target === 'explanation_text',
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{heading}</h1>
        <span className="text-sm text-slate-500">
          {idx + 1} / {cards.length}
        </span>
      </div>

      {/* 問題文 (見出しは card.title。 試験詳細 inline-card-list の title 表示と
          同じ class を当てて見え方を揃える) */}
      <div className="rounded-lg border border-border bg-slate-50 p-4">
        <p className="text-sm font-medium text-slate-900">{current.title}</p>
        {/* Sprint T (C): 問題文 display のみ MD 表 read-only 描画。表 0 個は <p> 維持で
            DOM 同一(不変条件①)、表を含む時のみ <div>(p>table の hydration 破壊回避)。 */}
        <MdTableBlock
          value={current.questionText}
          className="mt-1 whitespace-pre-wrap text-sm text-slate-900 sm:text-base"
        />
        {/* 学習ビューは read-only gallery のみ (添付・削除は編集画面限定、 画像フェーズ A
            Task 11 / spec §5)。 per-option gallery は Task 10 同様スコープ外。 */}
        <div className="mt-2">
          <CardImageGallery
            images={current.images}
            target="question_text"
            cardId={current.id}
            userId={current.userId}
            readOnly
            display="inflow"
          />
        </div>
      </div>

      {/* 選択肢 (button 化、 selecting 中 click 可、 judged 後 disabled) */}
      <ul className="space-y-2">
        {options.map((opt) => {
          const isCorrect = opt.is_correct
          const selected = selectedIds.includes(opt.id)
          // Sprint T(選択保持 fix): 2 軸表示。
          // 軸1 = 正誤(背景・判定後のみ): 正解 = emerald / 不正解 = plain(× marker で判別)。
          // 軸2 = 選択(sky ring + badge・判定前後で一貫した独立チャネル): 回答時に選択状態を
          //   捨てず残す。多択で「選んだ正解 vs 選び逃した正解」「選んだ誤答 vs 選ばなかった
          //   誤答」を区別可能にする(正誤の背景とは独立ゆえ緑で潰れない)。灰色化は採らない。
          const correctnessClass = isJudged
            ? isCorrect
              ? 'border-emerald-300 bg-emerald-100 font-bold text-emerald-900'
              : 'border-border/60 text-slate-800'
            : 'border-border/60 text-slate-800 hover:bg-slate-50'
          const selectionClass = selected ? ' ring-2 ring-sky-500' : ''
          const classes = `w-full rounded border p-3 text-left text-sm ${correctnessClass}${selectionClass}`
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
                  {/* Sprint T (D): 選択肢本文 display のみ MD 表描画。span 内 table は
                      parser-safe(spec §3.3)。表 0 個は text node で DOM 不変。 */}
                  <MdTableText value={displayText} />
                </span>
                {/* 選択チャネルの非色キュー(色覚非依存)。判定後に「自分が選んだ」を明示。 */}
                {isJudged && selected && (
                  <span className="mt-1 block w-fit rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800">
                    あなたの回答
                  </span>
                )}
                {isJudged && opt.explanation && (
                  <span className="mt-1 block whitespace-pre-wrap text-xs font-normal text-slate-500">
                    解説: <MdTableText value={opt.explanation} />
                  </span>
                )}
              </button>
              {/* Sprint I W4: 選択肢画像の read-only 表示(選択フェーズから可視 = 解く時に見る)。
                  button の外に置く(button 内に nested interactive を作らない)。uid あり時のみ
                  (target=option:<uid>)。画像 0 件の option は gallery が null で thumbnail 増ゼロ
                  (問題文 gallery と同じ wrapper パターン)。 */}
              {opt.uid && (
                <div className="mt-1">
                  <CardImageGallery
                    images={current.images}
                    target={`option:${opt.uid}`}
                    cardId={current.id}
                    userId={current.userId}
                    readOnly
                    display="inflow"
                  />
                </div>
              )}
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

      {/* カード解説 (judged 中)。Sprint I W4: 解説画像も read-only 表示。表示条件を
          「テキストあり or 解説画像あり」に拡張(画像だけ添付した card で解説節ごと消える
          エッジを閉じる = 4 面化で初めて生まれるエッジ)。 */}
      {isJudged && (current.explanationText || hasExplanationImage) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-medium text-slate-500">解説</p>
          {current.explanationText && (
            /* Sprint T (E): カード解説 display のみ MD 表描画。C と同じく表を含む時のみ
               <p>→<div>(hydration 破壊回避)、表 0 個は <p> 維持で DOM 同一。 */
            <MdTableBlock
              value={current.explanationText}
              className="mt-1 whitespace-pre-wrap text-sm text-slate-700"
            />
          )}
          <div className="mt-2">
            <CardImageGallery
              images={current.images}
              target="explanation_text"
              cardId={current.id}
              userId={current.userId}
              readOnly
              display="inflow"
            />
          </div>
        </div>
      )}

      {/* Sprint T(メモ学習面表示): 回答後のみ・非空時のみ。出自の違い(解説=試験の公式解説
          /メモ=ユーザー自身の記録)を混同させないため amber の別スタイル島にする(解説は blue)。
          MdTableBlock 経由(解説と同型: className を当て、表を含む時のみ <p>→<div>。6 番目の
          挿入点・メモにも MD 表が入りうる)。read-only(編集 UI なし)。 */}
      {isJudged && current.memo && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-medium text-amber-700">メモ(あなたの記録)</p>
          <MdTableBlock
            value={current.memo}
            className="mt-1 whitespace-pre-wrap text-sm text-slate-700"
          />
        </div>
      )}

      {/* error */}
      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {/* selecting phase footer: 3 button (前へ / 回答する primary / 次へ)。
          fire-and-forget 化により pending gate は撤回 (selecting 中は submit 自体
          発火しないため pending 概念が存在しない)。 */}
      {!isJudged && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Button
            onClick={handlePrev}
            disabled={isFirstCard}
            variant="outline"
            className="h-12"
          >
            ← 前へ
          </Button>
          {/* disabled 撤去: 選択 0 件でも押下可能。 正解あり card は equalSet で
              不正解、 正解 0 件 card (OCR で正答未抽出) は equalSet([], []) で正解と
              判定され、 いずれも judged 遷移して 「次へ」 で先に進める。 */}
          <Button
            onClick={handleAnswer}
            className="h-12"
          >
            回答する
          </Button>
          <Button
            onClick={handleSkipNext}
            variant="outline"
            className="h-12"
          >
            次へ →
          </Button>
        </div>
      )}

      {/* judged phase footer 通常モード: 3 button (前へ / リトライ / 次へ primary)。
          「次へ」 は fire-and-forget submit + 即遷移、 pending 待ちなし。 */}
      {isJudged && !fsrsMode && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Button
            onClick={handlePrev}
            disabled={isFirstCard}
            variant="outline"
            className="h-12"
          >
            ← 前へ
          </Button>
          <Button
            onClick={handleRetry}
            variant="outline"
            className="h-12"
          >
            ↺ リトライ
          </Button>
          <Button
            onClick={handleNextNormal}
            className="h-12"
          >
            次へ →
          </Button>
        </div>
      )}

      {/* judged phase footer FSRS モード: 上段 4 rate + 下段 3 nav。
          rate ボタンは pending で disable しない (= 連打で last write wins、 仕様)。
          lastRating は click 時に同期的に set されるため、 「次へ」 / 「前へ」 の
          lastRating gate は click 直後に enable される。 */}
      {isJudged && fsrsMode && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Button
              onClick={() => handleRateFsrs(1)}
              variant={lastRating === 1 ? 'default' : 'outline'}
              className={rateButtonClass(1, lastRating === 1)}
            >
              Again
            </Button>
            <Button
              onClick={() => handleRateFsrs(2)}
              variant={lastRating === 2 ? 'default' : 'outline'}
              className={rateButtonClass(2, lastRating === 2)}
            >
              Hard
            </Button>
            <Button
              onClick={() => handleRateFsrs(3)}
              variant={lastRating === 3 ? 'default' : 'outline'}
              className={rateButtonClass(3, lastRating === 3)}
            >
              Good
            </Button>
            <Button
              onClick={() => handleRateFsrs(4)}
              variant={lastRating === 4 ? 'default' : 'outline'}
              className={rateButtonClass(4, lastRating === 4)}
            >
              Easy
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
            <Button
              onClick={handlePrev}
              disabled={isFirstCard || lastRating === null}
              variant="outline"
              className="h-12"
            >
              ← 前へ
            </Button>
            <Button
              onClick={handleRetry}
              variant="outline"
              className="h-12"
            >
              ↺ リトライ
            </Button>
            <Button
              onClick={handleNextFsrsAfterRate}
              disabled={lastRating === null}
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
