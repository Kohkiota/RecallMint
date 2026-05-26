// cards-pull mapper test (S-local-2 Task 2)。
// pure な toClientCard mapper のみ verify (DB query 部分は route 統合 test 側で
// mock 化するためここでは扱わない)。 Date → ISO8601 文字列、 null 系処理、
// sync_status='synced' 固定が主要 assertion。

import { describe, it, expect } from 'vitest'
import { toClientCard } from './cards-pull'
import type { cards } from './schema'

type CardRow = typeof cards.$inferSelect

function fakeRow(overrides?: Partial<CardRow>): CardRow {
  return {
    id: 'card-1',
    userId: 'user-1',
    examId: 'exam-1',
    sourceDocumentId: null,
    title: '問1',
    sortKey: null,
    questionText: 'Q',
    options: [{ id: 'a', text: 'A', is_correct: true }],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    images: [],
    customProps: {},
    tags: [],
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
        sortKey: 'sk',
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
    expect(out.sort_key).toBe('sk')
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
