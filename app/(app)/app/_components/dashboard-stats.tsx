'use client'

// DashboardStats — dashboard の「今日の枚数 / 連続日数」 stats を mount 後に
// `/api/dashboard/stats` から fetch する client component (S-perf-2 T4)。
//
// 設計判断:
// - SWR / React Query は導入しない。 useEffect + AbortController の素朴実装。
// - 失敗時は dash 表示 (`--`) + inline error。 dashboard 全体を壊さない
//   (CTA / アップグレード link は機能維持)。
// - unmount 時は AbortController で fetch を中止し、 setState race を防ぐ。
//   React 18+ では setState on unmounted の warn は削除されたが、 同じ理由で
//   abort することで「unmount 後に走る setState」 そのものを発生させない。
// - skeleton は本体と同じ「2 列 grid + Card 風 div」 で寸法を揃え、 値表示時の
//   layout shift を防ぐ。

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'

type Stats = {
  todayCardCount: number
  streak: number
}

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; stats: Stats }
  | { phase: 'error'; message: string }

export function DashboardStats() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/dashboard/stats', {
          signal: controller.signal,
          // Cache-Control: no-store は server 側で付与済、 client では cache=no-store
          // を明示して proxy / SW 経路でも fresh を担保する。
          cache: 'no-store',
        })
        if (!res.ok) {
          setState({ phase: 'error', message: '取得に失敗しました' })
          return
        }
        const body = (await res.json()) as Stats
        setState({ phase: 'ok', stats: body })
      } catch (err) {
        // AbortError は unmount 由来の正常停止、 setState しない
        if (
          err instanceof Error &&
          (err.name === 'AbortError' || controller.signal.aborted)
        ) {
          return
        }
        setState({ phase: 'error', message: '取得に失敗しました' })
      }
    })()
    return () => {
      controller.abort()
    }
  }, [])

  if (state.phase === 'loading') {
    return (
      <div
        role="status"
        aria-label="読み込み中"
        className="grid grid-cols-2 gap-3 mb-6"
      >
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">今日の学習問題数</div>
            <div className="h-9 w-12 mt-1 rounded bg-slate-200 animate-pulse" />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">連続日数</div>
            <div className="h-9 w-16 mt-1 rounded bg-slate-200 animate-pulse" />
          </CardContent>
        </Card>
      </div>
    )
  }

  const today = state.phase === 'ok' ? String(state.stats.todayCardCount) : '--'
  const streak = state.phase === 'ok' ? state.stats.streak : null

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">今日の学習問題数</div>
            <div className="text-3xl font-bold">{today}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">連続日数</div>
            <div className="text-3xl font-bold">
              {streak !== null ? `${streak} 日` : '--'}
            </div>
          </CardContent>
        </Card>
      </div>
      {state.phase === 'error' && (
        <p
          role="alert"
          className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-700"
        >
          統計の{state.message}。 後ほど再読み込みしてください。
        </p>
      )}
    </div>
  )
}
