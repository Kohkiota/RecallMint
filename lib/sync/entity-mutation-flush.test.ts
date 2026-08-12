// entity-mutation-flush + flushAllPendingEntityMutations の test (S-sync-1 で旧
// card-mutation-flush を汎用化、 挙動不変)。 fake-indexeddb 経由で実 Dexie を動かし、
// BulkApiClient injection で server を stub する。 review-flush.test.ts /
// review-events.test.ts と同方式。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb, type ClientMediaAsset } from '@/lib/client-db'
import {
  enqueueEntityMutation,
  getPendingEntityMutations,
  flushAllPendingEntityMutations,
  collectBlockedImageMutationIds,
  inFlightMutationIds,
  newId,
} from './entity-mutations'
import {
  runGuardedEntityMutationFlush,
  ENTITY_MUTATION_FLUSH_LOCK_NAME,
} from './entity-mutation-flush'
import type { BulkApiClient, FlushResult } from './review-events'
import type { FlushOutcome } from './review-flush'
import type { ClientEntityMutation } from '@/lib/client-db'

// 各 test の前に entity_mutations / media_assets table と inFlightMutationIds を clear。
beforeEach(async () => {
  const db = getClientDb()
  await db.entity_mutations.clear()
  await db.media_assets.clear()
  inFlightMutationIds.clear()
})

// ---------------------------------------------------------------------------
// helpers (画像フェーズ A Task 7)
// ---------------------------------------------------------------------------

