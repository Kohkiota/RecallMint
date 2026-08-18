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

// streak 用 window: today + 過去 60 日 = 61 日。60 日 streak の境界安全マージン 1 日込み。
//
// この file(streak-core.ts)に置く理由(Dash-1 Home v1 Task 2・fix round 1/5 I-3):
// 元々 `lib/client/streak.ts` の private const だったが、そこは `@/lib/client-db`
// (Dexie)を import する module であり、`lib/dashboard/domain/**`(server からも
// import される pure layer)からこの定数だけを参照しようとすると Dexie 依存が
// 伝播してしまう。この file は import ゼロで既に server(`lib/db/streak.ts`)/
// client(`lib/client/streak.ts`)双方が `computeStreak` を import する唯一の SSoT
// (定義 doc §4-O/§7.1)なので、streak window の定数もここに置けば同じ性質(pure・
// 両側 import 可)を保てる。`lib/client/streak.ts` はここから import する
// (内部の `lowerBound` 計算で実使用)。
export const STREAK_WINDOW_DAYS = 61

/**
 * streak 表示用の文言(定義 doc §4-O・pin 12)。`STREAK_WINDOW_DAYS`(61)は client mirror
 * の window 上限であり、実際に 62 日以上連続していても `computeStreak` は 61 で頭打ちに
 * なる。61 に達した値を「61 日」と断定表示すると誤りになるため「61 日以上」に言い換える。
 * pure 関数(数値 → 文言の写像のみ)。ここに置く理由は `STREAK_WINDOW_DAYS` と同じ —
 * Dexie-import module に紐付けると、server 側の将来消費者が気付かず Dexie を
 * server graph に引き込むサイレントな罠になる(`getClientDb()` は遅延初期化のため
 * import 時点では lint/build/typecheck が全て green のまま通ってしまう)。
 */
export function formatStreakDisplay(streak: number): string {
  return streak >= STREAK_WINDOW_DAYS
    ? `${STREAK_WINDOW_DAYS} 日以上`
    : `${streak} 日`
}
