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
//
// suppress フラグ:
// - isAmbientPullSuppressed() が true の間、 kick は何もせず return する。
// - suppress は ambient kick (mount/visibilitychange/online) のみを止める。
//   pullBack / 入口 kick が runGuardedPull を直接呼ぶ経路は flag を参照しないため
//   suppress の対象外 (bypass は構造的に自明: flag は PullTrigger の kick 内でのみ読む)。
// - suppress 中の ambient kick は queue しない。離脱後の次トリガで自然回復する。

import { useEffect } from 'react'
import { runGuardedPull } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'
import { isAmbientPullSuppressed } from '@/lib/sync/ambient-pull-suppress'

export function PullTrigger({ userId }: { userId: string }): null {
  useEffect(() => {
    const kick = (reason: string) => {
      // ambient kick を suppress フラグで抑止。
      // suppress 中は queue せず silent に skip する (離脱後の次トリガで自然回復)。
      // 詳細滞在中は毎 visibilitychange/online でここを通るため、ログは出さない
      // (本 component の silent 契約 + ログ spam 回避)。
      if (isAmbientPullSuppressed()) return

      void runGuardedPull({ userId, reason }).catch(() => {
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
    // userId 依存: layout が remount しない内部 navigation でも userId が変われば
    // effect を張り直し、新 owner で再 kick する。 deps [] のままだと listener が
    // 旧 userId を closure に抱えたまま残り、次 user の pull を前 user の cursor
    // namespace に書いてしまう (spec §5.1 capture 原則の入口側)。
  }, [userId])
  return null
}
