// exam list — client-safe parts (types + pure format helper)。
//
// 役割境界:
// - `lib/exams/list.ts` は `getDb` を import するため server 限定 (`import 'server-only'`
//   付き)。 client component (例: upload-form.tsx) が「経過時間 format」 や
//   `ActiveExam` 型だけを必要とする場合は本ファイルから import する。
// - 本ファイル自身は DB / 認証 / drizzle に依存しない pure module で、
//   server / client 両側から自由に import できる。

export type ActiveExam = {
  id: string
  name: string
  updatedAt: Date
}

// 経過時間を「N 分前 / N 時間前 / N 日前 / N ヶ月前 / N 年前」 形式で返す。
// date-fns 等の dep 増を避け自前 format (UI 表示用、 厳密性不要)。
export function formatRelativeJa(from: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - from.getTime()
  if (diffMs < 0) return 'たった今' // 未来日時 (clock skew 等) も安全に
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'たった今'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 時間前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 30) return `${diffDay} 日前`
  const diffMonth = Math.floor(diffDay / 30)
  if (diffMonth < 12) return `${diffMonth} ヶ月前`
  const diffYear = Math.floor(diffMonth / 12)
  return `${diffYear} 年前`
}
