// review-events sync helper の test。 fake-indexeddb 経由で実 Dexie を動かし、
// store の write / read / status 更新を verify する。 server bulk API は
// BulkApiClient injection で stub する。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import {
  createStudySession,
  completeStudySession,
  recordAnswerEvent,
  getPendingAnswerEvents,
  countPendingAnswerEvents,
  flushPendingEvents,
  newId,
  type BulkApiClient,
} from './review-events'

// 各 test の前に Dexie store を全 clear。 fake-indexeddb 自体は process 越しに
// state を持つので、 .clear() で各 table を空にして isolation を保つ。
beforeEach(async () => {
  const db = getClientDb()
  await Promise.all([
    db.study_sessions.clear(),
    db.answer_events.clear(),
    db.card_mutations.clear(),
    db.sync_meta.clear(),
    db.cards.clear(),
    db.exams.clear(),
    db.user_settings.clear(),
  ])
})

describe('newId', () => {
  it('v4 UUID 形式の文字列を返す', () => {
    const id = newId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})

describe('createStudySession + completeStudySession', () => {
  it('Dexie に行を追加し、 status=active / sync_status=pending で開始', async () => {
    const sessionId = newId()
    const row = await createStudySession({
      session_id: sessionId,
      exam_id: newId(),
      mode: 'smart',
      card_ids: [newId(), newId()],
    })
    expect(row.session_id).toBe(sessionId)
    expect(row.status).toBe('active')
    expect(row.sync_status).toBe('pending')
    expect(row.completed_at).toBeNull()

    const fetched = await getClientDb().study_sessions.get(sessionId)
    expect(fetched).toBeDefined()
    expect(fetched!.mode).toBe('smart')
    expect(fetched!.card_ids).toHaveLength(2)
  })

  it('completeStudySession で status=completed + completed_at が入る', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [],
    })
    await completeStudySession(sessionId)
    const fetched = await getClientDb().study_sessions.get(sessionId)
    expect(fetched!.status).toBe('completed')
    expect(fetched!.completed_at).toBeTruthy()
    // sync_status は再 pending に倒れる (status 遷移 = server に届けるべき変化)
    expect(fetched!.sync_status).toBe('pending')
  })
})

describe('recordAnswerEvent / getPendingAnswerEvents / countPendingAnswerEvents', () => {
  it('event 追加で pending 1 件、 取得・カウント正しい', async () => {
    const sessionId = newId()
    const cardId = newId()
    const event = await recordAnswerEvent({
      session_id: sessionId,
      card_id: cardId,
      selected_answer_ids: ['a'],
      is_correct: true,
    })
    expect(event.event_id).toMatch(/^[0-9a-f-]+$/i)
    expect(event.sync_status).toBe('pending')

    const pending = await getPendingAnswerEvents()
    expect(pending).toHaveLength(1)
    expect(pending[0].card_id).toBe(cardId)

    const count = await countPendingAnswerEvents()
    expect(count).toBe(1)
  })

  it('session_id フィルタ付き取得は当該 session のみ返す', async () => {
    const s1 = newId()
    const s2 = newId()
    await recordAnswerEvent({
      session_id: s1,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: false,
    })
    await recordAnswerEvent({
      session_id: s2,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: true,
    })
    const fromS1 = await getPendingAnswerEvents(s1)
    expect(fromS1).toHaveLength(1)
    expect(fromS1[0].session_id).toBe(s1)
    expect(await countPendingAnswerEvents(s2)).toBe(1)
  })

  it('event_id が指定されたらそれを使う (冪等性確保)', async () => {
    const fixedId = newId()
    const event = await recordAnswerEvent({
      event_id: fixedId,
      session_id: newId(),
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: true,
    })
    expect(event.event_id).toBe(fixedId)
  })

  it('rating を指定すると Dexie 行に保存される (undefined なら格納も undefined)', async () => {
    const withRating = await recordAnswerEvent({
      session_id: newId(),
      card_id: newId(),
      selected_answer_ids: ['a'],
      is_correct: true,
      rating: 2,
    })
    expect(withRating.rating).toBe(2)

    const without = await recordAnswerEvent({
      session_id: newId(),
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: false,
    })
    expect(without.rating).toBeUndefined()
  })
})

