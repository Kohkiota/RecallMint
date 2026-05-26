// get-dexie-session-cards test (S-local-3 Task 2)。 fake-indexeddb で実 Dexie
// を動かし、 due filter + sort + limit + tenant 絞りを verify。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { getDueCardsFromDexie } from './get-dexie-session-cards'

function fakeClient(overrides?: Partial<ClientCard>): ClientCard {
  return {
    id: 'card-1',
    user_id: 'user-1',
    exam_id: 'exam-1',
    source_document_id: null,
    title: 'Q',
    sort_key: null,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
    explanation_text: null,
    memo: null,
    images: [],
    custom_props: {},
    tags: [],
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

beforeEach(async () => {
  await getClientDb().cards.clear()
})

describe('getDueCardsFromDexie', () => {
  const NOW = new Date('2026-05-26T12:00:00.000Z')

  it('空 table → 空配列', async () => {
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toEqual([])
  })

  it('全て future due → 空配列', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-05-27T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-05-28T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toEqual([])
  })

  it('due <= now のみ返却、 Card 型 (camelCase + Date) に変換済', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'past', due: '2026-05-25T00:00:00.000Z' }),
      fakeClient({ id: 'future', due: '2026-05-27T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('past')
    // Date 型 (Card 型) であることを確認
    expect(out[0]?.due).toBeInstanceOf(Date)
    expect(out[0]?.due.toISOString()).toBe('2026-05-25T00:00:00.000Z')
    // camelCase field 名 (Card 型) であることを確認
    expect(out[0]?.userId).toBe('user-1')
    expect(out[0]?.examId).toBe('exam-1')
  })

  it('sort by due asc (古い順)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'middle', due: '2026-05-24T00:00:00.000Z' }),
      fakeClient({ id: 'oldest', due: '2026-05-20T00:00:00.000Z' }),
      fakeClient({ id: 'newest', due: '2026-05-25T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out.map((c) => c.id)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('limit 超え → limit 件で truncate', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'a', due: '2026-05-20T00:00:00.000Z' }),
      fakeClient({ id: 'b', due: '2026-05-21T00:00:00.000Z' }),
      fakeClient({ id: 'c', due: '2026-05-22T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 2, NOW)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('他 user の cards は含まれない (tenant isolation)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'mine', user_id: 'user-1' }),
      fakeClient({ id: 'others', user_id: 'user-2' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('mine')
  })

  it('now 省略時は new Date() (= 現在時刻、 通常 future due は除外)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClient({ id: 'past', due: '2020-01-01T00:00:00.000Z' }),
      // 100 年先は除外される
      fakeClient({ id: 'far-future', due: '2126-01-01T00:00:00.000Z' }),
    ])
    const out = await getDueCardsFromDexie('user-1', 10)
    expect(out.map((c) => c.id)).toEqual(['past'])
  })
})
