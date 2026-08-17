'use client'

// sign-in 時の異 owner 残骸 sweep の発火点(tag mirror hygiene sprint Task 5 /
// spec §5.2)。 media-sweep-trigger.tsx と同じ「mount 1 回 fire-and-forget、 UI なし、
// 失敗 silent」の precedent に倣う(retry / visibilitychange 等の再 kick はしない —
// 起動時 1 回の回収のみが要件で、 取りこぼしは次回起動 / sign-out purge が回収する)。

import { useEffect } from 'react'
import { sweepForeignLocalData } from '@/lib/sync/local-hygiene'

// userId (= 現 session の users.id) は RSC の layout が getCurrentUser() から渡す。
// sweep はこの owner を基準に「異 owner の残骸」を判定するため、 共有ブラウザで
// アカウントが切り替わったとき (userId 変化) に再 kick する必要がある。
export function HygieneSweepTrigger({ userId }: { userId: string }) {
  useEffect(() => {
    void sweepForeignLocalData(userId).catch(() => {})
    // mount 1 回のみ (userId 変化時のみ再 kick)。
  }, [userId])

  return null
}
