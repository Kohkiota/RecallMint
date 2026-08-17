// pull delta orchestrator test (統合 /api/pull 増分 merge)。
// fake-indexeddb 経由で実 Dexie を動かし、 DI client mock で server response を制御。
// 7 観点: upsert merge / tombstone bulkDelete / cursor read→path / cursor write /
// cursor 据え置き / 失敗時不変性 / 0件全null。
// + runGuardedPull 4 観点: lock granted / lock busy / fallback / in-flight coalesce。
// + S-local-2 Task 4 (spec §5): cursor namespace (6 stream 全数) / userId capture /
//   空 userId fail-closed / owner echo 4 観点。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getClientDb,
  type ClientCard,
  type ClientExam,
  type ClientTagCategory,
  type ClientTagOption,
  type ClientCardTag,
} from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta, scopedSyncMetaKey, type SyncMetaKey } from './sync-meta'
import { pullDelta, type PullApiClient, runGuardedPull, PULL_LOCK_NAME } from './pull'
import type { PullDeltaResult, PullGuardOutcome } from './pull'

// USER_A は fake factory の既定 user_id と同値 (owner 行検証を通すため)。
const USER_A = 'user-1'
const USER_B = 'user-2'

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

type EmptyResponseOverrides = Partial<{
  owner_user_id: string
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
}>

