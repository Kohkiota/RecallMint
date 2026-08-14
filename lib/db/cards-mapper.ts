// cards-mapper — pure な ClientCard ↔ Card mapper を切り出した client-safe module。
//
// 役割境界:
// - `lib/db/cards-pull.ts` は `getDb` を import するため server 限定 (`import
//   'server-only'`)。 client component から server cards 型 ↔ Dexie 型を変換したい
//   時 (例: smart session で Dexie cards を server Card 型に揃える) は本 module
//   から import すること。
// - 本 module 自身は drizzle schema (型のみ) と client-db (型のみ) に依存する pure
//   module で、 server / client 両側から自由に import できる。

import type { cards as cardsTable } from './schema'
import type { ClientCard } from '@/lib/client-db'

type CardRow = typeof cardsTable.$inferSelect

export function toClientCard(row: CardRow): ClientCard {
  return {
    id: row.id,
    user_id: row.userId,
    exam_id: row.examId,
    source_document_id: row.sourceDocumentId,
    title: row.title,
    question_label: row.questionLabel,
    base_order: row.baseOrder,
    question_text: row.questionText,
    options: row.options,
    correct_answer_ids: row.correctAnswerIds,
    explanation_text: row.explanationText,
    memo: row.memo,
    images: row.images,
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
    questionLabel: c.question_label ?? null,
    baseOrder: c.base_order,
    questionText: c.question_text,
    options: c.options,
    correctAnswerIds: c.correct_answer_ids,
    explanationText: c.explanation_text ?? null,
    memo: c.memo ?? null,
    images: c.images,
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
