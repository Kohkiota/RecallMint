// seed-from-criteria.test.ts (S2.3 T14)
// seedFromCriteria の決定論性・独立性・フィールド感度・再現性を検証。
// 純関数のため fake-indexeddb 不要。

import { describe, it, expect, beforeEach } from 'vitest'
import { seedFromCriteria } from './seed-from-criteria'
import { selectCustomSessionRows, type CustomSessionCriteria } from './get-custom-session-cards'
import { getClientDb, type ClientCard } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// ヘルパー: PRNG から N 個の数列を取得
// ---------------------------------------------------------------------------

function takeN(rng: () => number, n: number): number[] {
  return Array.from({ length: n }, () => rng())
}

// ---------------------------------------------------------------------------
// criteria 共通ベース
// ---------------------------------------------------------------------------

function baseCriteriaNoUserLimit(): Omit<CustomSessionCriteria, 'userId' | 'limit'> {
  return {
    examIds: ['exam-A', 'exam-B'],
    tagFilter: { 'cat-1': ['opt-1', 'opt-2'] },
    answerState: 'all',
    streakFilter: null,
    order: 'random',
  }
}

// ---------------------------------------------------------------------------
// 決定論性: 同一 criteria → 同一系列
// ---------------------------------------------------------------------------

describe('seedFromCriteria', () => {
  it('同一 criteria から生成した2つの PRNG が同一系列を返す', () => {
    const c = baseCriteriaNoUserLimit()
    const rng1 = seedFromCriteria(c)
    const rng2 = seedFromCriteria(c)
    expect(takeN(rng1, 10)).toEqual(takeN(rng2, 10))
  })

  // ---------------------------------------------------------------------------
  // examIds 順序独立性
  // ---------------------------------------------------------------------------

  it('examIds の順序が違っても同一 seed になる', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), examIds: ['exam-A', 'exam-B'] }
    const c2 = { ...baseCriteriaNoUserLimit(), examIds: ['exam-B', 'exam-A'] }
    const seq1 = takeN(seedFromCriteria(c1), 10)
    const seq2 = takeN(seedFromCriteria(c2), 10)
    expect(seq1).toEqual(seq2)
  })

  // ---------------------------------------------------------------------------
  // tagFilter 値配列の順序独立性
  // ---------------------------------------------------------------------------

  it('tagFilter 値配列の順序が違っても同一 seed になる', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), tagFilter: { 'cat-1': ['opt-1', 'opt-2'] } }
    const c2 = { ...baseCriteriaNoUserLimit(), tagFilter: { 'cat-1': ['opt-2', 'opt-1'] } }
    expect(takeN(seedFromCriteria(c1), 10)).toEqual(takeN(seedFromCriteria(c2), 10))
  })

  // ---------------------------------------------------------------------------
  // 異なる criteria → 異なる系列
  // ---------------------------------------------------------------------------

  it('examIds が異なると異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), examIds: ['exam-A'] }
    const c2 = { ...baseCriteriaNoUserLimit(), examIds: ['exam-Z'] }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })

  it('tagFilter が異なると異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), tagFilter: { 'cat-1': ['opt-1'] } }
    const c2 = { ...baseCriteriaNoUserLimit(), tagFilter: { 'cat-1': ['opt-9'] } }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })

  it('answerState が異なると異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), answerState: 'all' as const }
    const c2 = { ...baseCriteriaNoUserLimit(), answerState: 'unanswered' as const }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })

  it('streakFilter null vs non-null で異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), streakFilter: null }
    const c2 = { ...baseCriteriaNoUserLimit(), streakFilter: { op: 'lte' as const, value: 0 } }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })

  it('streakFilter op が異なると異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), streakFilter: { op: 'lte' as const, value: 2 } }
    const c2 = { ...baseCriteriaNoUserLimit(), streakFilter: { op: 'gte' as const, value: 2 } }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })

  it('streakFilter value が異なると異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), streakFilter: { op: 'lte' as const, value: 1 } }
    const c2 = { ...baseCriteriaNoUserLimit(), streakFilter: { op: 'lte' as const, value: 9 } }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })

  it('order が異なると異なる系列', () => {
    const c1 = { ...baseCriteriaNoUserLimit(), order: 'random' as const }
    const c2 = { ...baseCriteriaNoUserLimit(), order: 'sequential' as const }
    expect(takeN(seedFromCriteria(c1), 5)).not.toEqual(takeN(seedFromCriteria(c2), 5))
  })
})

// ---------------------------------------------------------------------------
// 再現性: seedFromCriteria を rng として selectCustomSessionRows に注入
// ---------------------------------------------------------------------------

let _seq = 0
function fakeCard(overrides?: Partial<ClientCard>): ClientCard {
  _seq++
  return {
    id: `sc-card-${_seq}`,
    user_id: 'user-seed',
    exam_id: 'exam-seed',
    source_document_id: null,
    title: `Q${_seq}`,
    sort_key: null,
    question_text: `q${_seq}`,
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-05-01T00:00:00.000Z',
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
    created_at: `2026-01-${String(_seq).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: '2026-05-02T00:00:00.000Z',
    sync_status: 'synced',
    ...overrides,
  }
}

describe('seedFromCriteria + selectCustomSessionRows 再現性', () => {
  beforeEach(async () => {
    _seq = 0
    const db = getClientDb()
    await db.cards.clear()
    await db.card_tags.clear()
    await db.tag_categories.clear()
    await db.tag_options.clear()
  })

  it('同一 criteria seed で2回呼んだ selectCustomSessionRows が同じ順序を返す', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeCard({ id: 'seed-c1' }),
      fakeCard({ id: 'seed-c2' }),
      fakeCard({ id: 'seed-c3' }),
      fakeCard({ id: 'seed-c4' }),
      fakeCard({ id: 'seed-c5' }),
    ])

    const criteria: CustomSessionCriteria = {
      userId: 'user-seed',
      examIds: [],
      tagFilter: {},
      answerState: 'all',
      streakFilter: null,
      order: 'random',
      limit: null,
    }
    const { userId: _u, limit: _l, ...criteriaForSeed } = criteria

    // 1回目
    const rng1 = seedFromCriteria(criteriaForSeed)
    const rows1 = await selectCustomSessionRows(criteria, rng1)

    // 2回目 (新しい PRNG インスタンス、同一 seed)
    const rng2 = seedFromCriteria(criteriaForSeed)
    const rows2 = await selectCustomSessionRows(criteria, rng2)

    expect(rows1.map((r) => r.card.id)).toEqual(rows2.map((r) => r.card.id))
    // かつランダムな順序であることの確認 (全件が揃っている)
    expect(rows1.map((r) => r.card.id).sort()).toEqual(
      ['seed-c1', 'seed-c2', 'seed-c3', 'seed-c4', 'seed-c5'].sort(),
    )
  })
})
