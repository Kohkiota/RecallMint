'use client'

// media 起動時 self-heal sweep trigger (画像フェーズ A Task 9 / spec §3.4・§6)。
// entity-mutation-flush-trigger.tsx と同じ「mount 1 回 fire-and-forget、 UI なし、
// 失敗 silent」の precedent に倣う。 sweepStaleMedia() 自体が Web Lock で多重タブ
// 排他するため、 本 component は kick するだけで良い (retry / visibilitychange
// 等の再 kick は不要 — 起動時 1 回の self-heal のみが要件)。

import { useEffect } from 'react'
import { sweepStaleMedia } from '@/lib/media/sweep'

// userId (= 現 session の users.id) は RSC の layout が getCurrentUser() から渡す。
// sweep はこの owner で scope し、 共有ブラウザに残る前 user の row を触らない。
export function MediaSweepTrigger({ userId }: { userId: string }) {
  useEffect(() => {
    void sweepStaleMedia(userId).catch(() => {})
    // mount 1 回のみ (userId 変化時のみ再 kick)。
  }, [userId])

  return null
}
