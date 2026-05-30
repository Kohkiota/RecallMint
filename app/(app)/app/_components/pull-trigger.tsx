'use client'

// PullTrigger — `/app/*` 共通 layout で mount / visibilitychange / online の
// 各トリガーに Dexie pull を fire-and-forget で kick off する client component
// (S-local-2 Task 6 / Phase α、 cache-fix roadmap ④-1 で dashboard page → layout
// に移動。 増分 pull step4 で focus 復帰・再接続トリガー追加)。
//
// 役割境界:
// - UI は持たない (`return null`)。 server SSR / AppHeader / 各 page の表示と
//   独立に、 background で local mirror を整える。
// - 失敗は silent (UI 警告 / console 出力なし)。 guard (in-flight skip / lock-busy)
//   は正常系として扱い、 次トリガで自動リトライされる設計。
// - unmount 時は visibilitychange / online の listener を解除する。
//
// トリガー:
// - mount: 初回 pull。 React StrictMode dev 環境で 2 回 mount されても guard が
//   in-flight skip するため副作用なし。
// - visibilitychange (→ visible のみ): タブ復帰時に mirror を最新化。
// - online: ネットワーク復帰時に mirror を最新化。
//
// 経路:
// - cards/exams は runGuardedPull (in-flight + Web Locks guard 付き pullDelta)
// - study_days は旧 study-days/pull 経路で並走 (別 helper・別 tx、
//   unguarded / idempotent full-replace / cursor race なし)

import { useEffect } from 'react'
import { runGuardedPull } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'

export function PullTrigger(): null {
  useEffect(() => {
    const kick = (reason: string) => {
      void runGuardedPull({ reason }).catch(() => {
        // silent: guard outcome (inflight-skip / lock-busy) は正常系、
        // network error は次トリガで再試行
      })
      // study_days は増分化せず旧 endpoint で並走 (別 helper・別 tx)
      void pullAllStudyDays().catch(() => {
        // silent: 次トリガで再試行
      })
    }

    kick('mount')

    const onVis = () => {
      // hidden → visible の遷移のみ pull を kick (hidden では不要)
      if (document.visibilityState === 'visible') kick('visibilitychange')
    }
    const onOnline = () => kick('online')

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)

    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
  }, [])
  return null
}
