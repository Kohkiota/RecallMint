'use client'

// PullTrigger — `/app/*` 共通 layout mount 時に cards / exams / study_days の
// Dexie pull を fire-and-forget で kick off する client component (S-local-2
// Task 6 / Phase α、 cache-fix roadmap ④-1 で dashboard page → layout に移動)。
//
// 役割境界:
// - UI は持たない (`return null`)。 server SSR / AppHeader / 各 page の表示と
//   独立に、 background で local mirror を整える。
// - 失敗は silent (UI 警告 / console 出力なし)。 次トリガ (layout 再 mount 等、
//   = deep link / reload / BFCache 復元) で再試行される設計、 既存
//   review-events flush と同方針。
// - 二重 mount (React StrictMode dev 環境) で 2 回 pull が走っても、 server endpoint
//   は冪等、 Dexie は atomic replace で副作用なし。

import { useEffect } from 'react'
import { pullAllCards } from '@/lib/sync/cards'
import { pullAllExams } from '@/lib/sync/exams'
import { pullAllStudyDays } from '@/lib/sync/study-days'

export function PullTrigger(): null {
  useEffect(() => {
    void pullAllCards().catch(() => {
      // silent: 次トリガで再試行
    })
    void pullAllExams().catch(() => {
      // silent: 次トリガで再試行
    })
    // S-perf-3: dashboard streak / todayCount を Dexie 経由に切替するため、
    // study_days mirror を並走 pull する。 失敗は他 helper と同様 silent
    // (次の layout 再 mount で再試行)。
    void pullAllStudyDays().catch(() => {
      // silent: 次トリガで再試行
    })
  }, [])
  return null
}