function emptyResponse(overrides?: EmptyResponseOverrides) {
  const { cursors: cursorOverrides, ...rest } = overrides ?? {}
  return {
    ok: true as const,
    status: 200,
    body: {
      owner_user_id: USER_A,
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
    const result = await pullDelta(USER_A, client)
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
    const result = await pullDelta(USER_A, client)
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
    const result = await pullDelta(USER_A, client)
    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 2, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })

    const cardIds = (await db.cards.toArray()).map((r) => r.id)
    expect(cardIds).toEqual(['c1'])
    const examIds = (await db.exams.toArray()).map((r) => r.id)
    expect(examIds).toEqual([])
  })

  // 観点 3a: cursor read → since param 付き path
  it('sync_meta に 3 cursor あれば ?since_cards=..&since_exams=..&since_tombstone=.. を含む path で呼ばれる', async () => {
    const db = getClientDb()
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A), value: '2026-05-10T00:00:00.000Z' })
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.examsCursor, USER_A), value: '2026-05-11T00:00:00.000Z' })
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.tombstoneCursor, USER_A), value: '2026-05-12T00:00:00.000Z' })

    const client = mockClient(emptyResponse())
    await pullDelta(USER_A, client)

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledPath).toContain('since_cards=2026-05-10T00%3A00%3A00.000Z')
    expect(calledPath).toContain('since_exams=2026-05-11T00%3A00%3A00.000Z')
    expect(calledPath).toContain('since_tombstone=2026-05-12T00%3A00%3A00.000Z')
  })

  // 観点 3b: cursor 全無し時は param 無し path
  it('sync_meta に cursor なければ param なし /api/pull で呼ばれる', async () => {
    const client = mockClient(emptyResponse())
    await pullDelta(USER_A, client)

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
    await pullDelta(USER_A, client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-05-27T10:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.examsCursor, USER_A)).toBe('2026-05-27T11:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.tombstoneCursor, USER_A)).toBe('2026-05-27T12:00:00.000Z')
  })

  // 観点 5: cursor 据え置き null
  it('cardsCursor を put 済 + レスポンス cursors.cards=null → cardsCursor は旧値のまま', async () => {
    const db = getClientDb()
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A), value: '2026-05-05T00:00:00.000Z' })

    const client = mockClient(
      emptyResponse({
        cursors: { cards: null, exams: '2026-05-27T11:00:00.000Z', tombstone: null },
      }),
    )
    await pullDelta(USER_A, client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-05-05T00:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.examsCursor, USER_A)).toBe('2026-05-27T11:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.tombstoneCursor, USER_A)).toBeUndefined()
  })

  // 観点 6a: 失敗時不変性 — client throw
  it('client throw: {ok:false,...0}、cards/exams/sync_meta 全不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.exams.bulkPut([fakeClientExam({ id: 'keep-e' })])
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A), value: '2026-05-01T00:00:00.000Z' })

    const client: PullApiClient = { get: vi.fn().mockRejectedValue(new Error('network')) }
    const result = await pullDelta(USER_A, client)

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await db.exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-05-01T00:00:00.000Z')
  })

  // 観点 6b: 失敗時不変性 — {ok:false,status:500,body:null}
  it('{ok:false,status:500,body:null}: {ok:false,...0}、全不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A), value: '2026-05-01T00:00:00.000Z' })

    const client = mockClient({ ok: false, status: 500, body: null })
    const result = await pullDelta(USER_A, client)

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-05-01T00:00:00.000Z')
  })

  // 観点 6c: 失敗時不変性 — body.cards 非 array
  it('body.cards 非 array: {ok:false,...0}、全不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A), value: '2026-05-01T00:00:00.000Z' })

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
    const result = await pullDelta(USER_A, client)

    expect(result).toEqual({ ok: false, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-05-01T00:00:00.000Z')
  })

  // 観点 7: 0件全null — mirror 不変・cursor 不変・{ok:true,...0}
  it('cards/exams/tombstones 空 + cursors 全 null → mirror 不変・cursor 不変・{ok:true,...0}', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'existing-c' })])
    await db.exams.bulkPut([fakeClientExam({ id: 'existing-e' })])
    await db.sync_meta.put({ key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A), value: '2026-05-01T00:00:00.000Z' })

    const client = mockClient(emptyResponse())
    const result = await pullDelta(USER_A, client)

    expect(result).toEqual({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 })
    expect(await db.cards.count()).toBe(1)
    expect(await db.exams.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-05-01T00:00:00.000Z')
  })

  // ===========================================================================
  // Tag-2b: card_tags 取り直し経路 (案 a)
  // ===========================================================================

  // 観点 8a: 取り直し経路 — c1 の旧 card_tags が削除され、 新集合で置換される。
  // 本 test の前提 = server 契約 I-1 (spec 2026-08-17-card-tags-delta-completeness-design):
  // 「cards に載った card について、 応答 card_tags のその card への projection は
  //  by-card SELECT 時点の authoritative 集合と *一致* する」。 payload の c1 分は
  //  増分ではなく c1 の全集合であり、 だから (2) の全削除 → (3) の bulkPut が正しい。
  //  この契約が無い間、 delta は変更 card の古いタグを含まず恒久欠落を起こしていた。
  it('cards 増分に c1 → c1 の旧 card_tags 全削除 + payload の authoritative 集合で置換。 他 card は不変', async () => {
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
    const result = await pullDelta(USER_A, client)
    expect(result.ok).toBe(true)
    expect(result.cardTagCount).toBe(1)

    const rows = await db.card_tags.toArray()
    const pairs = rows
      .map((r) => `${r.card_id}:${r.option_id}`)
      .sort()
    // c1 の旧 (o1, o2) は消えて c1:o3 に置換、 c2:o3 は不変
    expect(pairs).toEqual(['c1:o3', 'c2:o3'])
  })

  // 観点 8b: 空集合化 (案 a の核心) — server が card_tags=[] を返す whole-set 縮小。
  // I-1 の下で「c1 の authoritative 集合が空」を意味する (増分が空なのではない)。
  it('cards 増分に c1 + card_tags=[] (c1 の authoritative 集合が空) → c1 の card_tags 0 件', async () => {
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
    const result = await pullDelta(USER_A, client)
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
    const result = await pullDelta(USER_A, client)
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
    const result = await pullDelta(USER_A, client)
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
    const result = await pullDelta(USER_A, client)
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
    await pullDelta(USER_A, client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor, USER_A)).toBe(
      '2026-06-01T10:00:00.000Z',
    )
  })

  // 観点 8g: card_tags cursor 据え置き — レスポンス cursors.card_tags=null → 旧値のまま
  it('cardTagsCursor を put 済 + cursors.card_tags=null → cardTagsCursor は旧値のまま', async () => {
    const db = getClientDb()
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.cardTagsCursor, USER_A),
      value: '2026-05-01T00:00:00.000Z',
    })

    const client = mockClient(emptyResponse())
    await pullDelta(USER_A, client)

    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor, USER_A)).toBe(
      '2026-05-01T00:00:00.000Z',
    )
  })

  // 観点 8h: cursor read → since_card_tags param 付き path
  it('sync_meta に cardTagsCursor あれば ?since_card_tags=.. を含む path で呼ばれる', async () => {
    const db = getClientDb()
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.cardTagsCursor, USER_A),
      value: '2026-05-20T00:00:00.000Z',
    })

    const client = mockClient(emptyResponse())
    await pullDelta(USER_A, client)

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledPath).toContain('since_card_tags=2026-05-20T00%3A00%3A00.000Z')
  })

  // 観点 8i: 失敗時不変性 — card_tags 非 array → FAIL + card_tags mirror 不変
  it('body.card_tags 非 array: {ok:false,...0}、card_tags mirror も不変', async () => {
    const db = getClientDb()
    await db.card_tags.bulkPut([fakeClientCardTag({ card_id: 'keep', option_id: 'k' })])
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.cardTagsCursor, USER_A),
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
    const result = await pullDelta(USER_A, client)

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
    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor, USER_A)).toBe(
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
    await pullDelta(USER_A, client)

    const rows = await db.card_tags.where('card_id').equals('c1').toArray()
    expect(rows.map((r) => r.option_id)).toEqual(['o-new'])
  })
})

