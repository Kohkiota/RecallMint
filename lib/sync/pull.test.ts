// pull delta orchestrator test (統合 /api/pull 増分 merge)。
// fake-indexeddb 経由で実 Dexie を動かし、 DI client mock で server response を制御。
// 7 観点: upsert merge / tombstone bulkDelete / cursor read→path / cursor write /
// cursor 据え置き / 失敗時不変性 / 0件全null。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getClientDb, type ClientCard, type ClientExam } from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta } from './sync-meta'
import { pullDelta, type PullApiClient } from './pull'

// ---------------------------------------------------------------------------
// Fake data factories
// ---------------------------------------------------------------------------

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

function fakeClientExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: 'user-1',
    name: 'E',
    question_no_format: null,
    archived_at: null,
    card_count: 0,
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

function fakeTombstone(
  entity_type: 'card' | 'exam',
  entity_id: string,
  deleted_at = '2026-05-27T00:00:00.000Z',
) {
  return { entity_type, entity_id, deleted_at }
}

function emptyResponse(
  overrides?: Partial<{
    cards: ClientCard[]
    exams: ClientExam[]
    tombstones: { entity_type: 'card' | 'exam'; entity_id: string; deleted_at: string }[]
    cursors: { cards: string | null; exams: string | null; tombstone: string | null }
  }>,
) {
  return {
    ok: true as const,
    status: 200,
    body: {
      cards: [] as ClientCard[],
      exams: [] as ClientExam[],
      tombstones: [] as { entity_type: 'card' | 'exam'; entity_id: string; deleted_at: string }[],
      cursors: { cards: null, exams: null, tombstone: null },
      ...overrides,
    },
  }
}

