// pull delta orchestrator test (統合 /api/pull 増分 merge)。
// fake-indexeddb 経由で実 Dexie を動かし、 DI client mock で server response を制御。
// 7 観点: upsert merge / tombstone bulkDelete / cursor read→path / cursor write /
// cursor 据え置き / 失敗時不変性 / 0件全null。
// + runGuardedPull 4 観点: lock granted / lock busy / fallback / in-flight coalesce。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getClientDb,
  type ClientCard,
  type ClientExam,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta } from './sync-meta'
import { pullDelta, type PullApiClient, runGuardedPull, PULL_LOCK_NAME } from './pull'
import type { PullDeltaResult, PullGuardOutcome } from './pull'

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
    question_label: null,
    base_order: 1024,
    question_text: 'Q',
    options: [],
    correct_answer_ids: [],
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

function fakeClientExam(overrides?: Partial<ClientExam>): ClientExam {
  return {
    id: 'exam-1',
    user_id: 'user-1',
    name: 'E',
    content_version: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    ...overrides,
  }
}

type TombstoneEntityType = 'card' | 'exam' | 'tag_category' | 'tag_option'

function fakeTombstone(
  entity_type: TombstoneEntityType,
  entity_id: string,
  deleted_at = '2026-05-27T00:00:00.000Z',
) {
  return { entity_type, entity_id, deleted_at }
}