// ---------------------------------------------------------------------------
// S-local-2 Task 4: cursor namespace / capture / fail-closed / owner echo
// ---------------------------------------------------------------------------

// 6 stream の (cursor base key, since query param 名, response cursors field) 対応表。
// 全 stream 一括で pin することで「1 本だけ namespace 化し忘れる」 退行を捕まえる。
const CURSOR_STREAMS: {
  base: SyncMetaKey
  since: string
  responseKey: 'cards' | 'exams' | 'tombstone' | 'tag_categories' | 'tag_options' | 'card_tags'
  seed: string
  next: string
}[] = [
  { base: SYNC_META_KEYS.cardsCursor, since: 'since_cards', responseKey: 'cards', seed: '2026-05-01T00:00:00.000Z', next: '2026-06-01T00:00:00.000Z' },
  { base: SYNC_META_KEYS.examsCursor, since: 'since_exams', responseKey: 'exams', seed: '2026-05-02T00:00:00.000Z', next: '2026-06-02T00:00:00.000Z' },
  { base: SYNC_META_KEYS.tombstoneCursor, since: 'since_tombstone', responseKey: 'tombstone', seed: '2026-05-03T00:00:00.000Z', next: '2026-06-03T00:00:00.000Z' },
  { base: SYNC_META_KEYS.tagCategoriesCursor, since: 'since_tag_categories', responseKey: 'tag_categories', seed: '2026-05-04T00:00:00.000Z', next: '2026-06-04T00:00:00.000Z' },
  { base: SYNC_META_KEYS.tagOptionsCursor, since: 'since_tag_options', responseKey: 'tag_options', seed: '2026-05-05T00:00:00.000Z', next: '2026-06-05T00:00:00.000Z' },
  { base: SYNC_META_KEYS.cardTagsCursor, since: 'since_card_tags', responseKey: 'card_tags', seed: '2026-05-06T00:00:00.000Z', next: '2026-06-06T00:00:00.000Z' },
]

// 6 stream すべての next-cursor を非 null で返す response 用 helper。
function allNextCursors(): NonNullable<EmptyResponseOverrides['cursors']> {
  return {
    cards: CURSOR_STREAMS[0]!.next,
    exams: CURSOR_STREAMS[1]!.next,
    tombstone: CURSOR_STREAMS[2]!.next,
    tag_categories: CURSOR_STREAMS[3]!.next,
    tag_options: CURSOR_STREAMS[4]!.next,
    card_tags: CURSOR_STREAMS[5]!.next,
  }
}

async function seedAllCursorsFor(userId: string): Promise<void> {
  const db = getClientDb()
  for (const s of CURSOR_STREAMS) {
    await db.sync_meta.put({ key: scopedSyncMetaKey(s.base, userId), value: s.seed })
  }
}

