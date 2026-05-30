// exams-pull — server exams テーブルから user 全 exams を取得し、 client (Dexie)
// 用の ClientExam shape (snake_case + ISO8601 文字列) に変換する。
// S-local-2 Task 3 で `/api/exams/pull` route が利用する。

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

export async function getAllExamsForUser(userId: string): Promise<ClientExam[]> {
  const db = getDb()
  const rows = await db.select().from(exams).where(eq(exams.userId, userId))
  return rows.map(toClientExam)
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
