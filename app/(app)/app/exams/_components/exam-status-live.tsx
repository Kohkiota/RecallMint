'use client'

// exam-status-live — 試験一覧の OCR ステータスを polling で live 更新する client 層。
//
// ExamStatusProvider:
//   - 初回 render (server) の statusMap を初期値に挙動を分岐する:
//     * processing 行あり → /api/exams/status を 5 秒間隔で polling し、
//       processing → completed/failed 遷移時に router.refresh() を 1 回呼ぶ。
//       processing 行がゼロになったら polling を恒久停止する。
//       タブが hidden の間は polling を停止し、可視復帰で再開する。
//     * processing なし・failed バッジのみ → mount 時に 1 回だけ poll する。
//       deriveExamStatuses が >15 分 processing 残骸を failed 表示に化けさせて
//       いる可能性があり、その 1 回で /api/exams/status 経由の reconcile
//       (DB cleanup) を起動する。継続 polling は開始しない。
//     * バッジ無し (空) → polling を一切行わない。
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

const POLL_INTERVAL_MS = 5000
const STATUS_ENDPOINT = '/api/exams/status'

const ExamStatusContext = createContext<ExamStatusMap>({})

export function ExamStatusProvider({
  initialStatuses,
  children,
}: {
  initialStatuses: ExamStatusMap
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
    // 処理中バッジも失敗バッジも無ければ polling は一切不要。
    if (Object.keys(initialSnapshot).length === 0) return

    let stopped = false // processing ゼロ到達 / unmount で恒久停止
    let inFlight = false // 同時 tick の二重起動を防ぐ
    let intervalId: ReturnType<typeof setInterval> | undefined
    // 直前 poll (初回は server render) で processing だった examId 集合。
    let prevProcessing = processingIds(initialSnapshot)

    const stopInterval = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId)
        intervalId = undefined
      }
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
        // processing → completed/failed 遷移時のみ、card 件数同期のため refresh。
        if (hasCompletion(prevProcessing, nextProcessing)) {
          router.refresh()
        }
        prevProcessing = nextProcessing

        // processing が尽きたら polling を恒久停止する。
        if (nextProcessing.size === 0) {
          stopped = true
          stopInterval()
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

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopInterval()
      } else {
        startInterval()
        void tick() // 可視復帰直後に 1 回即実行する
      }
    }

    if (prevProcessing.size > 0) {
      // 処理中行あり: 5 秒間隔の interval polling (可視時のみ) を開始する。
      document.addEventListener('visibilitychange', onVisibilityChange)
      if (document.visibilityState !== 'hidden') startInterval()
    } else {
      // failed バッジのみ: >15 分 processing 残骸が failed 表示へ化けている
      // 可能性があるため、mount 時 1 回だけ poll して reconcile を起動する。
      void tick()
    }

    return () => {
      stopped = true
      stopInterval()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [initialSnapshot, router])

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