function makeMediaAsset(overrides: Partial<ClientMediaAsset> = {}): ClientMediaAsset {
  return {
    id: newId(),
    user_id: 'user-1',
    status: 'uploading',
    mime: 'image/webp',
    byte_size: 1000,
    width: 100,
    height: 100,
    hash: 'hash-1',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeImagesMutation(
  keys: string[],
  overrides: Partial<ClientEntityMutation> = {},
): ClientEntityMutation {
  return {
    entity_type: 'card',
    entity_id: newId(),
    op: 'update_field',
    patch: {
      field: 'images',
      value: keys.map((key) => ({ key, target: 'question_text', alt: '' })),
    },
    mutation_id: newId(),
    edited_at: new Date().toISOString(),
    sync_status: 'pending',
    ...overrides,
  } as ClientEntityMutation
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeMockClient(
  response: Awaited<ReturnType<BulkApiClient['post']>>,
): BulkApiClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    post: async (payload) => {
      calls.push(payload)
      return response
    },
  }
}

function fakeLocks(grant: boolean) {
  const calls: { name: string; ifAvailable: boolean | undefined }[] = []
  return {
    calls,
    request: (
      name: string,
      options: { ifAvailable?: boolean },
      cb: (lock: unknown) => Promise<FlushOutcome>,
    ): Promise<FlushOutcome> => {
      calls.push({ name, ifAvailable: options.ifAvailable })
      return Promise.resolve(grant ? cb({ name }) : cb(null))
    },
  }
}

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — pending なし
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — pending なし', () => {
  it('pending 0 件 → 空配列を返す (POST しない)', async () => {
    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)
    expect(results).toEqual([])
    expect(client.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — 全件成功
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — 全件成功', () => {
  it('pending 2 件 → 全 mutation を synced 化', async () => {
    const m1 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'A' },
    })
    const m2 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'B' },
    })

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.syncedEventIds.sort()).toEqual([m1.mutation_id, m2.mutation_id].sort())
    expect(r.failedEventIds).toEqual([])
    expect(r.httpStatus).toBe(200)

    // Dexie 側: 全件 synced
    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(0)

    const all = await getClientDb().entity_mutations.toArray()
    for (const row of all) {
      expect(row.sync_status).toBe('synced')
    }
  })

  it('payload は mutations 配列で送られる', async () => {
    const cardId = newId()
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: cardId,
      op: 'update_field',
      patch: { field: 'title', value: 'Test' },
    })

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    await flushAllPendingEntityMutations(client)

    expect(client.calls).toHaveLength(1)
    const payload = client.calls[0] as {
      mutations: Array<{
        mutation_id: string
        entity_type: 'card', entity_id: string
        op: string
        patch: Record<string, unknown>
        edited_at: string
      }>
    }
    expect(payload.mutations).toHaveLength(1)
    expect(payload.mutations[0].mutation_id).toBe(m.mutation_id)
    expect(payload.mutations[0].entity_id).toBe(cardId)
    expect(payload.mutations[0].op).toBe('update_field')
    expect(payload.mutations[0].patch).toEqual({ field: 'title', value: 'Test' })
  })

  it('flush 後に last_attempted_at が打刻される', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'X' },
    })
    expect(m.last_attempted_at ?? null).toBeNull()

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    await flushAllPendingEntityMutations(client)

    const stored = await getClientDb().entity_mutations
      .where('mutation_id')
      .equals(m.mutation_id)
      .first()
    expect(stored!.last_attempted_at).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — 部分失敗
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — 部分失敗', () => {
  it('body.failed に含まれる mutation は pending 残置、 それ以外は synced', async () => {
    const m1 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'OK' },
    })
    const m2 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'Fail' },
    })

    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [m2.mutation_id] },
    })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.syncedEventIds).toEqual([m1.mutation_id])
    expect(r.failedEventIds).toEqual([m2.mutation_id])

    // synced 分は synced
    const syncedRow = await getClientDb().entity_mutations
      .where('mutation_id')
      .equals(m1.mutation_id)
      .first()
    expect(syncedRow!.sync_status).toBe('synced')

    // failed 分は pending のまま (次回 flush で再試行)
    const pendingAfter = await getPendingEntityMutations()
    expect(pendingAfter.map((r) => r.mutation_id)).toEqual([m2.mutation_id])
  })
})

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — network / HTTP 失敗
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — network / HTTP 失敗', () => {
  it('network 断 (ok=false, status=0) → 何も synced 化しない、 pending 残置', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'X' },
    })

    const client = makeMockClient({ ok: false, status: 0, body: null })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.syncedEventIds).toEqual([])
    expect(r.failedEventIds).toEqual([m.mutation_id])
    expect(r.httpStatus).toBe(0)

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
  })

  it('5xx エラー → pending 残置', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'delete',
      patch: {},
    })

    const client = makeMockClient({ ok: false, status: 503, body: null })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    expect(results[0].httpStatus).toBe(503)
    expect(results[0].syncedEventIds).toEqual([])
    expect(results[0].failedEventIds).toEqual([m.mutation_id])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
  })

  it('429 → pending 残置、 httpStatus=429 (classifyFlushResults が rate-limited に分類)', async () => {
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'Y' },
    })

    const client = makeMockClient({ ok: false, status: 429, body: null })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    expect(results[0].httpStatus).toBe(429)
    expect(results[0].syncedEventIds).toEqual([])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
    // classifyFlushResults による分類確認は runGuardedEntityMutationFlush test で担当
  })

  it('4xx (400) → pending 残置', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Z' },
    })

    const client = makeMockClient({ ok: false, status: 400, body: null })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    expect(results[0].httpStatus).toBe(400)
    expect(results[0].syncedEventIds).toEqual([])
    expect(results[0].failedEventIds).toEqual([m.mutation_id])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// collectBlockedImageMutationIds (画像フェーズ A Task 7: flush gate — pure helper)
// ---------------------------------------------------------------------------

