'use client'

// StudySessionHost — server `page.tsx` と client `SessionLauncher` の中間に立ち、
// 演習開始時の cards 決定 (Dexie mirror 優先 + server fallback、 S-local-3) を担う。
//
// S-local-3 hybrid 戦略:
// - mount 時に `getDueCardsFromDexie(userId, sessionLimit)` を試行
// - 戻り値 >= 1 件: Dexie 由来 cards を使う (= mirror 経由の local read 経路)
// - 戻り値 0 件 / throw: props.cards (server fetch fallback) を使う
// - cards 確定後は SessionLauncher に委譲 (sessionId 採番は launcher 側)
//
// S-local-4 (Phase γ) 拡張: Dexie 0 件 + props.cards (server) 0 件のとき empty UI
// を render する。 旧 page.tsx の「ありません」 page を host 内に集約し、 offline
// (server fetch fail で cards=[] が来る) と「全件解いた」 (server cards=[]) を
// 一元判断する。 これにより server fetch fail でも page render 失敗せず、 user は
// 「ありません」 + ダッシュボード戻り CTA を見られる。
//
// 設計上の注意:
// - StrictMode 下の useEffect 2 回実行は cancelled flag で 2 回目の Dexie write を捨てる
//   (SessionLauncher 内の cancelled flag とは独立して動作する)
// - server SSR は維持 (page.tsx は cards=[] 渡しで動作、 host が empty UI を出す)
// - silent fallback: Dexie 失敗時の console / UI 出力なし

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Card } from '@/lib/db/schema'
import { Button } from '@/components/ui/button'
import { getDueCardsFromDexie } from '@/lib/cards/get-dexie-session-cards'
import { SessionLauncher } from '../../_components/session-launcher'

type StudySessionHostProps = {
  cards: Card[]
  fsrsMode: boolean
  // S-local-3: Dexie cards mirror から due cards を引き直すために必要。
  userId: string
  sessionLimit: number | null
}

export function StudySessionHost({
  cards: serverCards,
  fsrsMode,
  userId,
  sessionLimit,
}: StudySessionHostProps) {
  const [resolvedCards, setResolvedCards] = useState<Card[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // cards 決定: Dexie 優先、 0 件 / throw 時は server props で fallback。
      let chosen: Card[] = serverCards
      try {
        const dexieCards = await getDueCardsFromDexie(userId, sessionLimit)
        if (dexieCards.length > 0) chosen = dexieCards
      } catch {
        // silent fallback
      }
      if (cancelled) return
      setResolvedCards(chosen)
    })()
    return () => {
      cancelled = true
    }
    // mount 時のみ。 props 変化で再選定しない (= 1 session = 1 mount、 既存挙動踏襲)。
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
  // empty UI は SessionLauncher に emptyState prop として渡す。
  const emptyUI = (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-12 text-center">
      <h1 className="text-2xl font-bold">スマート復習</h1>
      <p className="text-slate-600">
        現在復習する card はありません。
        <br />
        すべての card を学習済みです。お疲れ様でした！
      </p>
      <Button asChild variant="outline">
        <Link href="/app" prefetch={false}>ダッシュボードへ</Link>
      </Button>
    </div>
  )

  return (
    <SessionLauncher
      cards={resolvedCards}
      fsrsMode={fsrsMode}
      userId={userId}
      origin="smart"
      heading="スマート復習"
      emptyState={emptyUI}
    />
  )
}
