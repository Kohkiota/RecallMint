// cards sync helper test (S-local-2 Task 4)。 fake-indexeddb 経由で実 Dexie を
// 動かし、 PullApiClient mock で server response を制御。 atomic replace の挙動 /
// sync_meta update / 失敗時の不変性を verify。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta } from './sync-meta'
import { pullAllCards, type PullApiClient } from './cards'

function fakeClientCard(overrides?: Partial<ClientCard>): ClientCard {
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

function mockClient(
  response: Awaited<ReturnType<PullApiClient['get']>>,
): PullApiClient {
  return { get: vi.fn().mockResolvedValue(response) }
}

beforeEach(async () => {
  const db = getClientDb()
  await Promise.all([db.cards.clear(), db.sync_meta.clear()])
})

describe('pullAllCards', () => {
  it('成功 0 件: cards 空 + sync_meta set', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: { cards: [], now: '2026-05-26T01:00:00.000Z' },
    })
    const result = await pullAllCards(client)
    expect(result).toEqual({ ok: true, count: 0 })
    expect(await getClientDb().cards.count()).toBe(0)
    expect(await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)).toBe(
      '2026-05-26T01:00:00.000Z',
    )
  })

  it('成功 N 件: cards table に N 行 + sync_meta set', async () => {
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        cards: [fakeClientCard({ id: 'a' }), fakeClientCard({ id: 'b' })],
        now: '2026-05-26T02:00:00.000Z',
      },
    })
    const result = await pullAllCards(client)
    expect(result).toEqual({ ok: true, count: 2 })
    const rows = await getClientDb().cards.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('既存 2 件 → pull 3 件で replace (元 2 件は消える)', async () => {
    await getClientDb().cards.bulkPut([
      fakeClientCard({ id: 'old-1' }),
      fakeClientCard({ id: 'old-2' }),
    ])
    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        cards: [
          fakeClientCard({ id: 'new-1' }),
          fakeClientCard({ id: 'new-2' }),
          fakeClientCard({ id: 'new-3' }),
        ],
        now: '2026-05-26T03:00:00.000Z',
      },
    })
    await pullAllCards(client)
    const rows = await getClientDb().cards.toArray()
    expect(rows.map((r) => r.id).sort()).toEqual(['new-1', 'new-2', 'new-3'])
  })

  it('HTTP 500: cards / sync_meta いずれも不変', async () => {
    await getClientDb().cards.bulkPut([fakeClientCard({ id: 'keep' })])
    const client = mockClient({ ok: false, status: 500, body: null })
    const result = await pullAllCards(client)
    expect(result).toEqual({ ok: false, count: 0 })
    const rows = await getClientDb().cards.toArray()
    expect(rows.map((r) => r.id)).toEqual(['keep'])
    expect(await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)).toBeUndefined()
  })

  it('fetch throw (network 不通): silent return + 不変', async () => {
    await getClientDb().cards.bulkPut([fakeClientCard({ id: 'keep' })])
    const client: PullApiClient = {
      get: vi.fn().mockRejectedValue(new Error('network')),
    }
    const result = await pullAllCards(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)).toBeUndefined()
  })

  it('response body shape 不正 (cards が array でない): silent fail + 不変', async () => {
    await getClientDb().cards.bulkPut([fakeClientCard({ id: 'keep' })])
    const client = mockClient({
      ok: true,
      status: 200,
      body: { cards: 'not-array', now: '2026-05-26T04:00:00.000Z' } as never,
    })
    const result = await pullAllCards(client)
    expect(result).toEqual({ ok: false, count: 0 })
    expect(await getClientDb().cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)).toBeUndefined()
  })
})