describe('collectBlockedImageMutationIds', () => {
  it('images mutation の value に uploading key を含む → blocked', () => {
    const uploadingId = newId()
    const m = makeImagesMutation([uploadingId])
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(true)
  })

  it('images mutation の keys が全て ready (uploadingAssetIds に無い) → not blocked', () => {
    const readyId = newId()
    const m = makeImagesMutation([readyId])
    // uploadingAssetIds は空 (readyId は uploading 中ではない)
    const blocked = collectBlockedImageMutationIds([m], new Set())
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('cross-device: local に行が無い UUID key (pull 由来) → not blocked', () => {
    const pullDerivedId = newId()
    const m = makeImagesMutation([pullDerivedId])
    // pullDerivedId は local media_assets に一切行が無い (uploadingAssetIds にも無い)。
    // 別 device で添付済 = server 側で ready 保証されているため gate しない。
    const blocked = collectBlockedImageMutationIds([m], new Set(['some-other-uploading-id']))
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('非 images mutation (title update_field) → not blocked', () => {
    const uploadingId = newId()
    const m: ClientEntityMutation = {
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Some title' },
      mutation_id: newId(),
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    }
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('非 images mutation (create op) → not blocked', () => {
    const uploadingId = newId()
    const m: ClientEntityMutation = {
      entity_type: 'card',
      entity_id: newId(),
      op: 'create',
      patch: {
        exam_id: newId(),
        title: 'T',
        sort_key: null,
        question_text: 'Q',
        options: [],
        explanation_text: null,
        memo: null,
      },
      mutation_id: newId(),
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    } as ClientEntityMutation
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('非 images mutation (tag_option update_field) → not blocked', () => {
    const uploadingId = newId()
    const m: ClientEntityMutation = {
      entity_type: 'tag_option',
      entity_id: newId(),
      op: 'update_field',
      patch: { field: 'name', value: 'Some tag' },
      mutation_id: newId(),
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    } as ClientEntityMutation
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('mixed keys (uploading 1 件 + ready 1 件) → blocked (1 件でも uploading があれば block)', () => {
    const uploadingId = newId()
    const readyId = newId()
    const m = makeImagesMutation([uploadingId, readyId])
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(true)
  })

  it('防御: patch.value が非配列 → not blocked (crash しない)', () => {
    const uploadingId = newId()
    const m: ClientEntityMutation = {
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: { field: 'images', value: 'not-an-array' },
      mutation_id: newId(),
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    } as ClientEntityMutation
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('防御: patch.value 配列に null / primitive entry → throw せず not blocked (flush 全体を巻き添えにしない)', () => {
    const uploadingId = newId()
    const m: ClientEntityMutation = {
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      // 壊れた entry (null / string / number / object-without-key) の混在
      patch: { field: 'images', value: [null, 'str', 42, {}] },
      mutation_id: newId(),
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    } as ClientEntityMutation
    // null.key を読んで throw しないこと + block しないこと
    expect(() =>
      collectBlockedImageMutationIds([m], new Set([uploadingId])),
    ).not.toThrow()
    const blocked = collectBlockedImageMutationIds([m], new Set([uploadingId]))
    expect(blocked.has(m.mutation_id)).toBe(false)
  })

  it('防御: patch 自体が null/非 object (corrupted row) → throw せず not blocked', () => {
    const uploadingId = newId()
    const mNull = {
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: null,
      mutation_id: newId(),
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    } as unknown as ClientEntityMutation
    expect(() =>
      collectBlockedImageMutationIds([mNull], new Set([uploadingId])),
    ).not.toThrow()
    expect(
      collectBlockedImageMutationIds([mNull], new Set([uploadingId])).has(
        mNull.mutation_id,
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — images gate 統合 (画像フェーズ A Task 7)
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — images gate', () => {
  it('参照 asset が uploading 中 → images mutation は POST されず pending 残置', async () => {
    const db = getClientDb()
    const uploadingId = newId()
    await db.media_assets.put(makeMediaAsset({ id: uploadingId, status: 'uploading' }))

    const cardId = newId()
    const imagesMutation = await enqueueEntityMutation({
      entity_type: 'card',
      entity_id: cardId,
      op: 'update_field',
      patch: {
        field: 'images',
        value: [{ key: uploadingId, target: 'question_text', alt: '' }],
      },
    })

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)

    // 送信対象が無いため flush 自体が no-op (空配列、 POST されない)
    expect(results).toEqual([])
    expect(client.calls).toHaveLength(0)

    // pending のまま残置される
    const pending = await getPendingEntityMutations()
    expect(pending.map((m) => m.mutation_id)).toEqual([imagesMutation.mutation_id])
  })

  it('asset が ready 化された後の flush → images mutation が POST される', async () => {
    const db = getClientDb()
    const uploadingId = newId()
    await db.media_assets.put(makeMediaAsset({ id: uploadingId, status: 'uploading' }))

    const cardId = newId()
    const imagesMutation = await enqueueEntityMutation({
      entity_type: 'card',
      entity_id: cardId,
      op: 'update_field',
      patch: {
        field: 'images',
        value: [{ key: uploadingId, target: 'question_text', alt: '' }],
      },
    })

    // 最初の flush: まだ uploading → held back
    const clientBlocked = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    await flushAllPendingEntityMutations(clientBlocked)
    expect(clientBlocked.calls).toHaveLength(0)

    // finalize: status を ready 化
    await db.media_assets.update(uploadingId, { status: 'ready' })

    // 次の flush: 送信される
    const clientReady = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(clientReady)

    expect(clientReady.calls).toHaveLength(1)
    const payload = clientReady.calls[0] as { mutations: Array<{ mutation_id: string }> }
    expect(payload.mutations.map((m) => m.mutation_id)).toEqual([imagesMutation.mutation_id])

    expect(results).toHaveLength(1)
    expect(results[0].syncedEventIds).toEqual([imagesMutation.mutation_id])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(0)
  })

  it('gate は非 images mutation に影響しない: uploading 中でも並走 title mutation は両方の flush で POST される', async () => {
    const db = getClientDb()
    const uploadingId = newId()
    await db.media_assets.put(makeMediaAsset({ id: uploadingId, status: 'uploading' }))

    const imagesMutation = await enqueueEntityMutation({
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: {
        field: 'images',
        value: [{ key: uploadingId, target: 'question_text', alt: '' }],
      },
    })
    const titleMutation = await enqueueEntityMutation({
      entity_type: 'card',
      entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Concurrent title edit' },
    })

    // 1 回目 flush: uploading 中 → title のみ送信される
    const client1 = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results1 = await flushAllPendingEntityMutations(client1)
    expect(client1.calls).toHaveLength(1)
    const payload1 = client1.calls[0] as { mutations: Array<{ mutation_id: string }> }
    expect(payload1.mutations.map((m) => m.mutation_id)).toEqual([titleMutation.mutation_id])
    expect(results1[0].syncedEventIds).toEqual([titleMutation.mutation_id])

    // images mutation はまだ pending
    let pending = await getPendingEntityMutations()
    expect(pending.map((m) => m.mutation_id)).toEqual([imagesMutation.mutation_id])

    // ready 化 → 2 回目 flush で images mutation も送信される
    await db.media_assets.update(uploadingId, { status: 'ready' })
    const client2 = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results2 = await flushAllPendingEntityMutations(client2)
    expect(client2.calls).toHaveLength(1)
    const payload2 = client2.calls[0] as { mutations: Array<{ mutation_id: string }> }
    expect(payload2.mutations.map((m) => m.mutation_id)).toEqual([imagesMutation.mutation_id])
    expect(results2[0].syncedEventIds).toEqual([imagesMutation.mutation_id])

    pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — in-flight guard
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — in-flight guard', () => {
  it('inFlightMutationIds に居る mutation はスキップ → 空配列を返す', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Inflight' },
    })
    // 手動で in-flight に登録 (別の並走 flush が掴んでいる状態を再現)
    inFlightMutationIds.add(m.mutation_id)

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)

    // 全件が in-flight 中 → POST しない
    expect(results).toEqual([])
    expect(client.calls).toHaveLength(0)
  })

  it('flush 完了後は inFlightMutationIds から解放される', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Release' },
    })

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    await flushAllPendingEntityMutations(client)

    // flush 完了後は Set から消えている
    expect(inFlightMutationIds.has(m.mutation_id)).toBe(false)
  })

  it('POST 失敗時も inFlightMutationIds から解放される (finally で必ず解放)', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'FailRelease' },
    })

    const client = makeMockClient({ ok: false, status: 503, body: null })
    await flushAllPendingEntityMutations(client)

    expect(inFlightMutationIds.has(m.mutation_id)).toBe(false)
  })

  it('複数 pending のうち一部が in-flight → in-flight 以外だけ送る', async () => {
    const m1 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Inflight' },
    })
    const m2 = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'memo', value: 'Free' },
    })

    // m1 だけ in-flight
    inFlightMutationIds.add(m1.mutation_id)

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    // m2 のみ送られる
    expect(results[0].syncedEventIds).toEqual([m2.mutation_id])
    expect(client.calls).toHaveLength(1)

    const payload = client.calls[0] as { mutations: Array<{ mutation_id: string }> }
    expect(payload.mutations).toHaveLength(1)
    expect(payload.mutations[0].mutation_id).toBe(m2.mutation_id)
  })
})

// ---------------------------------------------------------------------------
// runGuardedEntityMutationFlush — Web Locks 排他
// ---------------------------------------------------------------------------

describe('runGuardedEntityMutationFlush — Web Locks 排他', () => {
  it('lock 取得成功 → lock 内で flushAll を実行し classifyFlushResults で分類', async () => {
    const flushAll = async (): Promise<FlushResult[]> => [
      {
        syncedEventIds: ['mut-1'],
        failedEventIds: [],
        httpStatus: 200,
      },
    ]
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({ flushAll, locks })

    expect(outcome).toBe('ok')
    expect(locks.calls[0].name).toBe(ENTITY_MUTATION_FLUSH_LOCK_NAME)
    expect(locks.calls[0].ifAvailable).toBe(true)
  })

  it('lock 取得失敗 (他タブ保持) → flush せず即 lock-busy', async () => {
    let flushCalled = false
    const flushAll = async (): Promise<FlushResult[]> => {
      flushCalled = true
      return []
    }
    const locks = fakeLocks(false)
    const outcome = await runGuardedEntityMutationFlush({ flushAll, locks })

    expect(outcome).toBe('lock-busy')
    expect(flushCalled).toBe(false)
  })

  it('navigator.locks 非対応 (locks=undefined) → lock なしで直接 flush', async () => {
    const flushAll = async (): Promise<FlushResult[]> => [
      {
        syncedEventIds: ['mut-1'],
        failedEventIds: [],
        httpStatus: 200,
      },
    ]
    const outcome = await runGuardedEntityMutationFlush({ flushAll, locks: undefined })
    expect(outcome).toBe('ok')
  })

  it('pending なし → no-pending', async () => {
    const flushAll = async (): Promise<FlushResult[]> => []
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({ flushAll, locks })
    expect(outcome).toBe('no-pending')
  })
})

// ---------------------------------------------------------------------------
// runGuardedEntityMutationFlush — classifyFlushResults 経由の分類
// ---------------------------------------------------------------------------

describe('runGuardedEntityMutationFlush — classifyFlushResults 経由の分類', () => {
  function makeFlushWithStatus(httpStatus: number, mutId = 'mut-x'): () => Promise<FlushResult[]> {
    return async () => [
      {
        syncedEventIds: [],
        failedEventIds: [mutId],
        httpStatus,
      },
    ]
  }

  it('429 → rate-limited (CLAUDE.md §AI 5: 429 受信で即停止)', async () => {
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({
      flushAll: makeFlushWithStatus(429),
      locks,
    })
    expect(outcome).toBe('rate-limited')
  })

  it('5xx → transient', async () => {
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({
      flushAll: makeFlushWithStatus(503),
      locks,
    })
    expect(outcome).toBe('transient')
  })

  it('network 断 (httpStatus=0) → transient', async () => {
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({
      flushAll: makeFlushWithStatus(0),
      locks,
    })
    expect(outcome).toBe('transient')
  })

  it('4xx (400) → permanent (自動 retry しない)', async () => {
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({
      flushAll: makeFlushWithStatus(400),
      locks,
    })
    expect(outcome).toBe('permanent')
  })

  it('全件 synced → ok', async () => {
    const locks = fakeLocks(true)
    const outcome = await runGuardedEntityMutationFlush({
      flushAll: async () => [
        {
          syncedEventIds: ['mut-a', 'mut-b'],
          failedEventIds: [],
          httpStatus: 200,
        },
      ],
      locks,
    })
    expect(outcome).toBe('ok')
  })

  it('lock 名が ENTITY_MUTATION_FLUSH_LOCK_NAME と一致する', async () => {
    const locks = fakeLocks(true)
    await runGuardedEntityMutationFlush({ flushAll: async () => [], locks })
    expect(locks.calls[0].name).toBe('recallmint:entity-mutations:flush')
  })
})
