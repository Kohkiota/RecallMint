// 手動 card 追加 (Task 4.3 local-first) で mirror に即時 insert する完全な
// ClientCard を組む helper。 content は buildEmptyCard 由来の EmptyCard を写し、
// FSRS / scheduling / jsonb / 監査列の default は server schema (lib/db/schema.ts
// の cards table) を replicate する。 server 適用後の pull-back で確定値に収束する
// ため、 ここでは「server default 相当」を置けば足りる。
//
// sync_status は 'pending': mirror insert は楽観反映であり、 真の確定は outbox の
// create mutation が flush + pull-back で達成する。

import type { ClientCard } from '@/lib/client-db'
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
    // 学習統計 default
    answered: false,
    last_correct: null,
    current_streak: 0,
    // FSRS / scheduling default
    due: now,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    last_review: null,
    content_version: 0,
    // 監査
    created_at: now,
    updated_at: now,
    sync_status: 'pending',
  }
}
