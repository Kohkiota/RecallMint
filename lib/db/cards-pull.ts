// cards-pull — server cards テーブルから user 全 cards を取得し、 client (Dexie)
// 用の ClientCard shape (snake_case + ISO8601 文字列) に変換する。
// S-local-2 Task 2 で `/api/cards/pull` route が利用する。
//
// 役割境界:
// - getAllCardsForUser: tenant 絞り込み + Drizzle SELECT の唯一の入口。 ここで
//   `WHERE user_id` を強制し、 呼出側が条件を忘れて全 user を覗ける事故を防ぐ。
// - toClientCard: pure な mapper。 unit test で field rename / Date 文字列化 /
//   sync_status='synced' 固定を verify する。

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards } from './schema'
import type { ClientCard } from '@/lib/client-db'

type CardRow = typeof cards.$inferSelect

export function toClientCard(row: CardRow): ClientCard {
  return {
    id: row.id,
    user_id: row.userId,
    exam_id: row.examId,
    source_document_id: row.sourceDocumentId,
    title: row.title,
    sort_key: row.sortKey,
    question_text: row.questionText,
    options: row.options,
    correct_answer_ids: row.correctAnswerIds,
    explanation_text: row.explanationText,
    memo: row.memo,
    images: row.images,
    custom_props: row.customProps,
    tags: row.tags,
    answered: row.answered,
    last_correct: row.lastCorrect,
    current_streak: row.currentStreak,
    due: row.due.toISOString(),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsedDays,
    scheduled_days: row.scheduledDays,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    learning_steps: row.learningSteps,
    last_review: row.lastReview ? row.lastReview.toISOString() : null,
    content_version: row.contentVersion,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    sync_status: 'synced',
  }
}

export async function getAllCardsForUser(userId: string): Promise<ClientCard[]> {
  const db = getDb()
  const rows = await db.select().from(cards).where(eq(cards.userId, userId))
  return rows.map(toClientCard)
}

// S-local-3 Task 1: ClientCard (Dexie) → Card (Drizzle inferSelect) の逆 mapping。
// toClientCard の対称、 ISO 文字列 → Date 復元、 snake_case → camelCase、
// sync_status drop。 smart session で Dexie cards を server Card 型に揃えて
// session-runner に渡すために利用する。
export function toCard(c: ClientCard): CardRow {
  return {
    id: c.id,
    userId: c.user_id,
    examId: c.exam_id,
    sourceDocumentId: c.source_document_id ?? null,
    title: c.title,
    sortKey: c.sort_key ?? null,
    questionText: c.question_text,
    options: c.options,
    correctAnswerIds: c.correct_answer_ids,
    explanationText: c.explanation_text ?? null,
    memo: c.memo ?? null,
    images: c.images,
    customProps: c.custom_props,
    tags: c.tags,
    answered: c.answered,
    lastCorrect: c.last_correct ?? null,
    currentStreak: c.current_streak,
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    learningSteps: c.learning_steps,
    lastReview: c.last_review ? new Date(c.last_review) : null,
    contentVersion: c.content_version,
    createdAt: new Date(c.created_at),
    updatedAt: new Date(c.updated_at),
  }
}
