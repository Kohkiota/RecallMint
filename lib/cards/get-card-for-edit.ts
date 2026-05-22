// card 編集 page (/app/cards/[id]) 用の単一 card 取得 query。
//
// owner-scoped (WHERE cards.user_id) で 1 件取得し、 breadcrumb 表示用に
// 投入先 exam 名を JOIN で同時に引く。 不在 / 他 user の cardId は null を返し、
// page 側で notFound() に変換する。

import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards, exams, type CardOption } from '@/lib/db/schema'

export type CardForEdit = {
  id: string
  examId: string
  examName: string
  title: string
  questionText: string
  options: CardOption[]
  explanationText: string | null
}

export async function getCardForEdit(
  userId: string,
  cardId: string,
): Promise<CardForEdit | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: cards.id,
      examId: cards.examId,
      examName: exams.name,
      title: cards.title,
      questionText: cards.questionText,
      options: cards.options,
      explanationText: cards.explanationText,
    })
    .from(cards)
    .innerJoin(exams, eq(exams.id, cards.examId))
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}
