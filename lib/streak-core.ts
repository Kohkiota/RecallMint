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

export function addDays(ymd: string, delta: number): string {
  // Parse YYYY-MM-DD as a UTC midnight date and shift by delta days.
  // JST has no DST, so UTC arithmetic preserves "calendar day" correctly
  // for YYYY-MM-DD strings used as calendar keys.
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}
