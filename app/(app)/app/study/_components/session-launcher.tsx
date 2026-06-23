'use client'

// SessionLauncher — 解決済み cards を受け取り、Dexie に study_sessions 行を採番して
// SessionRunner を起動する共有 wrapper。
//
// 責務分離 (Q-6 決定):
// - card 選定 (Dexie mirror 優先 / server fallback) は StudySessionHost 側が担う。
// - 本 component は「選定済み cards を受けて起動するだけ」に徹する。
// - これにより custom mode など他の選定ロジックからも再利用できる。
//
// StrictMode 安全性:
// - React StrictMode は開発環境で useEffect を 2 回実行する。
// - cancelled flag で 2 回目の createStudySession 呼び出しを捨てる (既存 host 踏襲)。
//
// silent failure 踏襲:
// - createStudySession の失敗は in-memory のみで進める (S-cache-1 既存設計)。
// - console / UI 出力なし。
//
// cards.length === 0 のとき:
// - session を作らず emptyState をそのまま render する。

import { useEffect, useState } from 'react'
import type { Card } from '@/lib/db/schema'
import { createStudySession, newId } from '@/lib/sync/review-events'
import { SessionRunner } from '../smart/_components/session-runner'

type SessionLauncherProps = {
  cards: Card[]
  fsrsMode: boolean
  mode: 'smart' | 'custom'
  examId?: string
  heading: string
  emptyState: React.ReactNode
}

export function SessionLauncher({
  cards,
  fsrsMode,
  mode,
  examId,
  heading,
  emptyState,
}: SessionLauncherProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)

  useEffect(() => {
    // cards が 0 件のときは session を作らない (emptyState render に倒す)。
    if (cards.length === 0) return

    let cancelled = false
    void (async () => {
      // Dexie に study_sessions 行を入れて session_id を採番。 失敗時は in-memory
      // only で進める (S-cache-1 既存設計を踏襲)。
      const id = newId()
      try {
        await createStudySession({
          session_id: id,
          ...(examId ? { exam_id: examId } : {}),
          mode,
          card_ids: cards.map((c) => c.id),
        })
      } catch {
        // silent
      }
      if (cancelled) return
      setSessionId(id)
    })()
    return () => {
      cancelled = true
    }
    // mount 時のみ。 props 変化で再生成しない (= 1 session = 1 mount)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (cards.length === 0) {
    return <>{emptyState}</>
  }

  if (sessionId === null) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
        Loading…
      </div>
    )
  }

  return (
    <SessionRunner
      cards={cards}
      fsrsMode={fsrsMode}
      sessionId={sessionId}
      heading={heading}
    />
  )
}
