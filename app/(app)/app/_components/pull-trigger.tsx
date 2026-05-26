'use client'

// PullTrigger — dashboard (`/app`) mount 時に cards / exams の Dexie pull を
// fire-and-forget で kick off する client component (S-local-2 Task 6 / Phase α)。
//
// 役割境界:
// - UI は持たない (`return null`)。 server SSR / DashboardActions / DashboardStats
//   の表示と独立に、 background で local mirror を整える。
// - 失敗は silent (UI 警告 / console 出力なし)。 次トリガ (dashboard 再 mount 等) で
//   再試行される設計、 既存 review-events flush と同方針。
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
    // study_days mirror を並走 pull する。 失敗は他 helper と同様 silent。
    void pullAllStudyDays().catch(() => {
      // silent: 次トリガで再試行
    })
  }, [])
  return null
}