function fakeClientCardTag(overrides?: Partial<ClientCardTag>): ClientCardTag {
  return {
    card_id: 'c1',
    option_id: 'o1',
    user_id: 'user-1',
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function emptyResponse(
  overrides?: Partial<{
    cards: ClientCard[]
    exams: ClientExam[]
    tombstones: { entity_type: TombstoneEntityType; entity_id: string; deleted_at: string }[]
    tag_categories: ClientTagCategory[]
    tag_options: ClientTagOption[]
    card_tags: ClientCardTag[]
    cursors: Partial<{
      cards: string | null
      exams: string | null
      tombstone: string | null
      tag_categories: string | null
      tag_options: string | null
      card_tags: string | null
    }>
  }>,
) {
  const { cursors: cursorOverrides, ...rest } = overrides ?? {}
  return {
    ok: true as const,
    status: 200,
    body: {
      cards: [] as ClientCard[],
      exams: [] as ClientExam[],
      tombstones: [] as {
        entity_type: TombstoneEntityType
        entity_id: string
        deleted_at: string
      }[],
      tag_categories: [] as ClientTagCategory[],
      tag_options: [] as ClientTagOption[],
      card_tags: [] as ClientCardTag[],
      ...rest,
      cursors: {
        cards: null,
        exams: null,
        tombstone: null,
        tag_categories: null,
        tag_options: null,
        card_tags: null,
        ...(cursorOverrides ?? {}),
      },
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
  await Promise.all([
    db.cards.clear(),
    db.exams.clear(),
    db.tag_categories.clear(),
    db.tag_options.clear(),
    db.card_tags.clear(),
    db.sync_meta.clear(),
  ])
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
    expect(result).toEqual({ ok: true, cardCount: 2, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })

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
    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 2, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })

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
    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 2, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })

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

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
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

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
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

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
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

    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await db.exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('2026-05-01T00:00:00.000Z')
  })

  // ===========================================================================
  // Tag-2b: card_tags 取り直し経路 (案 a)
  // ===========================================================================

  // 観点 8a: 取り直し経路 — c1 の旧 card_tags が削除され、 新集合で置換される
  it('cards 増分に c1 → c1 の旧 card_tags 全削除 + 新集合 bulkPut。 他 card は不変', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([
      fakeClientCardTag({ card_id: 'c1', option_id: 'o1' }),
      fakeClientCardTag({ card_id: 'c1', option_id: 'o2' }),
      fakeClientCardTag({ card_id: 'c2', option_id: 'o3' }),
    ])

    const client = mockClient(
      emptyResponse({
        cards: [fakeClientCard({ id: 'c1' })],
        card_tags: [
          fakeClientCardTag({ card_id: 'c1', option_id: 'o3' }),
        ],
        cursors: { card_tags: '2026-06-01T01:00:00.000Z' },
      }),
    )
    const result = await pullDelta(client)
    expect(result.ok).toBe(true)
    expect(result.cardTagCount).toBe(1)

    const rows = await db.card_tags.toArray()
    const pairs = rows
      .map((r) => `${r.card_id}:${r.option_id}`)
      .sort()
    // c1 の旧 (o1, o2) は消えて c1:o3 に置換、 c2:o3 は不変
    expect(pairs).toEqual(['c1:o3', 'c2:o3'])
  })

  // 観点 8b: 空集合化 (案 a の核心) — server が card_tags=[] を返す whole-set 縮小
  it('cards 増分に c1 + card_tags=[] → c1 の card_tags 0 件 (空集合化)', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([
      fakeClientCardTag({ card_id: 'c1', option_id: 'o1' }),
      fakeClientCardTag({ card_id: 'c1', option_id: 'o2' }),
    ])

    const client = mockClient(
      emptyResponse({
        cards: [fakeClientCard({ id: 'c1' })],
        card_tags: [], // whole-set 空に置換
      }),
    )
    const result = await pullDelta(client)
    expect(result.ok).toBe(true)

    const c1Rows = await db.card_tags.where('card_id').equals('c1').toArray()
    expect(c1Rows).toEqual([])
  })

  // 観点 8c: 変更カード集合 0 件 → card_tags の旧行は不変 (delete スキップ)
  it('cards=[] + card_tags=[] → 既存 card_tags は不変', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([
      fakeClientCardTag({ card_id: 'c1', option_id: 'o1' }),
      fakeClientCardTag({ card_id: 'c2', option_id: 'o2' }),
    ])

    const client = mockClient(emptyResponse())
    const result = await pullDelta(client)
    expect(result.ok).toBe(true)

    expect(await db.card_tags.count()).toBe(2)
  })

  // 観点 8d: cascade purge — tag_option 削除起点
  it('tombstone (tag_option=o1) → o1 紐付け card_tags が全削除される', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([
      fakeClientCardTag({ card_id: 'c1', option_id: 'o1' }),
      fakeClientCardTag({ card_id: 'c2', option_id: 'o1' }),
      fakeClientCardTag({ card_id: 'c3', option_id: 'o2' }),
    ])

    const client = mockClient(
      emptyResponse({
        tombstones: [fakeTombstone('tag_option', 'o1')],
        cursors: { tombstone: '2026-06-01T02:00:00.000Z' },
      }),
    )
    const result = await pullDelta(client)
    expect(result.ok).toBe(true)

    const rows = await db.card_tags.toArray()
    const pairs = rows.map((r) => `${r.card_id}:${r.option_id}`).sort()
    expect(pairs).toEqual(['c3:o2'])
  })

  // 観点 8e: cascade purge — card 削除起点
  it('tombstone (card=c1) → c1 紐付け card_tags が全削除される', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([
      fakeClientCardTag({ card_id: 'c1', option_id: 'o1' }),
      fakeClientCardTag({ card_id: 'c1', option_id: 'o2' }),
      fakeClientCardTag({ card_id: 'c2', option_id: 'o3' }),
    ])

    const client = mockClient(
      emptyResponse({
        tombstones: [fakeTombstone('card', 'c1')],
        cursors: { tombstone: '2026-06-01T03:00:00.000Z' },
      }),
    )
    const result = await pullDelta(client)
    expect(result.ok).toBe(true)

    const rows = await db.card_tags.toArray()
    const pairs = rows.map((r) => `${r.card_id}:${r.option_id}`).sort()
    expect(pairs).toEqual(['c2:o3'])
  })

  // 観点 8f: card_tags cursor write — レスポンス cursors.card_tags 非 null → sync_meta 更新
  it('cursors.card_tags 非 null → SYNC_META_KEYS.cardTagsCursor が更新される', async () => {
    const client = mockClient(
      emptyResponse({
        cursors: { card_tags: '2026-06-01T10:00:00.000Z' },
      }),
    )
    await pullDelta(client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor)).toBe(
      '2026-06-01T10:00:00.000Z',
    )
  })

  // 観点 8g: card_tags cursor 据え置き — レスポンス cursors.card_tags=null → 旧値のまま
  it('cardTagsCursor を put 済 + cursors.card_tags=null → cardTagsCursor は旧値のまま', async () => {
    const db = getClientDb()
    await db.sync_meta.put({
      key: SYNC_META_KEYS.cardTagsCursor,
      value: '2026-05-01T00:00:00.000Z',
    })

    const client = mockClient(emptyResponse())
    await pullDelta(client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor)).toBe(
      '2026-05-01T00:00:00.000Z',
    )
  })

  // 観点 8h: cursor read → since_card_tags param 付き path
  it('sync_meta に cardTagsCursor あれば ?since_card_tags=.. を含む path で呼ばれる', async () => {
    const db = getClientDb()
    await db.sync_meta.put({
      key: SYNC_META_KEYS.cardTagsCursor,
      value: '2026-05-20T00:00:00.000Z',
    })

    const client = mockClient(emptyResponse())
    await pullDelta(client)

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledPath).toContain('since_card_tags=2026-05-20T00%3A00%3A00.000Z')
  })

  // 観点 8i: 失敗時不変性 — card_tags 非 array → FAIL + card_tags mirror 不変
  it('body.card_tags 非 array: {ok:false,...0}、card_tags mirror も不変', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([fakeClientCardTag({ card_id: 'keep', option_id: 'k' })])
    await db.sync_meta.put({
      key: SYNC_META_KEYS.cardTagsCursor,
      value: '2026-05-01T00:00:00.000Z',
    })

    const client = mockClient({
      ok: true,
      status: 200,
      body: {
        cards: [],
        exams: [],
        tombstones: [],
        tag_categories: [],
        tag_options: [],
        card_tags: 'not-array',
        cursors: {
          cards: null,
          exams: null,
          tombstone: null,
          tag_categories: null,
          tag_options: null,
          card_tags: null,
        },
      } as never,
    })
    const result = await pullDelta(client)

    expect(result).toEqual({
      ok: false,
      cardCount: 0,
      examCount: 0,
      tombstoneCount: 0,
      tagCategoryCount: 0,
      tagOptionCount: 0,
      cardTagCount: 0,
    })
    expect(await db.card_tags.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor)).toBe(
      '2026-05-01T00:00:00.000Z',
    )
  })

  // 観点 8j: 取り直し → bulkPut の順序検証 (案 a の核心、 旧行削除が新行 upsert の前)
  //   cards=[{id:'c1'}]、 card_tags=[{c1, o-new}]、 既存 card_tags=[{c1, o-old}]
  //   結果として c1 の card_tags は {o-new} 1 件であり、 {o-old} は消えていることを確認。
  //   (順序が逆 = bulkPut 後 delete だと {o-new} も巻き添えで消える ⇒ 0 件になる)
  it('取り直し経路の順序: 旧行 delete → 新行 bulkPut の順 (逆順なら新行も消える)', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([
      fakeClientCardTag({ card_id: 'c1', option_id: 'o-old' }),
    ])

    const client = mockClient(
      emptyResponse({
        cards: [fakeClientCard({ id: 'c1' })],
        card_tags: [
          fakeClientCardTag({ card_id: 'c1', option_id: 'o-new' }),
        ],
      }),
    )
    await pullDelta(client)

    const rows = await db.card_tags.where('card_id').equals('c1').toArray()
    expect(rows.map((r) => r.option_id)).toEqual(['o-new'])
  })
})

