export function todayInJst(now?: Date): string {
  const d = now ?? new Date()
  // JST is UTC+9, so add 9 hours to get the JST equivalent
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)

  const year = jst.getUTCFullYear()
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(jst.getUTCDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

// [JST 0:00, 翌 0:00) を UTC instant で返す。JST は UTC+9 固定 (DST なし) のため
// 明示 offset 付き ISO 文字列を Date でパースするだけで往復整合が todayInJst と取れる。
export function jstDayRange(day: string): { startAt: Date; endAt: Date } {
  const startAt = new Date(`${day}T00:00:00+09:00`)
  const endAt = new Date(startAt.getTime() + 24 * 3600 * 1000)
  return { startAt, endAt }
}
