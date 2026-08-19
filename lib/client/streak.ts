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
//   で連続日数を算出。 かつて対になっていた server 版 getReviewStatsForUser
//   (`lib/db/streak.ts`) は Dash-1 T12 で唯一の caller (`/api/dashboard/stats`) ごと
//   削除済み — 現在 streak の算出経路は本 file の 1 本のみ。

import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { todayInJst } from '@/lib/jst'
import {
  addDays,
  computeStreak,
  formatStreakDisplay,
  STREAK_WINDOW_DAYS,
} from '@/lib/streak-core'

// STREAK_WINDOW_DAYS / formatStreakDisplay: fix round 1/5 I-3(controller 裁定)で
// `lib/streak-core.ts` へ移設した(元はこの file の private const + 追加関数だった)。
// この file は Dexie(`@/lib/client-db`)に依存するため、`lib/dashboard/domain/`
// (server からも import される pure layer)がこの定数だけを参照しようとすると Dexie
// 依存が伝播する罠になる — streak-core.ts は import ゼロで server/client 双方の
// streak SSoT(定義 doc §4-O/§7.1)なので、そちらに置けば同じ性質を保ったまま両側から
// 参照できる。ここでは `lowerBound` 計算(下記)向けに import し、`formatStreakDisplay`
// は client 側の既存 import 経路(`./streak`)を壊さないよう re-export する。
export { formatStreakDisplay, STREAK_WINDOW_DAYS }

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
