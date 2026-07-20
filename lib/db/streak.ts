import { sql } from 'drizzle-orm'
import { todayInJst } from '@/lib/jst'
import { computeStreak, addDays } from '@/lib/streak-core'
import type { TenantDb } from './tenant-tx'

/**
 * Fetch today's unique card count and current streak for a user.
 * Both values are JST-anchored: "today" is the JST calendar day.
 *
 * Data source: `study_days` table (bulk route /api/review-events/bulk が rate flush 毎に集計 UPSERT)。
 * `study_days.day` は既に JST date 文字列で保存されているため、SQL 側での
 * AT TIME ZONE 変換は不要。 TS 側で `todayInJst(now)` を使って today を確定する。
 *
 * `todayCardCount` は study_days.distinct_card_count (その日 1 回でも rate された
 * unique card 数、bulk route が flush 毎に再集計して UPSERT)。
 *
 * Returns `{ todayCardCount, streak }` for dashboard display.
 *
 * `userId` は users.id (UUID) — raw SQL bind では明示的に `::uuid` cast を付け
 * operator does not exist (uuid = text) を回避する。
 *
 * `now` optional 引数: 省略時は `new Date()` (本番)、テストでは固定 Date を注入して
 * JST 境界を決定論的に検証できる。
 */
export async function getReviewStatsForUser(
  userId: string,
  dbc: TenantDb,
  now?: Date,
): Promise<{ todayCardCount: number; streak: number }> {
  const db = dbc
  const today = todayInJst(now)

  // Count distinct cards reviewed today (JST) via study_days.
  // study_days.day は JST date 文字列なので AT TIME ZONE 変換不要。
  const todayRow = await db.execute<{ c: number }>(sql`
    SELECT distinct_card_count AS c FROM study_days
    WHERE user_id = ${userId}::uuid AND day = ${today}
    LIMIT 1
  `)
  const todayCardCount = Number(todayRow[0]?.c ?? 0)

  // Streak 用: 直近 61 日 (today + 過去 60 日。 60 日 streak の境界安全マージン 1 日込み) で review_count > 0 の day を取得。
  // >= lowerBound は lowerBound 当日を含む (61 日 window)。MVP 上限 60 日 streak を確実に検出するための設計判断。
  // day は JST date 列なので文字列比較で下限を渡せる (AT TIME ZONE 不要)。
  const lowerBound = addDays(today, -60)
  const dateRows = await db.execute<{ d: string }>(sql`
    SELECT day::text AS d FROM study_days
    WHERE user_id = ${userId}::uuid
      AND day >= ${lowerBound}
      AND review_count > 0
    ORDER BY day DESC
  `)
  const dates = dateRows.map((r) => r.d)

  return { todayCardCount, streak: computeStreak(dates, today) }
}
