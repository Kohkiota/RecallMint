// exam list helpers — server-side query + client-friendly relative time format。
//
// MVP では archived_at IS NULL の exam 一覧を updated_at DESC で取る。
// archived UX 詳細 (一覧で archived を表示するか / 復元 button 等) は S2 で確定。

import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards, exams } from '@/lib/db/schema'

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

// S1.7 T7 用: 一覧 page で cards 件数を見せるための LEFT JOIN + GROUP BY query。
// 別関数として分離した理由: 既存 getActiveExamsForUser は upload page も使用しており
// count subquery を毎回付けると不要な負荷。
export type ExamWithCardCount = ActiveExam & { cardCount: number }
export async function getActiveExamsWithCardCount(
  userId: string,
): Promise<ExamWithCardCount[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: exams.id,
      name: exams.name,
      updatedAt: exams.updatedAt,
      cardCount: count(cards.id),
    })
    .from(exams)
    .leftJoin(cards, eq(cards.examId, exams.id))
    .where(and(eq(exams.userId, userId), isNull(exams.archivedAt)))
    .groupBy(exams.id, exams.name, exams.updatedAt)
    .orderBy(desc(exams.updatedAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    updatedAt: r.updatedAt,
    cardCount: Number(r.cardCount),
  }))
}

// S1.7 T7 用: 詳細 page で exam + その user の所有確認をしつつ archived 状態も取る。
// 不在 / 他 user の場合は null を返す (詳細 page 側で notFound() に変換)。
export type ExamDetail = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}
export async function getExamByIdForUser(
  userId: string,
  examId: string,
): Promise<ExamDetail | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: exams.id,
      name: exams.name,
      createdAt: exams.createdAt,
      updatedAt: exams.updatedAt,
      archivedAt: exams.archivedAt,
    })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

// S1.7 T7 用: 詳細 page で表示する cards 一覧 (read-only)。
// sort: sort_key (text) ASC NULLS LAST → createdAt ASC、 ユーザーが OCR 抽出時に
// 振った文書順 (sort_key) を尊重。 sort_key 未設定の場合は createdAt 順。
export type CardListEntry = {
  id: string
  title: string
  sortKey: string | null
  questionTextSnippet: string
  optionCount: number
  customPropKeys: string[]
}
export async function getCardsForExam(
  userId: string,
  examId: string,
): Promise<CardListEntry[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: cards.id,
      title: cards.title,
      sortKey: cards.sortKey,
      questionText: cards.questionText,
      options: cards.options,
      customProps: cards.customProps,
      createdAt: cards.createdAt,
    })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.examId, examId)))
    .orderBy(cards.sortKey, cards.createdAt)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sortKey: r.sortKey,
    questionTextSnippet: snippet(r.questionText, 80),
    optionCount: Array.isArray(r.options) ? r.options.length : 0,
    customPropKeys:
      r.customProps && typeof r.customProps === 'object'
        ? Object.keys(r.customProps as Record<string, unknown>)
        : [],
  }))
}

function snippet(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
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
