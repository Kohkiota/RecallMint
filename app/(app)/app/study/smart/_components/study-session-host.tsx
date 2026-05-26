'use client'

// StudySessionHost — server `page.tsx` と client `SessionRunner` の中間に立ち、
// 演習開始時の (1) cards 決定 (Dexie mirror 優先 + server fallback、 S-local-3)
// と (2) Dexie study_sessions への session_id 採番 (S-cache-1) を担う thin wrapper。
//
// S-local-3 hybrid 戦略:
// - mount 時に `getDueCardsFromDexie(userId, sessionLimit)` を試行
// - 戻り値 >= 1 件: Dexie 由来 cards を使う (= mirror 経由の local read 経路)
// - 戻り値 0 件 / throw: props.cards (server fetch fallback) を使う
// - cards 確定後に createStudySession を呼んで session_id 採番、 SessionRunner mount
//
// 設計上の注意:
// - StrictMode 下の useEffect 2 回実行は cancelled flag で 2 回目の Dexie write を捨てる
// - server SSR は維持 (page.tsx は無変更で動作)、 Dexie 由来は client 上書きという形
// - silent fallback: Dexie 失敗時の console / UI 出力なし

import { useEffect, useState } from 'react'
import type { Card } from '@/lib/db/schema'
import { createStudySession, newId } from '@/lib/sync/review-events'
import { getDueCardsFromDexie } from '@/lib/cards/get-dexie-session-cards'
import { SessionRunner } from './session-runner'

type StudySessionHostProps = {
  cards: Card[]
  fsrsMode: boolean
  // S-local-3: Dexie cards mirror から due cards を引き直すために必要。
  userId: string
  sessionLimit: number
  // 全 exam 横断 smart session では exam_id を指定しない (null になる)。
  // custom mode (将来) では絞り込み対象の exam_id を渡す。
  examId?: string
  // 'smart' (due card 横断) / 'custom' (将来用フィルタ session)。
  mode?: 'smart' | 'custom'
}

export function StudySessionHost({
  cards: serverCards,
  fsrsMode,
  userId,
  sessionLimit,
  examId,
  mode = 'smart',
}: StudySessionHostProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [resolvedCards, setResolvedCards] = useState<Card[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // (1) cards 決定: Dexie 優先、 0 件 / throw 時は server props で fallback
      let chosen: Card[] = serverCards
      try {
        const dexieCards = await getDueCardsFromDexie(userId, sessionLimit)
        if (dexieCards.length > 0) chosen = dexieCards
      } catch {
        // silent fallback
      }
      if (cancelled) return

      // (2) Dexie に study_sessions 行を入れて session_id を採番。 失敗時は in-memory
      //     only で進める (S-cache-1 既存設計を踏襲)。
      const id = newId()
      try {
        await createStudySession({
          session_id: id,
          ...(examId ? { exam_id: examId } : {}),
          mode,
          card_ids: chosen.map((c) => c.id),
        })
      } catch {
        // silent
      }
      if (cancelled) return
      setResolvedCards(chosen)
      setSessionId(id)
    })()
    return () => {
      cancelled = true
    }
    // mount 時のみ。 props 変化で再生成しない (= 1 session = 1 mount、 既存挙動踏襲)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (sessionId === null || resolvedCards === null) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
        Loading…
      </div>
    )
  }
  return (
    <SessionRunner
      cards={resolvedCards}
      fsrsMode={fsrsMode}
      sessionId={sessionId}
    />
  )
}
