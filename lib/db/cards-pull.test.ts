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

  // Dash-1 Home v1 Task 1(canonical review Important 1 対応): 全 fixture が
  // firstReviewedAt: null だと ISO 文字列変換の分岐が一度も通らず、
  // ハードコード null な実装でも green になってしまう。非 null 値で変換を exercise する。
  it('firstReviewedAt が Date のとき ISO8601 文字列化', () => {
    const out = toClientCard(
      fakeRow({ firstReviewedAt: new Date('2026-05-20T00:00:00.000Z') }),
    )
    expect(out.first_reviewed_at).toBe('2026-05-20T00:00:00.000Z')
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
    // Dash-1 Home v1 Task 1: toClientCard は他の nullable 列 (last_review 等) と
    // 同じ convention で first_reviewed_at も無条件にキーを出す (省略しない)。
    // fixture の既定形もそれに合わせて明示 null を持つ (省略した ClientCard の
    // 挙動は round-trip test 側で別途 pin する)。
    first_reviewed_at: null,
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

  // Dash-1 Home v1 Task 1(canonical review Important 1 対応): toCard 方向も
  // 非 null 値で ISO 文字列 → Date 復元を exercise する(toClientCard 側と対称)。
  it('first_reviewed_at が ISO 文字列なら Date に復元', () => {
    const out = toCard(fakeClient({ first_reviewed_at: '2026-05-20T00:00:00.000Z' }))
    expect(out.firstReviewedAt).toEqual(new Date('2026-05-20T00:00:00.000Z'))
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

  // Dash-1 Home v1 Task 1(Codex P1 の指摘対応): ClientCard.first_reviewed_at は
  // optional なので「キー省略」と「値 null」は別状態(migration 前に作られた
  // 既存 Dexie 行はキー自体が無い)。 toClientCard は他の nullable 列と同じ
  // convention で常にキーを出す(lib/db/cards-mapper.ts:toClientCard 本体で
  // 観察できる convention — last_review 等と同型)ため、 省略入力は round-trip で
  // 明示 null に正規化される — この正規化を意図的な契約として pin する
  // (original と厳密一致ではなく、正規化後の形と一致することを確認する)。
  //
  // withKey.first_reviewed_at を非 null にしておく(canonical review 指摘対応):
  // 値が最初から null だと下の `{ ...withKey, first_reviewed_at: null }` が
  // no-op になり、「省略 → 正規化」を実際には検証しない偽陽性の pin になる。
  // 非 null にすることで override が意味を持つ(withKey とは異なる期待値になる)。
  it('round-trip: first_reviewed_at を省略した ClientCard(migration 前の既存行)は明示 null に正規化される', () => {
    const withKey = fakeClient({
      last_review: '2026-05-25T05:00:00.000Z',
      first_reviewed_at: '2026-05-20T00:00:00.000Z',
    })
    const { first_reviewed_at: _omitted, ...omittedFirstReviewedAt } = withKey
    expect('first_reviewed_at' in omittedFirstReviewedAt).toBe(false)

    const roundTripped = toClientCard(toCard(omittedFirstReviewedAt as ClientCard))
    expect(roundTripped).toEqual({ ...withKey, first_reviewed_at: null })
  })
})
