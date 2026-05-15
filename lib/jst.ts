export function todayInJst(now?: Date): string {
  const d = now ?? new Date()
  // JST is UTC+9, so add 9 hours to get the JST equivalent
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)

  const year = jst.getUTCFullYear()
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(jst.getUTCDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}
