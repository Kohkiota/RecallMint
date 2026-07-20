// study-days-pull — server `study_days` テーブルから user の直近 90 日分を取得し、
// client (Dexie) 用 ClientStudyDay shape に変換する。 S-perf-3 (dashboard 高速化、
// streak / todayCount を Dexie 経由に切替)。
//
// 役割境界:
// - getAllStudyDaysForUser: tenant 絞り込み + 直近 90 日 window 適用の唯一の入口。
//   ここで `WHERE user_id` と `WHERE day >= lower` を強制し、 呼出側が条件を忘れる
//   事故を防ぐ (cards-pull / getCardsDelta と同方針)。
// - toClientStudyDay: pure mapper。 unit test で field rename を verify。
// - studyDaysLowerBound: pure helper。 JST 算術 (todayInJst の 90 日前) を unit test
//   可能な形で切り出す。

import { and, eq, gte } from 'drizzle-orm'
import { studyDays } from './schema'
import { todayInJst } from '@/lib/jst'
import type { ClientStudyDay } from '@/lib/client-db'
import type { TenantDb } from './tenant-tx'

type StudyDayRow = typeof studyDays.$inferSelect

// 今日を含む過去 N 日 (N=90 → today - 89)。 streak 計算は最大 61 日 (today + 過去 60)
// しか使わないが、 client 側 dashboard 表示や将来の月別表示余地を確保するため 90 を
// 余裕を持たせて確定。
export const STUDY_DAYS_WINDOW = 90

export function studyDaysLowerBound(now?: Date): string {
  const today = todayInJst(now)
  return addDaysYmd(today, -(STUDY_DAYS_WINDOW - 1))
}

// 'YYYY-MM-DD' に delta 日を足した文字列を返す pure helper。 streak.ts の addDays と
// 同一ロジックだが、 server / client 跨ぎで依存を増やしたくないため duplicate (両方
// pure で行数も小、 抽象化の借金は小さい)。
function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

export function toClientStudyDay(row: StudyDayRow): ClientStudyDay {
  return {
    user_id: row.userId,
    day: row.day,
    review_count: row.reviewCount,
    correct_count: row.correctCount,
    distinct_card_count: row.distinctCardCount,
  }
}

export async function getAllStudyDaysForUser(
  userId: string,
  dbc: TenantDb,
  now?: Date,
): Promise<ClientStudyDay[]> {
  const db = dbc
  const lower = studyDaysLowerBound(now)
  const rows = await db
    .select()
    .from(studyDays)
    .where(and(eq(studyDays.userId, userId), gte(studyDays.day, lower)))
  return rows.map(toClientStudyDay)
}