describe('flushPendingEvents', () => {
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

  it('全件成功 → 全 event を synced 化、 sessionSynced=true', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [],
    })
    const e1 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: ['a'],
      is_correct: true,
    })
    const e2 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: ['b'],
      is_correct: false,
    })

    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [] },
    })
    const result = await flushPendingEvents(sessionId, client)

    expect(result.attempted).toBe(2)
    expect(result.syncedEventIds.sort()).toEqual([e1.event_id, e2.event_id].sort())
    expect(result.failedEventIds).toEqual([])
    expect(result.sessionSynced).toBe(true)
    expect(result.reachable).toBe(true)

    // Dexie 側: 全 event sync_status=synced、 session も synced
    const remainingPending = await getPendingAnswerEvents(sessionId)
    expect(remainingPending).toHaveLength(0)
    const session = await getClientDb().study_sessions.get(sessionId)
    expect(session!.sync_status).toBe('synced')

    // payload 整合
    const payload = client.calls[0] as {
      session: { session_id: string; mode: string }
      events: Array<{ event_id: string }>
    }
    expect(payload.session.session_id).toBe(sessionId)
    expect(payload.session.mode).toBe('smart')
    expect(payload.events).toHaveLength(2)
  })

  it('一部失敗 → 成功 event のみ synced、 失敗 event は pending 維持、 session も pending', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [],
    })
    const e1 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: true,
    })
    const e2 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: false,
    })

    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [e2.event_id] },
    })
    const result = await flushPendingEvents(sessionId, client)

    expect(result.syncedEventIds).toEqual([e1.event_id])
    expect(result.failedEventIds).toEqual([e2.event_id])
    expect(result.sessionSynced).toBe(false)

    const pendingAfter = await getPendingAnswerEvents(sessionId)
    expect(pendingAfter.map((p) => p.event_id)).toEqual([e2.event_id])
    const session = await getClientDb().study_sessions.get(sessionId)
    expect(session!.sync_status).toBe('pending')
  })

  it('network 失敗 (ok=false) → 何も synced 化しない、 全 event pending 維持', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [],
    })
    const e1 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: true,
    })

    const client = makeMockClient({ ok: false, status: 0, body: null })
    const result = await flushPendingEvents(sessionId, client)

    expect(result.syncedEventIds).toEqual([])
    expect(result.failedEventIds).toEqual([e1.event_id])
    expect(result.sessionSynced).toBe(false)
    expect(result.reachable).toBe(false)

    const pendingAfter = await getPendingAnswerEvents(sessionId)
    expect(pendingAfter).toHaveLength(1)
  })

  it('server が 500 を返す → reachable=true、 何も synced 化しない', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [],
    })
    await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: true,
    })

    const client = makeMockClient({
      ok: false,
      status: 500,
      body: { error: 'session_upsert_failed' },
    })
    const result = await flushPendingEvents(sessionId, client)
    expect(result.syncedEventIds).toEqual([])
    expect(result.sessionSynced).toBe(false)
    expect(result.reachable).toBe(true)
  })

  it('events 0 件 (session のみ flush) → API は呼ばれ payload.events=[]', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [newId()],
    })
    await completeStudySession(sessionId)

    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [] },
    })
    const result = await flushPendingEvents(sessionId, client)
    expect(result.attempted).toBe(0)
    expect(result.sessionSynced).toBe(true)
    const payload = client.calls[0] as { events: unknown[] }
    expect(payload.events).toEqual([])
    const session = await getClientDb().study_sessions.get(sessionId)
    expect(session!.sync_status).toBe('synced')
    expect(session!.status).toBe('completed')
  })

  it('flush payload に rating を含める (記録時に指定された値) / 未指定なら欠落', async () => {
    const sessionId = newId()
    await createStudySession({
      session_id: sessionId,
      mode: 'smart',
      card_ids: [],
    })
    await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: ['a'],
      is_correct: true,
      rating: 4,
    })
    await recordAnswerEvent({
      session_id: sessionId,
      card_id: newId(),
      selected_answer_ids: [],
      is_correct: false,
      // rating 未指定
    })

    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [] },
    })
    await flushPendingEvents(sessionId, client)

    const payload = client.calls[0] as {
      events: Array<{ rating?: number }>
    }
    expect(payload.events).toHaveLength(2)
    // 指定済 event
    const withRating = payload.events.find((e) => e.rating !== undefined)
    expect(withRating?.rating).toBe(4)
    // 未指定 event は rating キー自体を持たない (server fallback に委ねる)
    const without = payload.events.find((e) => e.rating === undefined)
    expect(without).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(without, 'rating')).toBe(false)
  })

  it('session が Dexie に存在しない → no-op で返る', async () => {
    const client = makeMockClient({
      ok: true,
      status: 200,
      body: { ok: true, failed: [] },
    })
    const result = await flushPendingEvents(newId(), client)
    expect(result.attempted).toBe(0)
    expect(result.sessionSynced).toBe(false)
    expect(client.calls).toHaveLength(0)
  })
})
