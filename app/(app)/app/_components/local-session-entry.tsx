'use client'

// LocalSessionEntry — dashboard 上に「保存済みカードで復習」 button を置き、
// click で Server Component route (/app/study/smart) を経由せずに
// `<StudySessionHost>` を full-screen overlay で mount する client component。
// S-local-5 (mounted-page client-only session entry)。
//
// 設計意図:
// - URL を変えない (`router.push` / Link を使わない) ことで Server reach を一切
//   発生させない。 navigator.onLine が誤って online 判定する場合でも、 そもそも
//   server を一切呼ばないため offline でも問題なく動作する
// - cards は親 StudySessionHost が S-local-3 hybrid (Dexie 優先、 props.cards
//   = [] で server fallback も空のため Dexie 0 件なら empty UI) で扱う
// - 完了画面「ダッシュボードへ」 / 強制 close いずれも overlay close に倒し、
//   navigation を発生させない (router.push / RSC fetch 不要)
//
// 注意:
// - 「オフライン」 という文言は使わない (完全 offline 新規起動を保証していると
//   誤解されるため、 OT 明示)
// - navigator.onLine による条件表示はしない (online でも触れる UX、 false
//   positive 回避、 smoke しやすい)

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { StudySessionHost } from '../study/smart/_components/study-session-host'

type LocalSessionEntryProps = {
  userId: string
  sessionLimit: number
  fsrsMode: boolean
}

export function LocalSessionEntry({
  userId,
  sessionLimit,
  fsrsMode,
}: LocalSessionEntryProps) {
  const [isActive, setIsActive] = useState(false)

  if (!isActive) {
    return (
      <div className="mt-3">
        <Button
          variant="outline"
          onClick={() => setIsActive(true)}
          className="w-full"
        >
          保存済みカードで復習
        </Button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white">
      <div className="flex justify-end p-3">
        <Button
          variant="outline"
          onClick={() => setIsActive(false)}
          className="text-sm"
        >
          閉じる
        </Button>
      </div>
      <div className="max-w-4xl mx-auto px-4 pb-8">
        <StudySessionHost
          cards={[]}
          fsrsMode={fsrsMode}
          userId={userId}
          sessionLimit={sessionLimit}
          mode="smart"
          onNavigateAction={() => setIsActive(false)}
          hideRetry={true}
        />
      </div>
    </div>
  )
}
