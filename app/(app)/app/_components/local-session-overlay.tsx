'use client'

// LocalSessionOverlay — `/app` 上で StudySessionHost を full-screen overlay 内に
// mount する presentational client component (S-local-5 UX refactor)。
//
// 設計意図:
// - 親 (DashboardActions) が overlay 表示の trigger / state を保持し、 本 component
//   は「表示している間の描画」 だけを担当する。 button trigger は持たない
//   (= 「保存済みカードで復習」 のような別 CTA は廃止し、 既存「スマート復習」 CTA
//   を local-first 化する OT 方針修正に合わせる)
// - URL を変えず (`router.push` / Link を使わない) Server reach を一切発生させない
// - cards は親 StudySessionHost が S-local-3 hybrid (Dexie 優先、 props.cards=[]
//   で server fallback も空のため Dexie 0 件なら empty UI) で扱う
// - 完了画面「ダッシュボードへ」 / 強制 close いずれも `onCloseAction` 経由で
//   overlay 閉鎖、 navigation を発生させない。 SessionRunner の onNavigateAction
//   に同じ callback を渡し、 flush await skip 動作 (UX refactor) を実現する
//
// 「オフライン」 文言は使わない (= 完全 offline 新規起動を保証していると誤解
// されるため、 OT 明示)。 `navigator.onLine` は使わない。

import { Button } from '@/components/ui/button'
import { StudySessionHost } from '../study/smart/_components/study-session-host'

type LocalSessionOverlayProps = {
  userId: string
  sessionLimit: number
  fsrsMode: boolean
  // 末尾 "Action" は Next.js client component fn prop 命名規約 (Server Action 非該当)。
  onCloseAction: () => void
}

export function LocalSessionOverlay({
  userId,
  sessionLimit,
  fsrsMode,
  onCloseAction,
}: LocalSessionOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white">
      <div className="flex justify-end p-3">
        <Button
          variant="outline"
          onClick={onCloseAction}
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
          onNavigateAction={onCloseAction}
          hideRetry={true}
        />
      </div>
    </div>
  )
}