function calledPathOf(client: PullApiClient): string {
  return (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
}

describe('pullDelta — cursor namespace (pin ①)', () => {
  it('A の cursor 6 本 seed 下で pullDelta(A) は 6 本すべての since_* を送る', async () => {
    await seedAllCursorsFor(USER_A)
    const client = mockClient(emptyResponse())

    await pullDelta(USER_A, client)

    const path = calledPathOf(client)
    for (const s of CURSOR_STREAMS) {
      expect(path, `${s.since} が欠落`).toContain(`${s.since}=${encodeURIComponent(s.seed)}`)
    }
  })

  it('A の cursor 6 本 seed 下で pullDelta(B) は since を 1 本も送らない (自然に full pull)', async () => {
    await seedAllCursorsFor(USER_A)
    const client = mockClient(emptyResponse({ owner_user_id: USER_B }))

    await pullDelta(USER_B, client)

    // B の namespace には cursor が無い = param なしの素の path になる。
    expect(calledPathOf(client)).toBe('/api/pull')
  })

  it('pullDelta(B) の cursor write は 6 本とも B の namespace に行き、 A の 6 本は不変', async () => {
    await seedAllCursorsFor(USER_A)
    const db = getClientDb()
    const client = mockClient(
      emptyResponse({ owner_user_id: USER_B, cursors: allNextCursors() }),
    )

    await pullDelta(USER_B, client)

    for (const s of CURSOR_STREAMS) {
      expect(await getSyncMeta(s.base, USER_B), `${s.base} が B の namespace に書かれていない`).toBe(s.next)
      expect(await getSyncMeta(s.base, USER_A), `${s.base} の A の値が上書きされた`).toBe(s.seed)
    }
    // 名前空間なしの旧 key に書き戻していないことも確認 (base 素キーは誰も読まない)。
    for (const s of CURSOR_STREAMS) {
      expect(await db.sync_meta.get(s.base)).toBeUndefined()
    }
  })
})

describe('pullDelta — userId capture (pin ②・spec §5.1 凍結)', () => {
  it('A の fetch 解決前に B の pull を interleave しても、 A の invocation は A の key に書く', async () => {
    const db = getClientDb()
    // A の client: 解決を手動で遅延させる (pending 中に B を走らせるため)。
    let resolveA!: (v: Awaited<ReturnType<PullApiClient['get']>>) => void
    const pendingA = new Promise<Awaited<ReturnType<PullApiClient['get']>>>((resolve) => {
      resolveA = resolve
    })
    const clientA: PullApiClient = { get: vi.fn(() => pendingA) }
    const clientB = mockClient(
      emptyResponse({
        owner_user_id: USER_B,
        cursors: { cards: '2026-07-02T00:00:00.000Z' },
      }),
    )

    // A を開始 (fetch pending のまま) → B を完走させる。
    const pA = pullDelta(USER_A, clientA)
    await pullDelta(USER_B, clientB)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_B)).toBe('2026-07-02T00:00:00.000Z')

    // 遅れて A の応答が着地する。
    resolveA(emptyResponse({ cursors: { cards: '2026-07-01T00:00:00.000Z' } }))
    await pA

    // A は自分が capture した namespace にのみ書き、 B の値は汚れない。
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe('2026-07-01T00:00:00.000Z')
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_B)).toBe('2026-07-02T00:00:00.000Z')
    expect(await db.sync_meta.get(SYNC_META_KEYS.cardsCursor)).toBeUndefined()
  })
})

describe('pullDelta — 空 userId fail-closed (pin ③)', () => {
  it("pullDelta('') は FAIL を返し client.get を呼ばず Dexie にも触れない", async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'keep-c' })])
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A),
      value: '2026-05-01T00:00:00.000Z',
    })
    const client = mockClient(emptyResponse())

    const result = await pullDelta('', client)

    expect(result).toEqual({
      ok: false,
      cardCount: 0,
      examCount: 0,
      tombstoneCount: 0,
      tagCategoryCount: 0,
      tagOptionCount: 0,
      cardTagCount: 0,
    })
    expect(client.get).not.toHaveBeenCalled()
    expect(await db.cards.count()).toBe(1)
    expect(await db.sync_meta.count()).toBe(1)
  })
})

