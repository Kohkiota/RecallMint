// review-events sync helper の test。 fake-indexeddb 経由で実 Dexie を動かし、
// store の write / read / status 更新を verify する。 server bulk API は
// BulkApiClient injection で stub する。
//
// 対象は FSRS 整合 Sprint A の新形 (spec §3 / §4): owner-scope 選別 → 送信前検証 →
// 1000 件 chunk 逐次 POST → 応答処理。 session 単位の分割・24h drop は存在しない。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import {
  recordAnswerEvent,
  getPendingAnswerEvents,
  countPendingAnswerEvents,
  flushPendingAnswerEvents,
  inFlightEventIds,
  newId,
  type BulkApiClient,
} from './review-events'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'

// 各 test の前に Dexie store を全 clear。 fake-indexeddb 自体は process 越しに
// state を持つので、 .clear() で各 table を空にして isolation を保つ。
// in-flight Set も同様にクリア (hang させた test の後で残ることを防ぐ)。
beforeEach(async () => {
  const db = getClientDb()
  await Promise.all([
    db.answer_events.clear(),
    db.entity_mutations.clear(),
    db.sync_meta.clear(),
    db.cards.clear(),
    db.exams.clear(),
  ])
  inFlightEventIds.clear()
})

// 既定は「そのまま受理」 の bulk client。 payload は calls に積む。
function makeMockClient(
  response: Awaited<ReturnType<BulkApiClient['post']>> = {
    ok: true,
    status: 200,
    body: { ok: true, failed: [] },
  },
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

type SentPayload = {
  events: Array<{
    event_id: string
    card_id: string
    session_id?: string
    rating: number
    elapsed_ms?: number
    origin?: string
  }>
}

function sentEvents(client: { calls: unknown[] }): SentPayload['events'][] {
  return (client.calls as SentPayload[]).map((p) => p.events)
}

// 最小 input。 user_id / session_id / rating は新 wire で必須。
function makeInput(overrides?: Partial<Parameters<typeof recordAnswerEvent>[0]>) {
  return {
    user_id: USER_A,
    session_id: newId(),
    card_id: newId(),
    selected_answer_ids: ['a'],
    is_correct: true,
    rating: 3 as const,
    ...overrides,
  }
}

describe('newId', () => {
  it('v4 UUID 形式の文字列を返す', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})

describe('recordAnswerEvent', () => {
  it('user_id / session_id / rating を保持し sync_status=pending で入る', async () => {
    const sessionId = newId()
    const cardId = newId()
    const event = await recordAnswerEvent(
      makeInput({ session_id: sessionId, card_id: cardId, rating: 2, elapsed_ms: 1_500 }),
    )

    expect(event.sync_status).toBe('pending')
    const stored = await getClientDb().answer_events.where('event_id').equals(event.event_id).first()
    expect(stored).toMatchObject({
      user_id: USER_A,
      session_id: sessionId,
      card_id: cardId,
      rating: 2,
      elapsed_ms: 1_500,
      sync_status: 'pending',
    })
  })

  it('event_id 指定時はそれを使う (冪等キー)', async () => {
    const fixedId = newId()
    const event = await recordAnswerEvent(makeInput({ event_id: fixedId }))
    expect(event.event_id).toBe(fixedId)
  })

  it('elapsed_ms 未指定なら行に key を持たない', async () => {
    const event = await recordAnswerEvent(makeInput())
    const stored = await getClientDb().answer_events.where('event_id').equals(event.event_id).first()
    expect(Object.prototype.hasOwnProperty.call(stored!, 'elapsed_ms')).toBe(false)
  })

  it('origin 指定時はそのまま保持される (Dash-1 Home v1 spec §11.4)', async () => {
    const event = await recordAnswerEvent(makeInput({ origin: 'home_today' }))
    const stored = await getClientDb().answer_events.where('event_id').equals(event.event_id).first()
    expect(stored!.origin).toBe('home_today')
  })

  it('origin 未指定なら行に key を持たない (elapsed_ms と同じ idiom)', async () => {
    const event = await recordAnswerEvent(makeInput())
    const stored = await getClientDb().answer_events.where('event_id').equals(event.event_id).first()
    expect(Object.prototype.hasOwnProperty.call(stored!, 'origin')).toBe(false)
  })
})

describe('getPendingAnswerEvents / countPendingAnswerEvents — owner scope', () => {
  it('他 user の pending は返らない・数えない', async () => {
    const mine = await recordAnswerEvent(makeInput())
    await recordAnswerEvent(makeInput({ user_id: USER_B }))

    const pending = await getPendingAnswerEvents(USER_A)
    expect(pending.map((e) => e.event_id)).toEqual([mine.event_id])
    expect(await countPendingAnswerEvents(USER_A)).toBe(1)
    expect(await countPendingAnswerEvents(USER_B)).toBe(1)
  })

  it('synced / failed は pending に含まれない', async () => {
    const synced = await recordAnswerEvent(makeInput())
    const failed = await recordAnswerEvent(makeInput())
    await getClientDb().answer_events.where('event_id').equals(synced.event_id).modify({ sync_status: 'synced' })
    await getClientDb().answer_events.where('event_id').equals(failed.event_id).modify({ sync_status: 'failed' })

    expect(await countPendingAnswerEvents(USER_A)).toBe(0)
  })

  it('戻り順は record 投入順 (= local_id 昇順 = answered_at 昇順)', async () => {
    // server 側 fold は「payload に乗る順 = 適用順」を前提にする (spec §2.2)。
    // client 側の保証は「record 順で返る」こと。
    const cardId = newId()
    const t = (s: number) => `2026-01-01T00:00:0${s}.000Z`
    const e1 = await recordAnswerEvent(makeInput({ card_id: cardId, answered_at: t(1) }))
    const e2 = await recordAnswerEvent(makeInput({ card_id: cardId, answered_at: t(2) }))
    const e3 = await recordAnswerEvent(makeInput({ card_id: cardId, answered_at: t(3) }))

    const pending = await getPendingAnswerEvents(USER_A)
    expect(pending.map((e) => e.event_id)).toEqual([e1.event_id, e2.event_id, e3.event_id])
    const localIds = pending.map((e) => e.local_id!)
    expect(localIds[0]).toBeLessThan(localIds[1])
    expect(localIds[1]).toBeLessThan(localIds[2])
  })
})

describe('flushPendingAnswerEvents — owner-scope 選別', () => {
  it('自 user の pending だけを送り、他 user の行は synced 化しない', async () => {
    const mine = await recordAnswerEvent(makeInput())
    const others = await recordAnswerEvent(makeInput({ user_id: USER_B }))

    const client = makeMockClient()
    const result = await flushPendingAnswerEvents(USER_A, client)

    expect(sentEvents(client)).toEqual([[expect.objectContaining({ event_id: mine.event_id })]])
    expect(result.syncedEventIds).toEqual([mine.event_id])
    // 他 user の行は pending のまま (flush 開始時に閉じた scope の外)
    expect(await countPendingAnswerEvents(USER_B)).toBe(1)
    const othersRow = await getClientDb().answer_events.where('event_id').equals(others.event_id).first()
    expect(othersRow!.sync_status).toBe('pending')
  })

  it('全件成功 → 対象が synced 化され pending が 0 になる', async () => {
    const e1 = await recordAnswerEvent(makeInput())
    const e2 = await recordAnswerEvent(makeInput())

    const result = await flushPendingAnswerEvents(USER_A, makeMockClient())

    expect(result.syncedEventIds.sort()).toEqual([e1.event_id, e2.event_id].sort())
    expect(result.failedEventIds).toEqual([])
    expect(result.httpStatus).toBe(200)
    expect(await countPendingAnswerEvents(USER_A)).toBe(0)
  })

  it('各 event に session_id が載る (event ごとの label 列・spec §4.4)', async () => {
    const s1 = newId()
    const s2 = newId()
    await recordAnswerEvent(makeInput({ session_id: s1 }))
    await recordAnswerEvent(makeInput({ session_id: s2 }))

    const client = makeMockClient()
    await flushPendingAnswerEvents(USER_A, client)

    expect(sentEvents(client)[0].map((e) => e.session_id)).toEqual([s1, s2])
  })

  it('elapsed_ms は指定時のみ payload に載る', async () => {
    await recordAnswerEvent(makeInput({ elapsed_ms: 4_200 }))
    await recordAnswerEvent(makeInput())

    const client = makeMockClient()
    await flushPendingAnswerEvents(USER_A, client)

    const [withElapsed, without] = sentEvents(client)[0]
    expect(withElapsed.elapsed_ms).toBe(4_200)
    expect(Object.prototype.hasOwnProperty.call(without, 'elapsed_ms')).toBe(false)
  })

  it('origin は指定時のみ payload に載る (elapsed_ms と同じ idiom・spec §11.4)', async () => {
    await recordAnswerEvent(makeInput({ origin: 'custom' }))
    await recordAnswerEvent(makeInput())

    const client = makeMockClient()
    await flushPendingAnswerEvents(USER_A, client)

    const [withOrigin, without] = sentEvents(client)[0]
    expect(withOrigin.origin).toBe('custom')
    expect(Object.prototype.hasOwnProperty.call(without, 'origin')).toBe(false)
  })

  it('pending 0 件では POST しない', async () => {
    const client = makeMockClient()
    const result = await flushPendingAnswerEvents(USER_A, client)

    expect(client.calls).toHaveLength(0)
    expect(result.httpStatus).toBe(0)
  })
})

describe('flushPendingAnswerEvents — 送信前検証 (poison-pill 隔離)', () => {
  it('形式不正 event は送らず failed に terminal 化し、正常分だけ POST する', async () => {
    const ok = await recordAnswerEvent(makeInput())
    // card_id が UUID でない行を直接 seed (共有 schema が reject する形)
    const badId = newId()
    await getClientDb().answer_events.add({
      event_id: badId,
      user_id: USER_A,
      session_id: newId(),
      card_id: 'not-a-uuid',
      selected_answer_ids: [],
      is_correct: false,
      rating: 1,
      answered_at: new Date().toISOString(),
      sync_status: 'pending',
    })

    const client = makeMockClient()
    const result = await flushPendingAnswerEvents(USER_A, client)

    // 不正 event は payload に載らない
    expect(sentEvents(client)).toEqual([[expect.objectContaining({ event_id: ok.event_id })]])
    expect(result.syncedEventIds).toEqual([ok.event_id])
    // 不正 event は 'failed' terminal (以降の flush 対象から外れる)
    const bad = await getClientDb().answer_events.where('event_id').equals(badId).first()
    expect(bad!.sync_status).toBe('failed')
    expect(await countPendingAnswerEvents(USER_A)).toBe(0)
  })

  it('全件不正なら POST しない', async () => {
    await getClientDb().answer_events.add({
      event_id: newId(),
      user_id: USER_A,
      session_id: newId(),
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: true,
      // rating は必須 1-4。 0 は共有 schema が reject する
      rating: 0 as unknown as 1,
      answered_at: new Date().toISOString(),
      sync_status: 'pending',
    })

    const client = makeMockClient()
    await flushPendingAnswerEvents(USER_A, client)

    expect(client.calls).toHaveLength(0)
    expect(await countPendingAnswerEvents(USER_A)).toBe(0)
  })
})

describe('flushPendingAnswerEvents — 1000 件 chunk 逐次', () => {
  // 1000 件超の pending を最小コストで用意する (recordAnswerEvent を n 回呼ぶより速い)。
  async function seedPending(count: number): Promise<void> {
    const now = new Date().toISOString()
    await getClientDb().answer_events.bulkAdd(
      Array.from({ length: count }, () => ({
        event_id: newId(),
        user_id: USER_A,
        session_id: newId(),
        card_id: newId(),
        selected_answer_ids: ['a'],
        is_correct: true,
        rating: 3 as const,
        answered_at: now,
        sync_status: 'pending' as const,
      })),
    )
  }

  it('ちょうど 1000 件 → POST 1 回', async () => {
    await seedPending(1000)
    const client = makeMockClient()
    await flushPendingAnswerEvents(USER_A, client)

    expect(client.calls).toHaveLength(1)
    expect(sentEvents(client)[0]).toHaveLength(1000)
  })

  it('1001 件 → POST 2 回 (1000 + 1)', async () => {
    await seedPending(1001)
    const client = makeMockClient()
    const result = await flushPendingAnswerEvents(USER_A, client)

    expect(client.calls).toHaveLength(2)
    expect(sentEvents(client).map((e) => e.length)).toEqual([1000, 1])
    expect(result.syncedEventIds).toHaveLength(1001)
    expect(await countPendingAnswerEvents(USER_A)).toBe(0)
  })

  it('chunk 1 が失敗したら以降の chunk を送らず中断する (spec §3)', async () => {
    await seedPending(1001)
    const calls: unknown[] = []
    const client: BulkApiClient = {
      post: async (payload) => {
        calls.push(payload)
        return { ok: false, status: 503, body: null }
      },
    }

    const result = await flushPendingAnswerEvents(USER_A, client)

    // 1 回目で中断 (2 回目は送らない)
    expect(calls).toHaveLength(1)
    expect(result.httpStatus).toBe(503)
    expect(result.syncedEventIds).toEqual([])
    // 未送信 chunk を含め全件 pending 残置 (次 trigger が先頭から送り直す)
    expect(await countPendingAnswerEvents(USER_A)).toBe(1001)
  })

  it('chunk 2 が失敗しても chunk 1 の成功分は synced 化される', async () => {
    await seedPending(1001)
    let call = 0
    const client: BulkApiClient = {
      post: async () => {
        call += 1
        return call === 1
          ? { ok: true, status: 200, body: { ok: true, failed: [] } }
          : { ok: false, status: 503, body: null }
      },
    }

    const result = await flushPendingAnswerEvents(USER_A, client)

    expect(result.syncedEventIds).toHaveLength(1000)
    expect(result.failedEventIds).toHaveLength(1)
    expect(await countPendingAnswerEvents(USER_A)).toBe(1)
  })
})

describe('flushPendingAnswerEvents — failed[] terminal 化', () => {
  it('200 の failed[] に載った event は failed になり、次 flush の対象から外れる', async () => {
    const ok = await recordAnswerEvent(makeInput())
    const collided = await recordAnswerEvent(makeInput())

    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [collided.event_id] },
    })
    const result = await flushPendingAnswerEvents(USER_A, client)

    expect(result.syncedEventIds).toEqual([ok.event_id])
    expect(result.failedEventIds).toEqual([collided.event_id])
    const row = await getClientDb().answer_events.where('event_id').equals(collided.event_id).first()
    expect(row!.sync_status).toBe('failed')

    // 次 flush は対象 0 件 = POST しない (再送が構造的に止まる)
    const next = makeMockClient()
    await flushPendingAnswerEvents(USER_A, next)
    expect(next.calls).toHaveLength(0)
  })
})

