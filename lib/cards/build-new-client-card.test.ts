import { describe, it, expect } from 'vitest'
import { buildNewClientCard } from './build-new-client-card'
import type { EmptyCard } from './empty-card'

// buildNewClientCard は手動 card 追加の local-first 化 (Task 4.3) で、 mirror に
// 即時 insert する完全な ClientCard を組む。 server DB schema (lib/db/schema.ts)
// の card default を replicate しつつ、 content は buildEmptyCard 由来値を写す。

const EMPTY: EmptyCard = {
  title: '新規カード 3',
  sortKey: '3',
  questionText: '(問題文を入力してください)',
  options: [{ id: '1', text: '(選択肢1)', is_correct: false }],
  correctAnswerIds: [],
}

describe('buildNewClientCard', () => {
  it('content フィールドを EmptyCard から写す (snake_case)', () => {
    const card = buildNewClientCard({
      cardId: 'card-1',
      userId: 'user-1',
      examId: 'exam-1',
      empty: EMPTY,
      now: '2026-05-31T00:00:00.000Z',
    })
    expect(card.id).toBe('card-1')
    expect(card.user_id).toBe('user-1')
    expect(card.exam_id).toBe('exam-1')
    expect(card.title).toBe('新規カード 3')
    expect(card.sort_key).toBe('3')
    expect(card.question_text).toBe('(問題文を入力してください)')
    expect(card.options).toEqual([{ id: '1', text: '(選択肢1)', is_correct: false }])
    expect(card.correct_answer_ids).toEqual([])
  })

  it('server schema の FSRS / scheduling default を replicate する', () => {
    const card = buildNewClientCard({
      cardId: 'card-1',
      userId: 'user-1',
      examId: 'exam-1',
      empty: EMPTY,
      now: '2026-05-31T00:00:00.000Z',
    })
    expect(card.answered).toBe(false)
    expect(card.last_correct).toBeNull()
    expect(card.current_streak).toBe(0)
    expect(card.due).toBe('2026-05-31T00:00:00.000Z')
    expect(card.stability).toBe(0)
    expect(card.difficulty).toBe(0)
    expect(card.elapsed_days).toBe(0)
    expect(card.scheduled_days).toBe(0)
    expect(card.reps).toBe(0)
    expect(card.lapses).toBe(0)
    expect(card.state).toBe(0)
    expect(card.learning_steps).toBe(0)
    expect(card.last_review).toBeNull()
    expect(card.content_version).toBe(0)
  })

  it('jsonb / 配列 default + 監査列 + sync_status を set する', () => {
    const card = buildNewClientCard({
      cardId: 'card-1',
      userId: 'user-1',
      examId: 'exam-1',
      empty: EMPTY,
      now: '2026-05-31T00:00:00.000Z',
    })
    expect(card.images).toEqual([])
    expect(card.source_document_id).toBeNull()
    expect(card.explanation_text).toBeNull()
    expect(card.memo).toBeNull()
    expect(card.created_at).toBe('2026-05-31T00:00:00.000Z')
    expect(card.updated_at).toBe('2026-05-31T00:00:00.000Z')
    // mirror insert は未送信状態 (outbox の create mutation が flush で確定させる)
    expect(card.sync_status).toBe('pending')
  })
})
