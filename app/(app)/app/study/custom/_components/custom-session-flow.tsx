'use client'

// CustomSessionFlow — フィルタ → カード選定 → SessionLauncher の state machine (S2.3 T11)。
//
// 状態遷移:
//   'filter'     → フォーム表示 (CustomFilterForm)
//   'selecting'  → getCustomSessionCards 実行中 (Loading 表示)
//   'done'       → 選定完了 (SessionLauncher へ。 cards=0 件のときは empty UI を渡す)
//
// getCustomSessionCards の失敗は empty 扱いとし、 page crash させない。

import { useState } from 'react'
import Link from 'next/link'
import type { Card } from '@/lib/db/schema'
import type { CustomSessionCriteria } from '@/lib/cards/get-custom-session-cards'
import { getCustomSessionCards } from '@/lib/cards/get-custom-session-cards'
import { seedFromCriteria } from '@/lib/cards/seed-from-criteria'
import { SessionLauncher } from '../../_components/session-launcher'
import { CustomFilterForm } from './custom-filter-form'

type Props = {
  userId: string
  customLimit: number | null
  fsrsMode: boolean
}

type Phase =
  | { tag: 'filter' }
  | { tag: 'selecting' }
  | { tag: 'done'; cards: Card[] }

export function CustomSessionFlow({ userId, customLimit, fsrsMode }: Props) {
  const [phase, setPhase] = useState<Phase>({ tag: 'filter' })

  const handleStart = async (
    criteria: Omit<CustomSessionCriteria, 'userId' | 'limit'>,
  ) => {
    setPhase({ tag: 'selecting' })
    try {
      // seedFromCriteria を注入することでプレビューと同一 rng シードを使用:
      //   preview (useLiveQuery) と session (ここ) が同一の random 順になる
      const cards = await getCustomSessionCards(
        { ...criteria, userId, limit: customLimit },
        seedFromCriteria(criteria),
      )
      setPhase({ tag: 'done', cards })
    } catch {
      // 選定失敗は empty 扱い (page crash 防止)
      setPhase({ tag: 'done', cards: [] })
    }
  }

  const handleReturnToFilter = () => {
    setPhase({ tag: 'filter' })
  }

  if (phase.tag === 'selecting') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-slate-500">
        Loading…
      </div>
    )
  }

  if (phase.tag === 'done') {
    // 0 件のとき: 条件変更 CTA 付き empty UI を emptyState に渡す。
    // SessionLauncher が cards.length===0 のときに emptyState を render する。
    const emptyUI = (
      <div className="mx-auto max-w-xl space-y-6 px-4 py-12 text-center">
        <h1 className="text-2xl font-bold">カスタム演習</h1>
        <p className="text-slate-600">条件に一致するカードがありません。</p>
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={handleReturnToFilter}
            className="rounded-lg border border-foreground px-4 py-2 text-sm font-medium text-foreground hover:opacity-80"
          >
            条件を変更
          </button>
          <Link
            href="/app"
            prefetch={false}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ダッシュボードへ
          </Link>
        </div>
      </div>
    )

    return (
      <SessionLauncher
        cards={phase.cards}
        fsrsMode={fsrsMode}
        mode="custom"
        heading="カスタム演習"
        emptyState={emptyUI}
      />
    )
  }

  // phase.tag === 'filter'
  return (
    <CustomFilterForm
      userId={userId}
      customLimit={customLimit}
      onStart={(criteria) => {
        // handleStart は async だが onStart の型は sync。 void で発火する。
        void handleStart(criteria)
      }}
    />
  )
}
