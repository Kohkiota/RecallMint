// client streak — Dexie study_days mirror から dashboard 用 stats を算出する
// pure + Dexie reader 集 (S-perf-3 / dashboard 高速化)。
//
// 役割境界:
// - computeStreak: 共有 pure module `lib/streak-core.ts` から import(server 版 streak も
//   同一 core を共有 = 数値の食い違いが出ない保証)。日付文字列 'YYYY-MM-DD' の set 操作だけで
//   完結し DB / Dexie / 時刻に依存しない。ロジック変更は `lib/streak-core.ts` 側で行う
//   (server / client 双方に反映される)。
// - getStreakStatsFromDexie: Dexie study_days を tenant 絞りで読み、 今日 JST 行の
//   distinct_card_count と過去 61 日 (review_count > 0) の day 集合 → computeStreak
//   で連続日数を算出。 server 版 getReviewStatsForUser (`lib/db/streak.ts:67-97`)
//   と同じ window / 同じ filter / 同じ return shape (`{ todayCardCount, streak }`)。

import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { todayInJst } from '@/lib/jst'
import { computeStreak, addDays } from '@/lib/streak-core'

// streak 用 window: server と同じ 61 日 (today + 過去 60 日)。 60 日 streak の境界
// 安全マージン 1 日込み。
const STREAK_WINDOW_DAYS = 61

export type StreakStats = {
  todayCardCount: number
  streak: number
}

export async function getStreakStatsFromDexie(
  userId: string,
  now?: Date,
): Promise<StreakStats> {
  const today = todayInJst(now)
  const lowerBound = addDays(today, -(STREAK_WINDOW_DAYS - 1))

  // tenant 分離: user_id 一致のみを取得 (他 user の行は混入させない)。
  // 90 日 mirror の中から 61 日 window と review_count > 0 を client 側で filter する
  // (Dexie の compound index で全 user 跨ぎを避けるため where('user_id') を起点)。
  const rows = await getClientDb()
    .study_days.where('user_id')
    .equals(userId)
    .toArray()

  let todayCardCount = 0
  const activeDates: string[] = []
  for (const r of rows as ClientStudyDay[]) {
    if (r.day === today) {
      todayCardCount = r.distinct_card_count
    }
    if (r.day >= lowerBound && r.review_count > 0) {
      activeDates.push(r.day)
    }
  }

  return { todayCardCount, streak: computeStreak(activeDates, today) }
}
