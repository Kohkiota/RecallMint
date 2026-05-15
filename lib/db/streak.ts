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
 * `todayCardCount` は その日 (JST 0 時起点) に 1 回でも rate された unique
 * card 数。 「もう一度」 連発で同 card を複数 rate しても 1 カウント
 * (Anki PC 互換、 COUNT(DISTINCT card_id) で集計)。
 *
 * Returns `{ todayCardCount, streak }` for dashboard display.
 *
 * `userId` は users.id (UUID) — raw SQL bind では明示的に `::uuid` cast を付け
 * operator does not exist (uuid = text) を回避する。
 */
export async function getReviewStatsForUser(
  userId: string,
): Promise<{ todayCardCount: number; streak: number }> {
  const db = getDb()
  const today = todayInJst()

  // Count distinct cards reviewed today (JST). 同 card 複数 rate でも 1 カウント。
  const todayRows = await db.execute<{ count: number }>(sql`
    SELECT COUNT(DISTINCT card_id)::int AS count
    FROM reviews
    WHERE user_id = ${userId}::uuid
      AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = ${today}::date
  `)
  const todayCardCount = Number(todayRows.rows[0]?.count ?? 0)

  // Distinct JST review dates from the last 60 days (enough to resolve any
  // realistic streak; MVP does not carry longer history for streak math).
  const dateRows = await db.execute<{ d: string }>(sql`
    SELECT DISTINCT (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text AS d
    FROM reviews
    WHERE user_id = ${userId}::uuid
      AND reviewed_at > now() - interval '60 days'
    ORDER BY d DESC
  `)
  const dates = dateRows.rows.map((r) => r.d)

  return { todayCardCount, streak: computeStreak(dates, today) }
}