describe('flushPendingAnswerEvents — 24h drop 撤去', () => {
  it('answered_at が 25h 前でも pending のまま送信される (時間経過で failed 化しない)', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const stale = await recordAnswerEvent(makeInput({ answered_at: old }))

    // flush 前: 時間経過だけでは pending から落ちない
    expect(await countPendingAnswerEvents(USER_A)).toBe(1)

    const client = makeMockClient()
    const result = await flushPendingAnswerEvents(USER_A, client)

    expect(sentEvents(client)[0].map((e) => e.event_id)).toEqual([stale.event_id])
    expect(result.syncedEventIds).toEqual([stale.event_id])
  })

  it('送信失敗した古い event も failed にならず pending 残置 (transient のみが残る)', async () => {
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
    const stale = await recordAnswerEvent(makeInput({ answered_at: old }))

    await flushPendingAnswerEvents(USER_A, makeMockClient({ ok: false, status: 503, body: null }))

    const row = await getClientDb().answer_events.where('event_id').equals(stale.event_id).first()
    expect(row!.sync_status).toBe('pending')
  })
})

describe('flushPendingAnswerEvents — httpStatus (retry 分類用)', () => {
  it('5xx 失敗は応答 status をそのまま載せ、何も synced 化しない', async () => {
    const e1 = await recordAnswerEvent(makeInput())
    const result = await flushPendingAnswerEvents(
      USER_A,
      makeMockClient({ ok: false, status: 503, body: null }),
    )
    expect(result.httpStatus).toBe(503)
    expect(result.failedEventIds).toEqual([e1.event_id])
    expect(result.syncedEventIds).toEqual([])
    expect(await countPendingAnswerEvents(USER_A)).toBe(1)
  })

  it('network 断 (fetch throw) は httpStatus=0', async () => {
    await recordAnswerEvent(makeInput())
    const result = await flushPendingAnswerEvents(
      USER_A,
      makeMockClient({ ok: false, status: 0, body: null }),
    )
    expect(result.httpStatus).toBe(0)
  })

  it('429 は status をそのまま載せる (即停止分類は classifyFlushResults 側)', async () => {
    await recordAnswerEvent(makeInput())
    const result = await flushPendingAnswerEvents(
      USER_A,
      makeMockClient({ ok: false, status: 429, body: null }),
    )
    expect(result.httpStatus).toBe(429)
    expect(await countPendingAnswerEvents(USER_A)).toBe(1)
  })

  it('4xx (400、契約 drift 由来の permanent-4xx) も 503 と同じく chunk 中断・pending 残置 (spec §2 既知例外)', async () => {
    // classify-bulk-error.ts の PERMANENT_PG_CODES 追加で server 側は 400 を返す
    // ようになったが、 client 側の受け手 (この chunk-abort 分岐) は response.ok の
    // 真偽だけで判定するため挙動は不変 — server 修正後の自然 trigger 再送に賭けて
    // pending 残置する既存挙動をこの status 値で pin する。
    const e1 = await recordAnswerEvent(makeInput())
    const result = await flushPendingAnswerEvents(
      USER_A,
      makeMockClient({ ok: false, status: 400, body: null }),
    )
    expect(result.httpStatus).toBe(400)
    expect(result.syncedEventIds).toEqual([])
    expect(await countPendingAnswerEvents(USER_A)).toBe(1)
    const row = await getClientDb().answer_events.where('event_id').equals(e1.event_id).first()
    // synced/failed どちらにも terminal 化されず pending のまま (outbox 削除相当の
    // silent lost write を作らない)。
    expect(row!.sync_status).toBe('pending')
  })
})

