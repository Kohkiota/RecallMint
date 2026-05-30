'use client'

// PullTrigger — `/app/*` 共通 layout mount 時に Dexie pull を fire-and-forget で
// kick off する client component (S-local-2 Task 6 / Phase α、 cache-fix roadmap
// ④-1 で dashboard page → layout に移動)。
//
// 役割境界:
// - UI は持たない (`return null`)。 server SSR / AppHeader / 各 page の表示と
//   独立に、 background で local mirror を整える。
// - 失敗は silent (UI 警告 / console 出力なし)。 次トリガ (layout 再 mount 等、
//   = deep link / reload / BFCache 復元) で再試行される設計、 既存
//   review-events flush と同方針。
// - 二重 mount (React StrictMode dev 環境) で 2 回 pull が走っても、 server endpoint
//   は冪等、 Dexie は atomic replace で副作用なし。
//
// 経路:
// - cards/exams は統合 /api/pull の増分 merge (pullDelta)
// - study_days は旧 study-days/pull 経路で並走 (別 helper・別 tx)

import { useEffect } from 'react'
import { pullDelta } from '@/lib/sync/pull'
import { pullAllStudyDays } from '@/lib/sync/study-days'

export function PullTrigger(): null {
  useEffect(() => {
    void pullDelta().catch(() => {
      // silent: 次トリガで再試行
    })
    // study_days は増分化せず旧 endpoint で並走 (別 helper・別 tx)
    void pullAllStudyDays().catch(() => {
      // silent: 次トリガで再試行
    })
  }, [])
  return null
}
