// entity-mutation-flush + flushAllPendingEntityMutations の test (S-sync-1 で旧
// card-mutation-flush を汎用化、 挙動不変)。 fake-indexeddb 経由で実 Dexie を動かし、
// BulkApiClient injection で server を stub する。 review-flush.test.ts /
// review-events.test.ts と同方式。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import {
  enqueueEntityMutation,
  getPendingEntityMutations,
  flushAllPendingEntityMutations,
  inFlightMutationIds,
  newId,
} from './entity-mutations'
import {
  runGuardedEntityMutationFlush,
  ENTITY_MUTATION_FLUSH_LOCK_NAME,
} from './entity-mutation-flush'
import type { BulkApiClient, FlushResult } from './review-events'
import type { FlushOutcome } from './review-flush'

// 各 test の前に entity_mutations table と inFlightMutationIds を clear。
beforeEach(async () => {
  const db = getClientDb()
  await db.entity_mutations.clear()
  inFlightMutationIds.clear()
})

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
    expect(r.attempted).toBe(2)
    expect(r.syncedEventIds.sort()).toEqual([m1.mutation_id, m2.mutation_id].sort())
    expect(r.failedEventIds).toEqual([])
    expect(r.sessionSynced).toBe(false) // card-mutation に session 概念なし
    expect(r.reachable).toBe(true)
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
    expect(r.reachable).toBe(true)

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
    expect(r.reachable).toBe(false)
    expect(r.httpStatus).toBe(0)

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
  })

  it('5xx エラー → pending 残置、 reachable=true', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'delete',
      patch: {},
    })

    const client = makeMockClient({ ok: false, status: 503, body: null })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    expect(results[0].httpStatus).toBe(503)
    expect(results[0].reachable).toBe(true) // 5xx は API まで届いた
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

  it('4xx (400) → pending 残置、 reachable=true', async () => {
    const m = await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Z' },
    })

    const client = makeMockClient({ ok: false, status: 400, body: null })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    expect(results[0].httpStatus).toBe(400)
    expect(results[0].reachable).toBe(true)
    expect(results[0].syncedEventIds).toEqual([])
    expect(results[0].failedEventIds).toEqual([m.mutation_id])

    const pending = await getPendingEntityMutations()
    expect(pending).toHaveLength(1)
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
    expect(results[0].attempted).toBe(1)
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
        attempted: 1,
        syncedEventIds: ['mut-1'],
        failedEventIds: [],
        sessionSynced: false,
        reachable: true,
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
        attempted: 1,
        syncedEventIds: ['mut-1'],
        failedEventIds: [],
        sessionSynced: false,
        reachable: true,
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
        attempted: 1,
        syncedEventIds: [],
        failedEventIds: [mutId],
        sessionSynced: false,
        reachable: httpStatus >= 400 && httpStatus < 600,
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
          attempted: 2,
          syncedEventIds: ['mut-a', 'mut-b'],
          failedEventIds: [],
          sessionSynced: false,
          reachable: true,
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

// ---------------------------------------------------------------------------
// flushAllPendingEntityMutations — FlushResult shape 適合 (sessionSynced 固定)
// ---------------------------------------------------------------------------

describe('flushAllPendingEntityMutations — FlushResult shape 適合', () => {
  it('sessionSynced は常に false (card-mutation に session 概念なし)', async () => {
    await enqueueEntityMutation({
      entity_type: 'card', entity_id: newId(),
      op: 'update_field',
      patch: { field: 'title', value: 'Check' },
    })
    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEntityMutations(client)

    expect(results).toHaveLength(1)
    expect(results[0].sessionSynced).toBe(false)
  })
})
