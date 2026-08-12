// exams-pull — server exams テーブルから client (Dexie) 用の ClientExam shape
// (snake_case + ISO8601 文字列) に変換した差分を取得する。
// 統合 `/api/pull` の delta 入口を提供する。

import { exams } from './schema'
import type { ClientExam } from '@/lib/client-db'
import { getDeltaRows } from './pull-delta'
import type { TenantDb } from './tenant-tx'

type ExamRow = typeof exams.$inferSelect

export function toClientExam(row: ExamRow): ClientExam {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    content_version: row.contentVersion,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export async function getExamsDelta(
  userId: string,
  dbc: TenantDb,
  since?: Date,
): Promise<{ rows: ClientExam[]; maxUpdatedAt: string | null }> {
  const { rows, max } = await getDeltaRows(
    {
      table: exams,
      userIdCol: exams.userId,
      cursorCol: exams.updatedAt,
      mapper: toClientExam,
      cursorValueOf: (r) => r.updated_at,
    },
    userId,
    dbc,
    since,
  )
  return { rows, maxUpdatedAt: max }
}
