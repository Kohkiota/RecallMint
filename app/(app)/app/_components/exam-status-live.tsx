'use client'

// exam-status-live — 試験一覧の OCR ステータスを polling で live 更新する client 層。
//
// ExamStatusProvider:
//   - 初回 render (server) の statusMap を初期値に、polling session を分岐起動する。
//   - polling session: /api/exams/status を 5 秒間隔で叩き、毎 tick で
//     setStatuses(next) を行ってバッジを更新する。各 tick で:
//       * phase-1: processing が 1 件以上 → runGuardedPull({reason:'ocr-pending'})
//         を発火し、新規 processing exam とその後の card を Dexie mirror に取り込む。
//       * phase-2: processing → completed/failed 遷移 (hasCompletion) →
//         router.refresh() + runGuardedPull({reason:'ocr-complete'})。
//   - session の起動経路は 3 つ:
//       (1) seed に processing あり → sawProcessing=true で起動、grace なし。
//           processing が 0 になった時点で恒久停止 (従来挙動)。
//       (2) seed が failed のみ (processing なし) → 継続 session ではなく
//           mount 時 1 回だけ poll (reconcile)。deriveExamStatuses の
//           >15 分 processing 残骸 cleanup を起動するため。grace polling しない。
//       (3) OCR 開始 signal (subscribeOcrPoll) → kick で session 起動。
//           kick 時点では exam 行が server commit 前の可能性があり、最初の数
//           tick が empty を返しうる。sawProcessing を立てるまでは
//           KICK_MAX_EMPTY_TICKS 回の empty で恒久停止し、無限 poll を防ぐ。
//   - タブが hidden の間は interval を止め、可視復帰で再開 + 即時 tick。
//   - inFlight guard で同時 tick の二重起動を防ぐ。
//   - kick が既存 session 実行中に来ても二重 interval は作らない (冪等)。
//
// ExamStatusBadge:
//   - context から自分の examId の status を読み、処理中 / 失敗バッジを描画する。
//   - server component の各 exam 行に埋め込み、バッジ部分のみを client 化する。

import { type ReactNode, createContext, useContext, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  type ExamStatusMap,
  hasCompletion,
  processingIds,
} from './exam-status-poll'
import { runGuardedPull } from '@/lib/sync/pull'
import { subscribeOcrPoll } from '@/lib/exams/ocr-poll-signal'

const POLL_INTERVAL_MS = 5000
const STATUS_ENDPOINT = '/api/exams/status'
// kick 起動 session が processing 行を一度も観測しないまま empty を返し続けた
// 場合の最大 tick 数 (≈30s)。exam 行 commit 待ちを bound しつつ、OCR 送信が
// validation 失敗等で processing 行を作らなかった場合の無限 poll を防ぐ。
const KICK_MAX_EMPTY_TICKS = 6

const ExamStatusContext = createContext<ExamStatusMap>({})

