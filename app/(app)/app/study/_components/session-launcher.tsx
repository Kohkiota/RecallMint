'use client'

// SessionLauncher — 解決済み cards を受け取り、session_id を採番して SessionRunner を
// 起動する共有 wrapper。
//
// 責務分離 (Q-6 決定):
// - card 選定 (Dexie mirror 優先 / server fallback) は StudySessionHost 側が担う。
// - 本 component は「選定済み cards を受けて起動するだけ」に徹する。
// - これにより custom mode など他の選定ロジックからも再利用できる。
//
// session_id は answer_events の label にすぎず、Dexie にも server にも session 行は
// 作らない (study_sessions 廃止・spec §4.4)。採番は 1 mount = 1 session。
//
// cards.length === 0 のとき:
// - session を使わず emptyState をそのまま render する。

import { useState } from 'react'
import type { Card } from '@/lib/db/schema'
import { newId } from '@/lib/sync/review-events'
import { SessionRunner } from '../smart/_components/session-runner'

type SessionLauncherProps = {
  cards: Card[]
  fsrsMode: boolean
  // flush の owner-scope 用 (RSC の認証済み値が props chain で降りてくる・spec §4.6)。
  userId: string
  // セッション開始入口の分析ラベル (Dash-1 Home v1 spec §11.1/§11.4)。呼出側 (host) が
  // 自分の入口に応じた固定値を渡し、そのまま SessionRunner へ透過する。
  origin: string
  heading: string
  emptyState: React.ReactNode
}

export function SessionLauncher({
  cards,
  fsrsMode,
  userId,
  origin,
  heading,
  emptyState,
}: SessionLauncherProps) {
  // lazy initializer で mount 1 回だけ採番する (props 変化で再生成しない = 1 session = 1 mount)。
  const [sessionId] = useState(() => newId())

  if (cards.length === 0) {
    return <>{emptyState}</>
  }

  return (
    <SessionRunner
      cards={cards}
      fsrsMode={fsrsMode}
      userId={userId}
      sessionId={sessionId}
      origin={origin}
      heading={heading}
    />
  )
}
