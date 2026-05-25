'use client'

// StudySessionHost — server `page.tsx` と client `SessionRunner` の中間に立ち、
// 演習開始時に Dexie へ study_sessions 行を入れて session_id を採番する thin client
// wrapper (S-cache-1)。 SessionRunner mount 前に session 行を確定させたいので
// useEffect で write、 完了するまで Loading を出す。
//
// 設計上の注意:
// - mount 中に session を作る (`useEffect` ベース)。 React StrictMode 下では
//   useEffect が 2 回走るが、 `cancelled` フラグで 2 回目の Dexie write は捨てる。
// - mount 後の session_id 変化は React 規約上想定しない (cards 配列入替で再 mount
//   する設計、 次回 session は親で remount する想定)。

import { useEffect, useState } from 'react'
import type { Card } from '@/lib/db/schema'
import { createStudySession, newId } from '@/lib/sync/review-events'
import { SessionRunner } from './session-runner'

type StudySessionHostProps = {
  cards: Card[]
  fsrsMode: boolean
  // 全 exam 横断 smart session では exam_id を指定しない (null になる)。
  // custom mode (将来) では絞り込み対象の exam_id を渡す。
  examId?: string
  // 'smart' (due card 横断) / 'custom' (将来用フィルタ session)。
  mode?: 'smart' | 'custom'
}

export function StudySessionHost({
  cards,
  fsrsMode,
  examId,
  mode = 'smart',
}: StudySessionHostProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const id = newId()
      try {
        await createStudySession({
          session_id: id,
          ...(examId ? { exam_id: examId } : {}),
          mode,
          card_ids: cards.map((c) => c.id),
        })
      } catch {
        // Dexie write 失敗時も session を進める (in-memory only、 同期は次起動で
        // 諦める)。 sessionId を仮で発行して runner を走らせる。
      }
      if (!cancelled) setSessionId(id)
    })()
    return () => {
      cancelled = true
    }
    // mount 時のみ。 cards / examId / mode の変化で再生成しない (= 1 session = 1 mount)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (sessionId === null) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
        Loading…
      </div>
    )
  }
  return (
    <SessionRunner cards={cards} fsrsMode={fsrsMode} sessionId={sessionId} />
  )
}