describe('pullDelta — owner echo (pin ⑤・spec §5.1a)', () => {
  // (a) echo 不一致 + payload 空: 行検証は素通りするので echo だけが reject 根拠になる。
  it('(a) owner_user_id 不一致 + payload 空 → FAIL・cursor 不変', async () => {
    await seedAllCursorsFor(USER_A)
    const client = mockClient(
      emptyResponse({
        owner_user_id: USER_B,
        cursors: { cards: '2026-07-10T00:00:00.000Z' },
      }),
    )

    const result = await pullDelta(USER_A, client)

    expect(result.ok).toBe(false)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe(
      CURSOR_STREAMS[0]!.seed,
    )
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_B)).toBeUndefined()
  })

  // (b) tombstone-only: ClientTombstone は user_id を持たず行検証が原理的に不能。
  //     この経路を守れるのは echo だけであることの実証。
  it('(b) tombstone-only 応答の owner_user_id 不一致 → FAIL・mirror / cursor 不変', async () => {
    const db = getClientDb()
    await db.cards.bulkPut([fakeClientCard({ id: 'c-keep' })])
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.tombstoneCursor, USER_A),
      value: '2026-05-03T00:00:00.000Z',
    })
    const client = mockClient(
      emptyResponse({
        owner_user_id: USER_B,
        tombstones: [fakeTombstone('card', 'c-keep')],
        cursors: { tombstone: '2026-07-11T00:00:00.000Z' },
      }),
    )

    const result = await pullDelta(USER_A, client)

    expect(result.ok).toBe(false)
    // tombstone が適用されていない = mirror 不変。
    expect(await db.cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.tombstoneCursor, USER_A)).toBe(
      '2026-05-03T00:00:00.000Z',
    )
  })

  // (c) field 欠落 (旧 server / emptyBody 相当) も不一致と同じく reject する。
  it('(c) owner_user_id field 欠落 → FAIL・cursor 不変', async () => {
    await seedAllCursorsFor(USER_A)
    const base = emptyResponse({ cursors: { cards: '2026-07-12T00:00:00.000Z' } })
    const { owner_user_id: _omit, ...bodyWithoutOwner } = base.body
    const client = mockClient({
      ok: true,
      status: 200,
      body: bodyWithoutOwner as never,
    })

    const result = await pullDelta(USER_A, client)

    expect(result.ok).toBe(false)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe(
      CURSOR_STREAMS[0]!.seed,
    )
  })

  // (d) echo は一致していても行に異 owner が混ざれば全体 reject。 owner 列を持つ
  //     5 stream を全数 pin する (1 stream だけ検証を落とす退行を捕まえるため)。
  const FOREIGN_ROW_CASES: { label: string; payload: EmptyResponseOverrides }[] = [
    { label: 'cards', payload: { cards: [fakeClientCard({ id: 'x', user_id: USER_B })] } },
    { label: 'exams', payload: { exams: [fakeClientExam({ id: 'x', user_id: USER_B })] } },
    {
      label: 'tag_categories',
      payload: {
        tag_categories: [
          {
            id: 'tc-x',
            user_id: USER_B,
            name: 'n',
            select_type: 'single',
            created_at: '2026-05-01T00:00:00.000Z',
            updated_at: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    },
    {
      label: 'tag_options',
      payload: {
        tag_options: [
          {
            id: 'to-x',
            user_id: USER_B,
            category_id: 'tc-1',
            name: 'n',
            created_at: '2026-05-01T00:00:00.000Z',
            updated_at: '2026-05-01T00:00:00.000Z',
          },
        ],
      },
    },
    {
      label: 'card_tags',
      payload: { card_tags: [fakeClientCardTag({ card_id: 'cx', user_id: USER_B })] },
    },
  ]

  for (const c of FOREIGN_ROW_CASES) {
    it(`(d) ${c.label} に異 owner 行が 1 行混入 → FAIL・mirror 不変・cursor 不変`, async () => {
      const db = getClientDb()
      await seedAllCursorsFor(USER_A)
      const client = mockClient(
        emptyResponse({ ...c.payload, cursors: allNextCursors() }),
      )

      const result = await pullDelta(USER_A, client)

      expect(result.ok).toBe(false)
      // mirror は 5 store とも空のまま (bulkPut が 1 件も走っていない)。
      expect(await db.cards.count()).toBe(0)
      expect(await db.exams.count()).toBe(0)
      expect(await db.tag_categories.count()).toBe(0)
      expect(await db.tag_options.count()).toBe(0)
      expect(await db.card_tags.count()).toBe(0)
      // cursor 6 本も seed 値のまま。
      for (const s of CURSOR_STREAMS) {
        expect(await getSyncMeta(s.base, USER_A)).toBe(s.seed)
      }
    })
  }

  it('正常系: owner_user_id 一致 + 全行 self-owned なら従来どおり適用される', async () => {
    const db = getClientDb()
    const client = mockClient(
      emptyResponse({
        cards: [fakeClientCard({ id: 'c-ok', user_id: USER_A })],
        cursors: { cards: '2026-07-20T00:00:00.000Z' },
      }),
    )

    const result = await pullDelta(USER_A, client)

    expect(result.ok).toBe(true)
    expect(await db.cards.count()).toBe(1)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe(
      '2026-07-20T00:00:00.000Z',
    )
  })
})

// ---------------------------------------------------------------------------
// cursor CAS (spec §3)
// ---------------------------------------------------------------------------

// fetch の解決を手動制御する client。 pending の間に sync_meta を書き換えることで、
// 「cursor 読取 (§1) → network → apply tx」 の窓に purge / sweep が挟まる状況を作る。
function deferredClient(): {
  client: PullApiClient
  resolve: (v: Awaited<ReturnType<PullApiClient['get']>>) => void
} {
  let resolve!: (v: Awaited<ReturnType<PullApiClient['get']>>) => void
  const pending = new Promise<Awaited<ReturnType<PullApiClient['get']>>>((r) => {
    resolve = r
  })
  return { client: { get: vi.fn(() => pending) }, resolve }
}

// client.get 到達 = §1 の cursor snapshot 採取済。 これを待ってから sync_meta を
// 動かすことで「窓の中で動いた」 ことを (競合順序に依存せず) 確定させる。
async function awaitFetchStarted(client: PullApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.get).toHaveBeenCalled())
}