// ---------------------------------------------------------------------------
// runGuardedPull テスト
// ---------------------------------------------------------------------------

// fakeLocks ヘルパ (review-flush.test.ts の fakeLocks を手本に複製、
// callback 戻り値型を pull.ts の PullGuardOutcome に置き換えたもの)。
function fakeLocks(grant: boolean) {
  const calls: { name: string; ifAvailable: boolean | undefined }[] = []
  return {
    calls,
    request: (
      name: string,
      options: { ifAvailable?: boolean },
      cb: (lock: unknown) => Promise<PullGuardOutcome>,
    ): Promise<PullGuardOutcome> => {
      calls.push({ name, ifAvailable: options.ifAvailable })
      // grant=true: lock オブジェクトを渡す / grant=false: null (他タブ保持中)
      return Promise.resolve(grant ? cb({ name }) : cb(null))
    },
  }
}

describe('runGuardedPull', () => {
  // 観点 1: lock granted → ran、 pull が 1 回実行され PULL_LOCK_NAME + ifAvailable:true で呼ばれる
  it('lock granted → outcome "ran"、 pull mock 1 回、 ifAvailable:true', async () => {
    const pullResult: PullDeltaResult = { ok: true, cardCount: 1, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 }
    const pull = vi.fn(async () => pullResult)
    const locks = fakeLocks(true)

    const outcome = await runGuardedPull({ pull, locks })

    expect(outcome).toBe('ran')
    expect(pull).toHaveBeenCalledTimes(1)
    expect(locks.calls[0]).toEqual({ name: PULL_LOCK_NAME, ifAvailable: true })
  })

  // 観点 2: ifAvailable skip (lock busy) → 'lock-busy'、 pull 未実行
  it('lock busy → outcome "lock-busy"、 pull 未実行', async () => {
    const pull = vi.fn(async (): Promise<PullDeltaResult> => ({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 }))
    const locks = fakeLocks(false)

    const outcome = await runGuardedPull({ pull, locks })

    expect(outcome).toBe('lock-busy')
    expect(pull).not.toHaveBeenCalled()
  })

  // 観点 3: fallback (locks: undefined) → 'ran'、 pull 1 回 (lock 経由しない)
  it('locks: undefined fallback → outcome "ran"、 pull 1 回', async () => {
    const pull = vi.fn(async (): Promise<PullDeltaResult> => ({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 }))

    const outcome = await runGuardedPull({ pull, locks: undefined })

    expect(outcome).toBe('ran')
    expect(pull).toHaveBeenCalledTimes(1)
  })

  // 観点 4: in-flight coalesce — 1 本目 in-flight 中に 2 本目が即 'inflight-skip' を返す。
  // resolve 後は再び 'ran' になる (pullInFlight が false に戻る)。
  it('in-flight 中の 2 本目は即 "inflight-skip"、 resolve 後は再び "ran"', async () => {
    let resolveDeferred!: (v: PullDeltaResult) => void
    const deferred = new Promise<PullDeltaResult>((resolve) => {
      resolveDeferred = resolve
    })
    let callCount = 0
    const pull = vi.fn((): Promise<PullDeltaResult> => {
      callCount += 1
      // 1 回目: pending Promise (in-flight をシミュレート)
      if (callCount === 1) return deferred
      // 2 回目以降: 即解決
      return Promise.resolve({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    })
    const locks = fakeLocks(true)

    // 1 本目: await せずに開始 (in-flight)
    const p1 = runGuardedPull({ pull, locks })

    // 2 本目: 1 本目の pull が pending の間に同期的に呼ぶ → inflight-skip
    const outcome2 = await runGuardedPull({ pull, locks })
    expect(outcome2).toBe('inflight-skip')
    // pull は 1 回しか呼ばれていない
    expect(pull).toHaveBeenCalledTimes(1)

    // 1 本目の pull を resolve → 'ran' で完了
    resolveDeferred({ ok: true, cardCount: 1, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    const outcome1 = await p1
    expect(outcome1).toBe('ran')
    expect(pull).toHaveBeenCalledTimes(1)

    // pullInFlight が false に戻ったので 3 本目は 'ran'
    const locks2 = fakeLocks(true)
    const outcome3 = await runGuardedPull({ pull, locks: locks2 })
    expect(outcome3).toBe('ran')
    expect(pull).toHaveBeenCalledTimes(2)
  })
})