function mockClient(
  response: Awaited<ReturnType<PullApiClient['get']>>,
): PullApiClient {
  return { get: vi.fn().mockResolvedValue(response) }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const db = getClientDb()
  await Promise.all([db.cards.clear(), db.exams.clear(), db.sync_meta.clear()])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pullDelta', () => {
  // 観点 1a: 増分 merge upsert — cards
  it('既存 cards に対し upsert (clear されない): old-1 更新 + new-3 追加、 old-2 残存', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClientCard({ id: 'old-1', title: 'old-title' }),
      fakeClientCard({ id: 'old-2', title: 'old-2-title' }),
    ])

    const client = mockClient(
      emptyResponse({
        cards: [
          fakeClientCard({ id: 'old-1', title: 'new-title' }),
          fakeClientCard({ id: 'new-3', title: 'new-3-title' }),
        ],
        cursors: { cards: '2026-05-27T01:00:00.000Z', exams: null, tombstone: null },
      }),
    )
    const result = await pullDelta(client)
    expect(result).toEqual({ ok: true, cardCount: 2, examCount: 0, tombstoneCount: 0 })

    const rows = await db.cards.toArray()
    const ids = rows.map((r) => r.id).sort()
    expect(ids).toEqual(['new-3', 'old-1', 'old-2'])
    expect(rows.find((r) => r.id === 'old-1')?.title).toBe('new-title')
    expect(rows.find((r) => r.id === 'old-2')?.title).toBe('old-2-title')
  })

  // 観点 1b: 増分 merge upsert — exams
  it('既存 exams に対し upsert (clear されない): old-e1 更新 + new-e3 追加、 old-e2 残存', async () => {
    const db = getClientDb()
    await db.exams.bulkPut([
      fakeClientExam({ id: 'old-e1', name: 'old-name' }),
      fakeClientExam({ id: 'old-e2', name: 'old-e2-name' }),
    ])

    const client = mockClient(
      emptyResponse({
        exams: [
          fakeClientExam({ id: 'old-e1', name: 'new-name' }),
          fakeClientExam({ id: 'new-e3', name: 'new-e3-name' }),
        ],
        cursors: { cards: null, exams: '2026-05-27T02:00:00.000Z', tombstone: null },
      }),
    )
    const result = await pullDelta(client)
    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 2, tombstoneCount: 0 })

    const rows = await db.exams.toArray()
    const ids = rows.map((r) => r.id).sort()
    expect(ids).toEqual(['new-e3', 'old-e1', 'old-e2'])
    expect(rows.find((r) => r.id === 'old-e1')?.name).toBe('new-name')
  })

  // 観点 2: tombstone bulkDelete
  it('tombstone で card c2 と exam e1 が mirror から削除される', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([
      fakeClientCard({ id: 'c1' }),
      fakeClientCard({ id: 'c2' }),
    ])
    await db.exams.bulkPut([fakeClientExam({ id: 'e1' })])

    const client = mockClient(
      emptyResponse({
        tombstones: [
          fakeTombstone('card', 'c2'),
          fakeTombstone('exam', 'e1'),
        ],
        cursors: { cards: null, exams: null, tombstone: '2026-05-27T03:00:00.000Z' },
      }),
    )
    const result = await pullDelta(client)
    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 2 })

    const cardIds = (await db.cards.toArray()).map((r) => r.id)
    expect(cardIds).toEqual(['c1'])
    const examIds = (await db.exams.toArray()).map((r) => r.id)
    expect(examIds).toEqual([])
  })

  // 観点 3a: cursor read → since param 付き path
  it('sync_meta に 3 cursor あれば ?since_cards=..&since_exams=..&since_tombstone=.. を含む path で呼ばれる', async () => {
    const db = getClientDb()
    await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: '2026-05-10T00:00:00.000Z' })
    await db.sync_meta.put({ key: SYNC_META_KEYS.examsCursor, value: '2026-05-11T00:00:00.000Z' })
    await db.sync_meta.put({ key: SYNC_META_KEYS.tombstoneCursor, value: '2026-05-12T00:00:00.000Z' })

    const client = mockClient(emptyResponse())
    await pullDelta(client)

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledPath).toContain('since_cards=2026-05-10T00%3A00%3A00.000Z')
    expect(calledPath).toContain('since_exams=2026-05-11T00%3A00%3A00.000Z')
    expect(calledPath).toContain('since_tombstone=2026-05-12T00%3A00%3A00.000Z')
  })

  // 観点 3b: cursor 全無し時は param 無し path
  it('sync_meta に cursor なければ param なし /api/pull で呼ばれる', async () => {
    const client = mockClient(emptyResponse())
    await pullDelta(client)

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledPath).toBe('/api/pull')
  })

  // 観点 4: cursor write 非 null
  it('レスポンス cursors 3本非 null → sync_meta の 3 cursor key が更新される', async () => {
    const client = mockClient(
      emptyResponse({
        cursors: {
          cards: '2026-05-27T10:00:00.000Z',
          exams: '2026-05-27T11:00:00.000Z',
          tombstone: '2026-05-27T12:00:00.000Z',
        },
      }),
    )
    await pullDelta(client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-27T10:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.examsCursor)).toBe('2026-05-27T11:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.tombstoneCursor)).toBe('2026-05-27T12:00:00.000Z')
  })

  // 観点 5: cursor 据え置き null
  it('cardsCursor を put 済 + レスポンス cursors.cards=null → cardsCursor は旧値のまま', async () => {
    const db = getClientDb()
    await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: '2026-05-05T00:00:00.000Z' })

    const client = mockClient(
      emptyResponse({
        cursors: { cards: null, exams: '2026-05-27T11:00:00.000Z', tombstone: null },
      }),
    )
    await pullDelta(client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-05T00:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.examsCursor)).toBe('2026-05-27T11:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.tombstoneCursor)).toBeUndefined()
  })

  // 観点 6a: 失敗時不変性 — client throw
  it('client throw: {ok:false,...0}、cards/exams/sync_meta 全不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.exams.bulkPut([fakeClientExam({ id: 'keep-e' })])
    await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: '2026-05-01T00:00:00.000Z' })

    const client: PullApiClient = { get: vi.fn().mockRejectedValue(new Error('network')) }
    const result = await pullDelta(client)

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await db.exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-01T00:00:00.000Z')
  })

  // 観点 6b: 失敗時不変性 — {ok:false,status:500,body:null}
  it('{ok:false,status:500,body:null}: {ok:false,...0}、全不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: '2026-05-01T00:00:00.000Z' })

    const client = mockClient({ ok: false, status: 500, body: null })
    const result = await pullDelta(client)

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-01T00:00:00.000Z')
  })

  // 観点 6c: 失敗時不変性 — body.cards 非 array
  it('body.cards 非 array: {ok:false,...0}、全不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: '2026-05-01T00:00:00.000Z' })

    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        cards: 'not-array',
        exams: [],
        tombstones: [],
        cursors: { cards: null, exams: null, tombstone: null },
      } as never,
    })
    const result = await pullDelta(client)

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-01T00:00:00.000Z')
  })

  // 観点 7: 0件全null — mirror 不変・cursor 不変・{ok:true,...0}
  it('cards/exams/tombstones 空 + cursors 全 null → mirror 不変・cursor 不変・{ok:true,...0}', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'existing-c' })])
    await db.exams.bulkPut([fakeClientExam({ id: 'existing-e' })])
    await db.sync_meta.put({ key: SYNC_META_KEYS.cardsCursor, value: '2026-05-01T00:00:00.000Z' })

    const client = mockClient(emptyResponse())
    const result = await pullDelta(client)

    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await db.exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-01T00:00:00.000Z')
  })
})
