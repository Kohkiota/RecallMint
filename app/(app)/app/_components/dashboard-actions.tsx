'use client'

// DashboardActions — dashboard 上のメイン CTA (スマート復習 / カスタム演習)。
// S-local-5 UX refactor: 「スマート復習（N件）」 を Link (/app/study/smart route)
// から button + overlay state に切替、 click で `<LocalSessionOverlay>` を mount
// する local-first 経路に統合した。 server route (/app/study/smart) は header nav
// や direct URL navigation からのまま fallback / deep link 用に残存。

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { LocalSessionOverlay } from './local-session-overlay'

type DashboardActionsProps = {
  dueCount: number
  // S-local-5 UX refactor: overlay 起動に必要、 page.tsx (server) で取得して渡す
  userId: string
  sessionLimit: number
  fsrsMode: boolean
}

export function DashboardActions({
  dueCount,
  userId,
  sessionLimit,
  fsrsMode,
}: DashboardActionsProps) {
  const [isOverlayActive, setIsOverlayActive] = useState(false)

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {dueCount > 0 ? (
          <Button
            onClick={() => setIsOverlayActive(true)}
            size="lg"
            className="w-full py-4 text-lg font-bold rounded-xl"
          >
            スマート復習（{dueCount}件）
          </Button>
        ) : (
          <div className="block w-full py-4 bg-slate-200 text-slate-500 rounded-xl text-center font-bold text-lg">
            復習完了！
          </div>
        )}
        {/* T6 (S2.1): 右 button は /app/quiz 撤去に伴い disabled に。
            href は S2.3 カスタム演習実装後に復活。 */}
        <Button
          size="lg"
          className="w-full py-4 text-lg font-bold rounded-xl"
          disabled
        >
          カスタム演習（準備中）
        </Button>
      </div>
      {isOverlayActive && (
        <LocalSessionOverlay
          userId={userId}
          sessionLimit={sessionLimit}
          fsrsMode={fsrsMode}
          onCloseAction={() => setIsOverlayActive(false)}
        />
      )}
    </>
  )
}