export function ExamStatusProvider({
  initialStatuses,
  userId,
  children,
}: {
  initialStatuses: ExamStatusMap
  userId: string
  children: ReactNode
}) {
  const router = useRouter()
  const [statuses, setStatuses] = useState<ExamStatusMap>(initialStatuses)
  // initialStatuses は server render ごとに新しい object identity になる
  // (page.tsx の Object.fromEntries)。useState で初回値を凍結し effect の
  // 依存を安定させ、mount 時 1 回だけ実行する。これにより router.refresh()
  // で親が再 render しても polling loop を作り直さない。
  const [initialSnapshot] = useState(initialStatuses)

  useEffect(() => {
    // effect 全体 (継続 session / one-shot reconcile / kick subscription) を
    // 通貫する停止フラグ。unmount で polling・即時 tick を恒久停止する。
    let stopped = false
    let inFlight = false // 同時 tick の二重起動を防ぐ
    let intervalId: ReturnType<typeof setInterval> | undefined

    // ── 現在の継続 session 状態 (kick / seed-processing で開始される) ──
    // session 非実行中は sessionActive=false。
    let sessionActive = false
    // 直前 poll で processing だった examId 集合 (遷移判定用)。
    let prevProcessing: Set<string> = new Set()
    // この session 中に processing を 1 度でも観測したか。
    let sawProcessing = false
    // kick 起動かつ未だ processing 未観測時の grace 残カウント。
    let kickGraceLeft = 0

    const stopInterval = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId)
        intervalId = undefined
      }
    }

    // session を恒久終了する (interval 停止 + active 解除)。
    const endSession = () => {
      sessionActive = false
      stopInterval()
    }

    const tick = async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        const res = await fetch(STATUS_ENDPOINT, { cache: 'no-store' })
        if (stopped || !res.ok) return
        const data = (await res.json()) as { statuses?: ExamStatusMap }
        if (stopped) return
        const next = data.statuses ?? {}
        setStatuses(next)

        const nextProcessing = processingIds(next)

        if (nextProcessing.size > 0) {
          sawProcessing = true
          // phase-1: 処理中行があれば mirror に取り込むため毎 tick pull する。
          // (phase-2 と同 tick で両方発火しても runGuardedPull の in-flight
          //  guard が単一 pull に dedupe するため特別扱い不要。)
          void runGuardedPull({ userId, reason: 'ocr-pending' }).catch(() => {})
        }

        // phase-2: processing → completed/failed 遷移時のみ refresh + pull。
        if (hasCompletion(prevProcessing, nextProcessing)) {
          router.refresh()
          void runGuardedPull({ userId, reason: 'ocr-complete' }).catch(() => {})
        }
        prevProcessing = nextProcessing

        if (nextProcessing.size === 0) {
          if (sawProcessing) {
            // processing を見届けた後の 0 → 恒久停止 (完了/失敗 semantics)。
            endSession()
          } else if (kickGraceLeft > 0) {
            // kick 起動だが行未出現: grace を 1 消費し、尽きたら停止する。
            kickGraceLeft -= 1
            if (kickGraceLeft <= 0) endSession()
          } else {
            // grace なし (seed-processing で sawProcessing 偽は通常起きないが
            // 防御的に) → 停止。
            endSession()
          }
        }
      } catch {
        // network error 等は無視し、次 tick で再試行する。
      } finally {
        inFlight = false
      }
    }

    const startInterval = () => {
      if (stopped || intervalId !== undefined) return
      intervalId = setInterval(() => void tick(), POLL_INTERVAL_MS)
    }

    // 継続 session を起動する。既に session 実行中なら冪等 (no-op)。
    // kick が二重 interval を作らない / 既存 session の grace を再 arm しない。
    // re-kick は意図的に無視: grace window は最初の kick 時にのみ設定し、
    // リセットしないことで 1 session が KICK_MAX_EMPTY_TICKS 以上 poll しないことを保証する。
    const startSession = (opts: { kick: boolean }) => {
      if (stopped) return
      if (sessionActive) {
        // 既存 session 実行中: 二重 interval も grace 再 arm もしない。
        // 元の grace window が drain するまで待つ (no-op)。
        return
      }
      sessionActive = true
      prevProcessing = new Set()
      sawProcessing = false
      kickGraceLeft = opts.kick ? KICK_MAX_EMPTY_TICKS : 0
      if (document.visibilityState !== 'hidden') {
        startInterval()
        void tick() // 起動直後に 1 回即実行する
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopInterval()
      } else if (sessionActive) {
        startInterval()
        void tick() // 可視復帰直後に 1 回即実行する
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    // OCR 開始 signal の購読: kick で session 起動 (既存なら冪等)。
    const unsubscribe = subscribeOcrPoll(() => {
      startSession({ kick: true })
    })

    // ── mount 時の起動分岐 ──
    const seedProcessing = processingIds(initialSnapshot)
    if (seedProcessing.size > 0) {
      // seed に processing → sawProcessing=true 相当で継続 session を起動。
      // 起動後最初の tick より前に prevProcessing を seed で初期化しておく。
      sessionActive = true
      prevProcessing = seedProcessing
      sawProcessing = true
      kickGraceLeft = 0
      if (document.visibilityState !== 'hidden') startInterval()
    } else if (Object.keys(initialSnapshot).length > 0) {
      // seed が failed のみ: 継続 session ではなく 1 回だけ reconcile poll。
      // (sawProcessing は立たないが session でないので grace も走らない。)
      void tick()
    }
    // seed 空 かつ signal 無し → 何もしない (kick が来るまで polling しない)。

    return () => {
      stopped = true
      stopInterval()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribe()
    }
    // userId 依存: polling session が抱える runGuardedPull の capture 値ゆえ、
    // userId が変わったら session を張り直す (旧 owner の cursor namespace に
    // 書き続けないため)。
  }, [initialSnapshot, router, userId])

  return (
    <ExamStatusContext.Provider value={statuses}>
      {children}
    </ExamStatusContext.Provider>
  )
}

export function ExamStatusBadge({ examId }: { examId: string }) {
  const statuses = useContext(ExamStatusContext)
  const status = statuses[examId]

  if (status === 'processing') {
    return (
      <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">
        処理中
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-600">
        失敗
      </span>
    )
  }
  return null
}
