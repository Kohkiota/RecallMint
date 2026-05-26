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
// S-local-4 (Phase γ) 拡張: Dexie 0 件 + props.cards (server) 0 件のとき empty UI
// を render する。 旧 page.tsx の「ありません」 page を host 内に集約し、 offline
// (server fetch fail で cards=[] が来る) と「全件解いた」 (server cards=[]) を
// 一元判断する。 これにより server fetch fail でも page render 失敗せず、 user は
// 「ありません」 + ダッシュボード戻り CTA を見られる。
//
// 設計上の注意:
// - StrictMode 下の useEffect 2 回実行は cancelled flag で 2 回目の Dexie write を捨てる
// - server SSR は維持 (page.tsx は cards=[] 渡しで動作、 host が empty UI を出す)
// - silent fallback: Dexie 失敗時の console / UI 出力なし

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Card } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
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
  // S-local-5: SessionRunner に pass-through する optional props。
  // 完了画面ナビゲーション override (= overlay close 用) + 「もう一度」 hide。
  // 末尾 "Action" は Next.js client component fn prop 命名規約 (Server Action 非該当)。
  onNavigateAction?: () => void
  hideRetry?: boolean
}

export function StudySessionHost({
  cards: serverCards,
  fsrsMode,
  userId,
  sessionLimit,
  examId,
  mode = 'smart',
  onNavigateAction,
  hideRetry,
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

      // (2) chosen が空 (= Dexie + server 両方 0 件) なら空 session を作らない。
      //     resolvedCards=[] で render branch を empty UI に倒す。
      if (chosen.length === 0) {
        setResolvedCards([])
        return
      }

      // (3) Dexie に study_sessions 行を入れて session_id を採番。 失敗時は in-memory
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

  if (resolvedCards === null) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
        Loading…
      </div>
    )
  }
  // S-local-4: Dexie + server 両方 0 件のとき empty UI。 旧 page.tsx の文言を維持。
  // S-local-5 review fix: overlay モード (onNavigateAction provided) では Link 経由
  // で /app に RSC navigate すると本 sprint の architectural premise (= server
  // reach 不要で overlay close) に反する + offline で stuck。 callback 経由の
  // button に切替えて navigation を発生させない。
  if (resolvedCards.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-6 px-4 py-12 text-center">
        <h1 className="text-2xl font-bold">スマート復習</h1>
        <p className="text-slate-600">
          現在復習する card はありません。
          <br />
          すべての card を学習済みです。お疲れ様でした！
        </p>
        {onNavigateAction ? (
          <Button variant="outline" onClick={onNavigateAction}>
            ダッシュボードへ
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/app">ダッシュボードへ</Link>
          </Button>
        )}
      </div>
    )
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
      cards={resolvedCards}
      fsrsMode={fsrsMode}
      sessionId={sessionId}
      onNavigateAction={onNavigateAction}
      hideRetry={hideRetry}
    />
  )
}