describe('flushPendingAnswerEvents — in-flight guard', () => {
  it('並走 flush は in-flight 中の event を再送しない / finally で解放される', async () => {
    const e1 = await recordAnswerEvent(makeInput())

    let releasePost!: (v: Awaited<ReturnType<BulkApiClient['post']>>) => void
    let notifyCalled!: () => void
    const postCalled = new Promise<void>((res) => {
      notifyCalled = res
    })
    const hanging: BulkApiClient = {
      post: () => {
        notifyCalled()
        return new Promise((res) => {
          releasePost = res
        })
      },
    }

    const first = flushPendingAnswerEvents(USER_A, hanging)
    await postCalled
    expect(inFlightEventIds.has(e1.event_id)).toBe(true)

    // 2 回目は対象 0 件 → POST しない
    const second = makeMockClient()
    await flushPendingAnswerEvents(USER_A, second)
    expect(second.calls).toHaveLength(0)

    releasePost({ ok: true, status: 200, body: { ok: true, failed: [] } })
    await first
    expect(inFlightEventIds.size).toBe(0)
  })

  it('POST が reject しても finally で解放され、次回 flush で再 pickup できる', async () => {
    const e1 = await recordAnswerEvent(makeInput())
    const throwing: BulkApiClient = {
      post: async () => {
        throw new Error('network error')
      },
    }

    await expect(flushPendingAnswerEvents(USER_A, throwing)).rejects.toThrow('network error')
    expect(inFlightEventIds.size).toBe(0)

    const retry = makeMockClient()
    const result = await flushPendingAnswerEvents(USER_A, retry)
    expect(retry.calls).toHaveLength(1)
    expect(result.syncedEventIds).toEqual([e1.event_id])
  })
})
