'use client'

// DashboardStats — dashboard の「今日の枚数 / 連続日数」 stats を Dexie study_days
// mirror から useLiveQuery で算出する client component (S-perf-3 / dashboard 高速化)。
//
// 設計判断:
// - 旧 `/api/dashboard/stats` fetch は廃止 (server 側 2 SELECT による 2 秒台の待ち
//   を撤去)。 route 自体は fallback 用に据置 (`app/api/dashboard/stats/route.ts`)。
// - useLiveQuery で Dexie 変更を購読、 スマート復習で push された study_days 変化が
//   そのまま反映 (= polling 不要、 PullTrigger 完了通知の側 channel も不要)。
// - undefined 中は skeleton (layout shift 防止)。 確定後は値表示。
// - server / client で streak / todayCount の数値が食い違わないよう、 server
//   `lib/db/streak.ts` と同仕様の computeStreak を `lib/client/streak.ts` に port
//   して共通利用 (実体は別ファイルだが contract が同じ)。

import { useLiveQuery } from 'dexie-react-hooks'
import { Card, CardContent } from '@/components/ui/card'
import { getStreakStatsFromDexie } from '@/lib/client/streak'

export function DashboardStats({
  userId,
  now,
}: {
  userId: string
  // test 注入用。 production では undefined → useLiveQuery 内部で都度 new Date()。
  now?: Date
}) {
  const stats = useLiveQuery(
    async () => getStreakStatsFromDexie(userId, now),
    // userId のみ依存。 now は mount 時固定で十分 (dashboard が長時間開きっぱなしで
    // 日付境界を跨ぐ稀ケースは streak が古い today で残るが、 user が画面再訪する
    // 動線で自然に更新されるため許容)。
    [userId],
  )

  if (stats === undefined) {
    return (
      <div
        role="status"
        aria-label="読み込み中"
        className="grid grid-cols-2 gap-3 mb-6"
      >
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">今日の学習問題数</div>
            <div className="h-9 w-12 mt-1 rounded bg-slate-200 animate-pulse" />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">連続日数</div>
            <div className="h-9 w-16 mt-1 rounded bg-slate-200 animate-pulse" />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">今日の学習問題数</div>
            <div className="text-3xl font-bold">{stats.todayCardCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-sm text-slate-600">連続日数</div>
            <div className="text-3xl font-bold">{stats.streak} 日</div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
