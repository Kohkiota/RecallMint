// cards-pull mapper test (S-local-2 Task 2)。
// pure な toClientCard mapper のみ verify (DB query 部分は route 統合 test 側で
// mock 化するためここでは扱わない)。 Date → ISO8601 文字列、 null 系処理、
// sync_status='synced' 固定が主要 assertion。

import { describe, it, expect } from 'vitest'
import { toClientCard, toCard } from './cards-mapper'
import type { ClientCard } from '@/lib/client-db'
import type { cards } from './schema'

type CardRow = typeof cards.$inferSelect

function fakeRow(overrides?: Partial<CardRow>): CardRow {
  return {
    id: 'card-1',
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    title: '問1',
    questionLabel: null,
    questionText: 'Q',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    images: [],
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    due: new Date('2026-05-26T10:00:00.000Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    contentVersion: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    ...overrides,
  } as CardRow
}

describe('toClientCard', () => {
  it('Date 系を ISO8601 文字列化、 sync_status="synced" 固定', () => {
    const out = toClientCard(fakeRow())
    expect(out.due).toBe('2026-05-26T10:00:00.000Z')
    expect(out.created_at).toBe('2026-05-01T00:00:00.000Z')
    expect(out.updated_at).toBe('2026-05-02T00:00:00.000Z')
    expect(out.last_review).toBeNull()
    expect(out.sync_status).toBe('synced')
  })

  it('lastReview が Date のとき ISO 文字列化', () => {
    const out = toClientCard(
      fakeRow({ lastReview: new Date('2026-05-25T05:00:00.000Z') }),
    )
    expect(out.last_review).toBe('2026-05-25T05:00:00.000Z')
  })

  it('camelCase → snake_case の field rename を verify', () => {
    const out = toClientCard(
      fakeRow({
        userId: 'u',
        examId: 'e',
        sourceDocumentId: 'src',
        questionLabel: 'sk',
        questionText: 'q',
        correctAnswerIds: ['x'],
        explanationText: 'ex',
        lastCorrect: true,
        currentStreak: 5,
        elapsedDays: 2,
        scheduledDays: 3,
        learningSteps: 1,
        contentVersion: 7,
      }),
    )
    expect(out.user_id).toBe('u')
    expect(out.exam_id).toBe('e')
    expect(out.source_document_id).toBe('src')
    expect(out.question_label).toBe('sk')
    expect(out.question_text).toBe('q')
    expect(out.correct_answer_ids).toEqual(['x'])
    expect(out.explanation_text).toBe('ex')
    expect(out.last_correct).toBe(true)
    expect(out.current_streak).toBe(5)
    expect(out.elapsed_days).toBe(2)
    expect(out.scheduled_days).toBe(3)
    expect(out.learning_steps).toBe(1)
    expect(out.content_version).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// S-local-3 Task 1: toCard reverse mapper (ClientCard → Card)。 toClientCard と
// 対称、 ISO 文字列 → Date 復元、 snake_case → camelCase、 sync_status drop。
// ---------------------------------------------------------------------------

function fakeClient(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'Q',
    question_label: null,
    base_order: 1024,
    question_text: 'Q',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correct_answer_ids: ['a'],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-05-26T10:00:00.000Z',
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
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

describe('toCard (reverse mapper)', () => {
  it('ISO 文字列を Date に復元、 sync_status は drop', () => {
    const out = toCard(fakeClient())
    expect(out.due).toEqual(new Date('2026-05-26T10:00:00.000Z'))
    expect(out.createdAt).toEqual(new Date('2026-05-01T00:00:00.000Z'))
    expect(out.updatedAt).toEqual(new Date('2026-05-02T00:00:00.000Z'))
    expect(out.lastReview).toBeNull()
    expect('sync_status' in out).toBe(false)
  })

  it('last_review が ISO 文字列なら Date に復元', () => {
    const out = toCard(fakeClient({ last_review: '2026-05-25T05:00:00.000Z' }))
    expect(out.lastReview).toEqual(new Date('2026-05-25T05:00:00.000Z'))
  })

  it('snake_case → camelCase の field rename', () => {
    const out = toCard(
      fakeClient({
        user_id: 'u',
        exam_id: 'e',
        source_document_id: 'src',
        question_label: 'sk',
        question_text: 'q',
        correct_answer_ids: ['x'],
        explanation_text: 'ex',
        last_correct: true,
        current_streak: 5,
        elapsed_days: 2,
        scheduled_days: 3,
        learning_steps: 1,
        content_version: 7,
      }),
    )
    expect(out.userId).toBe('u')
    expect(out.examId).toBe('e')
    expect(out.sourceDocumentId).toBe('src')
    expect(out.questionLabel).toBe('sk')
    expect(out.questionText).toBe('q')
    expect(out.correctAnswerIds).toEqual(['x'])
    expect(out.explanationText).toBe('ex')
    expect(out.lastCorrect).toBe(true)
    expect(out.currentStreak).toBe(5)
    expect(out.elapsedDays).toBe(2)
    expect(out.scheduledDays).toBe(3)
    expect(out.learningSteps).toBe(1)
    expect(out.contentVersion).toBe(7)
  })

  it('round-trip: ClientCard → Card → ClientCard で同一', () => {
    const original = fakeClient({
      last_review: '2026-05-25T05:00:00.000Z',
      last_correct: true,
      current_streak: 3,
      stability: 1.5,
      difficulty: 0.7,
    })
    const roundTripped = toClientCard(toCard(original))
    expect(roundTripped).toEqual(original)
  })
})
