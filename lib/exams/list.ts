// exam list helpers — server-side query + client-friendly relative time format。
//
// MVP では archived_at IS NULL の exam 一覧を updated_at DESC で取る。
// archived UX 詳細 (一覧で archived を表示するか / 復元 button 等) は S2 で確定。

import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { exams } from '@/lib/db/schema'

export type ActiveExam = {
  id: string
  name: string
  updatedAt: Date
}

export async function getActiveExamsForUser(
  userId: string,
): Promise<ActiveExam[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: exams.id,
      name: exams.name,
      updatedAt: exams.updatedAt,
    })
    .from(exams)
    .where(and(eq(exams.userId, userId), isNull(exams.archivedAt)))
    .orderBy(desc(exams.updatedAt))
  return rows
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