// CAS 検証用の apply payload。 CAS が無ければ cards 1 件が mirror に載り cursor 6 本が
// next へ前進する = abort 時の「mirror / cursor 不変」 assertion が vacuous にならない。
function casApplyResponse() {
  return emptyResponse({
    cards: [fakeClientCard({ id: 'cas-c', user_id: USER_A })],
    cursors: allNextCursors(),
  })
}

describe('pullDelta — cursor CAS (pin ⑦・spec §3)', () => {
  // (a) 消失: purge / sweep が窓中に sync_meta を消した場合。 ここで apply すると
  //     空になった mirror に旧 cursor 由来の delta が乗り、 新 cursor で delta 継続に
  //     なる = purge で消えた行が永続的に silent 欠落する。
  it('(a) 窓中に cursor 6 本が purge される (消失) → abort・mirror 不変・cursor 再生成なし', async () => {
    const db = getClientDb()
    await seedAllCursorsFor(USER_A)
    const { client, resolve } = deferredClient()

    const pending = pullDelta(USER_A, client)
    await awaitFetchStarted(client)
    // snapshot は purge 前の seed 値で採られている (送信 path がその証拠)。
    expect(calledPathOf(client)).toContain(
      `since_cards=${encodeURIComponent(CURSOR_STREAMS[0]!.seed)}`,
    )
    await db.sync_meta.clear()

    resolve(casApplyResponse())
    const result = await pending

    expect(result.ok).toBe(false)
    expect(await db.cards.count()).toBe(0)
    // cursor は 1 本も再生成されない (next が着地すると欠落が永続化する)。
    expect(await db.sync_meta.count()).toBe(0)
  })

  // (b) 変化: 6 stream を全数 pin する (1 本だけ CAS 比較を落とす退行を捕まえるため。
  //     owner 行検証の 5 stream 全数 pin と同じ趣旨)。
  for (const s of CURSOR_STREAMS) {
    it(`(b) 窓中に ${s.base} が別値へ前進 (変化) → abort・mirror / cursor 不変`, async () => {
      const db = getClientDb()
      await seedAllCursorsFor(USER_A)
      const moved = '2026-07-31T00:00:00.000Z'
      const { client, resolve } = deferredClient()

      const pending = pullDelta(USER_A, client)
      await awaitFetchStarted(client)
      await db.sync_meta.put({ key: scopedSyncMetaKey(s.base, USER_A), value: moved })

      resolve(casApplyResponse())
      const result = await pending

      expect(result.ok).toBe(false)
      expect(await db.cards.count()).toBe(0)
      // 動いた 1 本は窓中の値のまま、 残り 5 本は seed のまま = next が 1 本も書かれない。
      for (const other of CURSOR_STREAMS) {
        expect(
          await getSyncMeta(other.base, USER_A),
          `${other.base} が上書きされた`,
        ).toBe(other.base === s.base ? moved : other.seed)
      }
    })
  }

  // (c) 出現: purge 直後に始まった full pull (snapshot 全 undefined) の窓中に、 別の
  //     full pull が完走して cursor を再生成した状況。 snapshot 側が undefined でも
  //     「不在 → 現在値あり」 は不一致として扱う。
  it('(c) full pull (snapshot 全 undefined) の窓中に cursor が再生成される (出現) → abort・mirror 不変', async () => {
    const db = getClientDb()
    const appeared = '2026-08-01T00:00:00.000Z'
    const { client, resolve } = deferredClient()

    const pending = pullDelta(USER_A, client)
    await awaitFetchStarted(client)
    // snapshot が全 undefined であることの証拠 (since_* を 1 本も送っていない)。
    expect(calledPathOf(client)).toBe('/api/pull')
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.cardTagsCursor, USER_A),
      value: appeared,
    })

    resolve(casApplyResponse())
    const result = await pending

    expect(result.ok).toBe(false)
    expect(await db.cards.count()).toBe(0)
    // 出現した 1 本は窓中の値のまま、 他 5 本は不在のまま。
    expect(await getSyncMeta(SYNC_META_KEYS.cardTagsCursor, USER_A)).toBe(appeared)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBeUndefined()
    expect(await db.sync_meta.count()).toBe(1)
  })

  // (d) abort は tx 例外で実現されるが、 既存の silent FAIL 契約へ正規化される
  //     (caller へ reject が漏れない + 件数は 0 に潰れる)。
  it('(d) abort は例外として外へ漏れず FAIL (全 count 0) へ正規化される', async () => {
    const db = getClientDb()
    await seedAllCursorsFor(USER_A)
    const { client, resolve } = deferredClient()

    const pending = pullDelta(USER_A, client)
    await awaitFetchStarted(client)
    await db.sync_meta.delete(scopedSyncMetaKey(SYNC_META_KEYS.examsCursor, USER_A))

    // CAS が無ければ {ok:true, cardCount:1, ...} になる payload。
    resolve(casApplyResponse())

    await expect(pending).resolves.toEqual({
      ok: false,
      cardCount: 0,
      examCount: 0,
      tombstoneCount: 0,
      tagCategoryCount: 0,
      tagOptionCount: 0,
      cardTagCount: 0,
    })
  })

  // (e) 回復分岐 ①: 消失で abort した後、 次 trigger は cursor 不在ゆえ自然に full pull。
  it('(e) 消失 abort の後続 pull は since 無しの full pull になる', async () => {
    const db = getClientDb()
    await seedAllCursorsFor(USER_A)
    const { client, resolve } = deferredClient()

    const pending = pullDelta(USER_A, client)
    await awaitFetchStarted(client)
    await db.sync_meta.clear()
    resolve(casApplyResponse())
    expect((await pending).ok).toBe(false)

    const nextClient = mockClient(emptyResponse())
    const nextResult = await pullDelta(USER_A, nextClient)

    expect(nextResult.ok).toBe(true)
    expect(calledPathOf(nextClient)).toBe('/api/pull')
  })

  // (f) CAS 以外の tx 例外まで FAIL へ丸めない (IndexedDB 障害が無音化すると
  //     mirror 破損の検知経路が消える)。 CAS 導入前からの挙動の据え置き pin。
  it('(f) CAS 以外の tx 例外は FAIL に丸めず caller へ伝播する', async () => {
    const db = getClientDb()
    const boom = new Error('idb failure')
    const spy = vi.spyOn(db.cards, 'bulkPut').mockImplementation(() => {
      throw boom
    })
    try {
      const client = mockClient(
        emptyResponse({ cards: [fakeClientCard({ id: 'c-x', user_id: USER_A })] }),
      )
      await expect(pullDelta(USER_A, client)).rejects.toBe(boom)
    } finally {
      spy.mockRestore()
    }
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

    const outcome = await runGuardedPull({ userId: USER_A, pull, locks })

    expect(outcome).toBe('ran')
    expect(pull).toHaveBeenCalledTimes(1)
    expect(locks.calls[0]).toEqual({ name: PULL_LOCK_NAME, ifAvailable: true })
  })

  // 観点 2: ifAvailable skip (lock busy) → 'lock-busy'、 pull 未実行
  it('lock busy → outcome "lock-busy"、 pull 未実行', async () => {
    const pull = vi.fn(async (): Promise<PullDeltaResult> => ({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 }))
    const locks = fakeLocks(false)

    const outcome = await runGuardedPull({ userId: USER_A, pull, locks })

    expect(outcome).toBe('lock-busy')
    expect(pull).not.toHaveBeenCalled()
  })

  // 観点 3: fallback (locks: undefined) → 'ran'、 pull 1 回 (lock 経由しない)
  it('locks: undefined fallback → outcome "ran"、 pull 1 回', async () => {
    const pull = vi.fn(async (): Promise<PullDeltaResult> => ({ ok: true, cardCount: 0, examCount: 0, tombstoneCount: 0, tagCategoryCount: 0, tagOptionCount: 0, cardTagCount: 0 }))

    const outcome = await runGuardedPull({ userId: USER_A, pull, locks: undefined })

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
    const p1 = runGuardedPull({ userId: USER_A, pull, locks })

    // 2 本目: 1 本目の pull が pending の間に同期的に呼ぶ → inflight-skip
    const outcome2 = await runGuardedPull({ userId: USER_A, pull, locks })
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
    const outcome3 = await runGuardedPull({ userId: USER_A, pull, locks: locks2 })
    expect(outcome3).toBe('ran')
    expect(pull).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// runGuardedPull → pullDelta の userId 受け渡し (pin ⑥・spec §5.1 capture 原則)
// ---------------------------------------------------------------------------

// 上の runGuardedPull 4 本は全て deps.pull を注入するため、 default 分岐
// (`deps.pull ?? (() => pullDelta(deps.userId))`) が一度も実行されない。 そこは
// pullDelta の唯一の production caller (11 箇所の runGuardedPull が全て通る) であり、
// 誤った userId を渡す退行は typecheck (arity と string 性しか見ない) でも既存 test でも
// 検出できない。 deps.pull を注入せず defaultClient (global fetch) 経由で走らせ、
// cursor の read / write が共に deps.userId の namespace で起きることを固定する。
describe('runGuardedPull — pullDelta への userId 受け渡し (pin ⑥)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deps.pull 未注入時、 cursor は deps.userId (B) の namespace で read / write される', async () => {
    const db = getClientDb()
    const seedA = '2026-05-01T00:00:00.000Z'
    const nextB = '2026-08-16T00:00:00.000Z'
    // A の cursor だけ seed。 B の pull がこれを read/write に使ったら退行。
    await db.sync_meta.put({
      key: scopedSyncMetaKey(SYNC_META_KEYS.cardsCursor, USER_A),
      value: seedA,
    })

    let calledPath = ''
    const fetchMock = vi.fn(async (input: string) => {
      calledPath = input
      const { body } = emptyResponse({
        owner_user_id: USER_B,
        cursors: { cards: nextB },
      })
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await runGuardedPull({ userId: USER_B, locks: fakeLocks(true) })

    expect(outcome).toBe('ran')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // read: B の namespace に cursor は無い → since_* を 1 本も乗せない素の path。
    // (A を capture していたら since_cards が乗る)
    expect(calledPath).toBe('/api/pull')
    // write: B の namespace にのみ着地し、 A の値は不変。
    // (誤った userId を capture すると owner echo 不一致で FAIL → nextB が書かれない)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_B)).toBe(nextB)
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor, USER_A)).toBe(seedA)
  })
})
