import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { todayInJst } from '@/lib/jst'

/**
 * Given a set of YYYY-MM-DD dates (any order) and a today YYYY-MM-DD string,
 * compute the current "streak" — the number of consecutive days ending at today
 * OR at yesterday if today is missing (grace for "haven't reviewed yet today").
 *
 * Pure function; no DB, no clock. All date math is UTC-agnostic string math
 * because caller computes `today` in JST already.
 */
export function computeStreak(
  dates: readonly string[],
  today: string,
): number {
  if (dates.length === 0) return 0
  const set = new Set(dates)

  // Start cursor: today if present, else yesterday if present, else streak = 0.
  let cursor: string
  if (set.has(today)) {
    cursor = today
  } else {
    const y = addDays(today, -1)
    if (set.has(y)) cursor = y
    else return 0
  }

  // Walk backwards while consecutive days exist in the set.
  let count = 0
  while (set.has(cursor)) {
    count++
    cursor = addDays(cursor, -1)
  }
  return count
}

function addDays(ymd: string, delta: number): string {
  // Parse YYYY-MM-DD as a UTC midnight date and shift by delta days.
  // JST has no DST, so UTC arithmetic preserves "calendar day" correctly
  // for YYYY-MM-DD strings used as calendar keys.
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

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
  now?: Date,
): Promise<{ todayCardCount: number; streak: number }> {
  const db = getDb()
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
