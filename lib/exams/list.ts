// exam list helpers — server-side query + client-friendly relative time format。
//
// MVP では archived_at IS NULL の exam 一覧を updated_at DESC で取る。
// archived UX 詳細 (一覧で archived を表示するか / 復元 button 等) は S2 で確定。

import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards, exams, sourceDocuments, type CardOption } from '@/lib/db/schema'

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

// S1.7 T7 用: 一覧 page で cards 件数を見せる query。
// B1 (S2.0c): cards への LEFT JOIN + GROUP BY 集計をやめ、 非正規化列
// exams.card_count を直接読む。 件数の維持は card INSERT / DELETE 側
// (process.ts の OCR bulk / delete-card.ts) が transaction で担保する。
// getActiveExamsForUser と別関数なのは、 upload page が使う後者に card_count
// 列まで載せる必要がないため。
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
      cardCount: exams.cardCount,
    })
    .from(exams)
    .where(and(eq(exams.userId, userId), isNull(exams.archivedAt)))
    .orderBy(desc(exams.updatedAt))
  return rows
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

// CardListEntry: OCR result page (getCardsForSourceDocument) 用の snippet 表示型。
export type CardListEntry = {
  id: string
  title: string
  sortKey: string | null
  questionTextSnippet: string
  optionCount: number
  customPropKeys: string[]
}

// ExamDetailCard: 試験詳細 page (/app/exams/[id]) で 1 card の全情報を read-only
// 展開表示するための型 (S2.0 T7)。 snippet ではなく問題文全文 / 全選択肢 + 各解説 /
// card 全体解説をそのまま渡し、 OCR 投入結果を一目で把握できるようにする。
export type ExamDetailCard = {
  id: string
  title: string
  sortKey: string | null
  questionText: string
  options: CardOption[]
  explanationText: string | null
}

// 試験詳細 page 用 cards 取得 (read-only、 owner-scoped)。
// sort: sort_key (text) ASC NULLS LAST → created_at ASC で OCR 文書順を尊重。
export async function getCardsForExam(
  userId: string,
  examId: string,
): Promise<ExamDetailCard[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: cards.id,
      title: cards.title,
      sortKey: cards.sortKey,
      questionText: cards.questionText,
      options: cards.options,
      explanationText: cards.explanationText,
    })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.examId, examId)))
    .orderBy(cards.sortKey, cards.createdAt)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sortKey: r.sortKey,
    questionText: r.questionText,
    // options は schema 上 NOT NULL だが防御的に配列チェック。
    options: Array.isArray(r.options) ? r.options : [],
    explanationText: r.explanationText,
  }))
}

function snippet(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

// S1.9.2: OCR result page (/app/upload/result/[sourceDocumentId]) 用。
// source_document を owner-scoped で取得し、 投入先 exam 名を JOIN で同時に引く。
// 不在 / 他 user の場合は null (page 側で notFound())。
export type SourceDocumentResult = {
  id: string
  examName: string
}
export async function getSourceDocumentForUser(
  userId: string,
  sourceDocumentId: string,
): Promise<SourceDocumentResult | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: sourceDocuments.id,
      examName: exams.name,
    })
    .from(sourceDocuments)
    .innerJoin(exams, eq(exams.id, sourceDocuments.examId))
    .where(
      and(
        eq(sourceDocuments.id, sourceDocumentId),
        eq(sourceDocuments.userId, userId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

// S1.9.2: OCR result page 用。 当該 source_document が抽出した cards 一覧。
// snippet 表示型 CardListEntry を返す (S2.0 T7 で getCardsForExam は rich 型
// ExamDetailCard に変更済、 本関数は upload result page 用に CardListEntry 据え置き)。
export async function getCardsForSourceDocument(
  userId: string,
  sourceDocumentId: string,
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
    .where(
      and(
        eq(cards.userId, userId),
        eq(cards.sourceDocumentId, sourceDocumentId),
      ),
    )
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
