// 手動 card 追加 (Task 4.3 local-first) で mirror に即時 insert する完全な
// ClientCard を組む helper。 content は buildEmptyCard 由来の EmptyCard を写し、
// FSRS / 学習統計の初期値は 1 定義(initialFsrsState、FSRS 整合 Sprint A Task 3・
// spec §7.1)から明示 set する。 server 適用後の pull-back で確定値に収束するため、
// ここでは client 時刻での初期値を置けば足りる(client optimistic = client 時刻・
// server は server 時刻・現行と同じ)。 jsonb / 監査列の default は server schema
// (lib/db/schema.ts の cards table)を replicate する。
//
// sync_status は 'pending': mirror insert は楽観反映であり、 真の確定は outbox の
// create mutation が flush + pull-back で達成する。

import type { ClientCard } from '@/lib/client-db'
import { initialFsrsState } from './domain/initial-fsrs-state'
import type { EmptyCard } from './empty-card'

export interface BuildNewClientCardInput {
  cardId: string
  userId: string
  examId: string
  empty: EmptyCard
  /** 採番時刻 (ISO8601)。 due / created_at / updated_at に共用する。 */
  now: string
}

export function buildNewClientCard({
  cardId,
  userId,
  examId,
  empty,
  now,
}: BuildNewClientCardInput): ClientCard {
  // initialFsrsState は DB 列名 (camelCase) の Date を返す。ClientCard は
  // snake_case + due は ISO8601 文字列 (lib/client-db.ts) のため変換する。
  const fsrs = initialFsrsState(new Date(now))
  return {
    id: cardId,
    user_id: userId,
    exam_id: examId,
    source_document_id: null,
    // content (buildEmptyCard 由来)
    title: empty.title,
    sort_key: empty.sortKey,
    question_text: empty.questionText,
    options: empty.options,
    correct_answer_ids: empty.correctAnswerIds,
    explanation_text: null,
    memo: null,
    // jsonb / 配列 default (server schema 既定値)
    images: [],
    // 学習統計 / FSRS 初期値 (1 定義 = initialFsrsState、Task 3)
    answered: fsrs.answered,
    last_correct: fsrs.lastCorrect,
    current_streak: fsrs.currentStreak,
    due: fsrs.due.toISOString(),
    stability: fsrs.stability,
    difficulty: fsrs.difficulty,
    elapsed_days: fsrs.elapsedDays,
    scheduled_days: fsrs.scheduledDays,
    reps: fsrs.reps,
    lapses: fsrs.lapses,
    state: fsrs.state,
    learning_steps: fsrs.learningSteps,
    last_review: fsrs.lastReview,
    content_version: 0,
    // 監査
    created_at: now,
    updated_at: now,
    sync_status: 'pending',
  }
}
