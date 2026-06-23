// sort-like-server.test.ts — sortLikeServer の純関数 unit test。
// sort_key NULLS LAST / 辞書順 ASC / created_at tiebreak を検証。

import { describe, it, expect } from 'vitest'
import type { ClientCard } from '@/lib/client-db'
import { sortLikeServer } from './sort-like-server'

// テスト用最小 ClientCard を組み立てるファクトリ
function card(
  id: string,
  sortKey: string | null,
  createdAt: string,
): ClientCard {
  return {
    id,
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: id,
    sort_key: sortKey,
    question_text: id,
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    answered: false,
    last_correct: null,
    current_streak: 0,
    due: '2026-01-01T00:00:00.000Z',
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
    created_at: createdAt,
    updated_at: createdAt,
    sync_status: 'synced',
  }
}

describe('sortLikeServer', () => {
  it('sort_key あり → 辞書順 ASC', () => {
    const a = card('a', '001', '2026-01-01T00:00:00.000Z')
    const b = card('b', '002', '2026-01-01T00:00:00.000Z')
    expect(sortLikeServer(a, b)).toBeLessThan(0) // a before b
    expect(sortLikeServer(b, a)).toBeGreaterThan(0)
  })

  it('sort_key null は末尾 (NULLS LAST)', () => {
    const withKey = card('a', '001', '2026-01-01T00:00:00.000Z')
    const noKey = card('b', null, '2026-01-01T00:00:00.000Z')
    expect(sortLikeServer(withKey, noKey)).toBeLessThan(0) // non-null before null
    expect(sortLikeServer(noKey, withKey)).toBeGreaterThan(0)
  })

  it('sort_key null 同士 → created_at ASC で tiebreak', () => {
    const older = card('a', null, '2026-01-01T00:00:00.000Z')
    const newer = card('b', null, '2026-01-02T00:00:00.000Z')
    expect(sortLikeServer(older, newer)).toBeLessThan(0)
    expect(sortLikeServer(newer, older)).toBeGreaterThan(0)
  })

  it('sort_key 同値 → created_at ASC で tiebreak', () => {
    const older = card('a', 'key', '2026-01-01T00:00:00.000Z')
    const newer = card('b', 'key', '2026-01-02T00:00:00.000Z')
    expect(sortLikeServer(older, newer)).toBeLessThan(0)
    expect(sortLikeServer(newer, older)).toBeGreaterThan(0)
  })

  it('全て同値 → 0 (等値)', () => {
    const a = card('a', 'key', '2026-01-01T00:00:00.000Z')
    const b = card('b', 'key', '2026-01-01T00:00:00.000Z')
    expect(sortLikeServer(a, b)).toBe(0)
  })

  it('配列 .sort() で正しく並ぶ (統合)', () => {
    const cards = [
      card('c', null, '2026-01-03T00:00:00.000Z'), // null → 後ろ、古い方
      card('d', null, '2026-01-04T00:00:00.000Z'), // null → 後ろ、新しい方
      card('b', '002', '2026-01-01T00:00:00.000Z'), // 辞書順 2 番目
      card('a', '001', '2026-01-01T00:00:00.000Z'), // 辞書順 1 番目
    ]
    const sorted = [...cards].sort(sortLikeServer)
    expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
