// exams-pull — server exams テーブルから client (Dexie) 用の ClientExam shape
// (snake_case + ISO8601 文字列) に変換した差分を取得する。
// 統合 `/api/pull` の delta 入口を提供する。

import { and, eq, gte, SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { exams } from './schema'
import type { ClientExam } from '@/lib/client-db'
import { maxIso } from './max-iso'

type ExamRow = typeof exams.$inferSelect

export function toClientExam(row: ExamRow): ClientExam {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    question_no_format: row.questionNoFormat,
    archived_at: row.archivedAt ? row.archivedAt.toISOString() : null,
    card_count: row.cardCount,
    content_version: row.contentVersion,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export async function getExamsDelta(
  userId: string,
  since?: Date,
): Promise<{ rows: ClientExam[]; maxUpdatedAt: string | null }> {
  const db = getDb()
  const conds: SQL[] = [eq(exams.userId, userId)]
  if (since) conds.push(gte(exams.updatedAt, since))
  const rows = (await db.select().from(exams).where(and(...conds))).map(toClientExam)
  return { rows, maxUpdatedAt: maxIso(rows.map((r) => r.updated_at)) }
}
