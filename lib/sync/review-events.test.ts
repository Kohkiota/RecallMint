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
  getAllPendingAnswerEvents,
  countPendingAnswerEvents,
  flushPendingEvents,
  flushAllPendingEvents,
  dropStalePendingAnswerEvents,
  inFlightEventIds,
  newId,
  type BulkApiClient,
} from './review-events'

// 各 test の前に Dexie store を全 clear。 fake-indexeddb 自体は process 越しに
// state を持つので、 .clear() で各 table を空にして isolation を保つ。
// in-flight Set も同様にクリア (hang させた test の後で残ることを防ぐ)。
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
  inFlightEventIds.clear()
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

describe('getPendingAnswerEvents — 戻り順保証', () => {
  // server 側での同一 card への複数 event 適用は「payload に乗る順序 = apply 順」を
  // 前提とする。 client 側の保証は「record した順 (= local_id 昇順) = answered_at 昇順
  // で返る」こと。 Dexie の secondary-index query (.where('sync_status').equals())
  // は同値 entry を PK (local_id) 昇順でソートするため、 挿入順が保たれる。
  it('同一 card に answered_at 昇順で複数 record した場合、 戻り配列が record 投入順 (= answered_at 昇順) で返る', async () => {
    const sessionId = newId()
    const cardId = newId()

    // answered_at を明示的に昇順で 3 件 record し、 local_id も同順で採番させる。
    // t1 < t2 < t3 の順序が payload / server apply 順の前提となる。
    const t1 = '2026-01-01T00:00:01.000Z'
    const t2 = '2026-01-01T00:00:02.000Z'
    const t3 = '2026-01-01T00:00:03.000Z'

    const ev1 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: cardId,
      selected_answer_ids: ['a'],
      is_correct: false,
      answered_at: t1,
    })
    const ev2 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: cardId,
      selected_answer_ids: ['b'],
      is_correct: false,
      answered_at: t2,
    })
    const ev3 = await recordAnswerEvent({
      session_id: sessionId,
      card_id: cardId,
      selected_answer_ids: ['c'],
      is_correct: true,
      answered_at: t3,
    })

    const pending = await getPendingAnswerEvents(sessionId)

    // 戻り順 = 投入順 (= local_id 昇順 = answered_at 昇順)
    expect(pending).toHaveLength(3)
    expect(pending[0].event_id).toBe(ev1.event_id)
    expect(pending[1].event_id).toBe(ev2.event_id)
    expect(pending[2].event_id).toBe(ev3.event_id)

    // local_id が存在し、 昇順であることを確認 (auto-increment が正しく機能している)
    const localIds = pending.map((e) => e.local_id!)
    expect(localIds[0]).toBeLessThan(localIds[1])
    expect(localIds[1]).toBeLessThan(localIds[2])

    // answered_at が投入順 (昇順) と一致することも確認
    expect(pending[0].answered_at).toBe(t1)
    expect(pending[1].answered_at).toBe(t2)
    expect(pending[2].answered_at).toBe(t3)
  })

  it('answered_at 順と record 投入順が一致する場合、 sessionId フィルタ後も順序が保たれる', async () => {
    const sA = newId()
    const sB = newId()
    const cardId = newId()

    const t1 = '2026-02-01T00:00:01.000Z'
    const t2 = '2026-02-01T00:00:02.000Z'

    // sA と sB を交互に record して local_id を混在させる
    const evA1 = await recordAnswerEvent({
      session_id: sA, card_id: cardId,
      selected_answer_ids: [], is_correct: false, answered_at: t1,
    })
    await recordAnswerEvent({
      session_id: sB, card_id: newId(),
      selected_answer_ids: [], is_correct: true, answered_at: t1,
    })
    const evA2 = await recordAnswerEvent({
      session_id: sA, card_id: cardId,
      selected_answer_ids: ['a'], is_correct: true, answered_at: t2,
    })

    // sA の pending のみを取得し、 投入順 (local_id 昇順) で返ることを確認
    const pending = await getPendingAnswerEvents(sA)
    expect(pending).toHaveLength(2)
    expect(pending[0].event_id).toBe(evA1.event_id)
    expect(pending[1].event_id).toBe(evA2.event_id)
    expect(pending[0].local_id!).toBeLessThan(pending[1].local_id!)
  })
})

describe('getAllPendingAnswerEvents', () => {
  it('2 つの異なる session の pending を session 横断で全件返す', async () => {
    const s1 = newId()
    const s2 = newId()
    const e1 = await recordAnswerEvent({
      session_id: s1,
      card_id: newId(),
      selected_answer_ids: ['a'],
      is_correct: true,
    })
    const e2 = await recordAnswerEvent({
      session_id: s2,
      card_id: newId(),
      selected_answer_ids: ['b'],
      is_correct: false,
    })
    const all = await getAllPendingAnswerEvents()
    const ids = all.map((e) => e.event_id).sort()
    expect(ids).toEqual([e1.event_id, e2.event_id].sort())
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

describe('flushPendingEvents — in-flight guard', () => {
  // controllable promise helper: post() が resolve するまで外から制御できる。
  // postCalled promise は post() が呼ばれた (= in-flight Set への add が完了した)
  // タイミングを待つために使う。
  function makeHangingClient(): BulkApiClient & {
    calls: unknown[]
    postCalled: Promise<void>
    resolve: (v: Awaited<ReturnType<BulkApiClient['post']>>) => void
    reject: (err: unknown) => void
  } {
    const calls: unknown[] = []
    let resolve!: (v: Awaited<ReturnType<BulkApiClient['post']>>) => void
    let reject!: (err: unknown) => void
    let notifyPostCalled!: () => void
    const postCalled = new Promise<void>((res) => { notifyPostCalled = res })
    const post = (payload: unknown) => {
      calls.push(payload)
      notifyPostCalled()
      return new Promise<Awaited<ReturnType<BulkApiClient['post']>>>((res, rej) => {
        resolve = res
        reject = rej
      })
    }
    return {
      calls,
      postCalled,
      post,
      // resolve / reject は post() が呼ばれて初めて代入される。
      // 呼出側は必ず `await postCalled` で post() 完了を確認してから
      // .resolve / .reject にアクセスすること (順序逆転すると undefined になる)。
      get resolve() { return resolve },
      get reject() { return reject },
    }
  }

  // (a) 同 session を 2 回並走: 2 回目は in-flight 除外で POST をスキップ
  it('同 session の 2 回目 invoke は events が in-flight 中なら POST をスキップする', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    const e1 = await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
    })

    const hangingClient = makeHangingClient()
    // 1 回目を hang させたまま await しない
    const flush1Promise = flushPendingEvents(sessionId, hangingClient)

    // post() が呼ばれた = in-flight Set への add が完了したタイミングを待つ
    await hangingClient.postCalled

    const skipClient = {
      calls: [] as unknown[],
      post: async (payload: unknown) => {
        skipClient.calls.push(payload)
        return { ok: true, status: 200, body: { ok: true as const, failed: [] } }
      },
    }
    // 2 回目は in-flight 中の e1 を除外 → skip (POST なし)
    const flush2Result = await flushPendingEvents(sessionId, skipClient)

    expect(skipClient.calls).toHaveLength(0)
    expect(flush2Result.attempted).toBe(0)
    expect(flush2Result.syncedEventIds).toEqual([])

    // 1 回目を完了させる
    hangingClient.resolve({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const flush1Result = await flush1Promise
    expect(hangingClient.calls).toHaveLength(1)
    expect(flush1Result.syncedEventIds).toContain(e1.event_id)
    // finally 後は Set から除去されているはず
    expect(inFlightEventIds.size).toBe(0)
  })

  // (b) 別 session は互いに独立して POST できる
  it('別 session の並走 flush は互いにブロックしない', async () => {
    const sA = newId()
    const sB = newId()
    await createStudySession({ session_id: sA, mode: 'smart', card_ids: [] })
    await createStudySession({ session_id: sB, mode: 'smart', card_ids: [] })
    const eA = await recordAnswerEvent({
      session_id: sA, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
    })
    const eB = await recordAnswerEvent({
      session_id: sB, card_id: newId(), selected_answer_ids: ['b'], is_correct: false,
    })

    const clientA = {
      calls: [] as unknown[],
      post: async (payload: unknown) => {
        clientA.calls.push(payload)
        return { ok: true, status: 200, body: { ok: true as const, failed: [] } }
      },
    }
    const clientB = {
      calls: [] as unknown[],
      post: async (payload: unknown) => {
        clientB.calls.push(payload)
        return { ok: true, status: 200, body: { ok: true as const, failed: [] } }
      },
    }

    const [rA, rB] = await Promise.all([
      flushPendingEvents(sA, clientA),
      flushPendingEvents(sB, clientB),
    ])

    expect(clientA.calls).toHaveLength(1)
    expect(clientB.calls).toHaveLength(1)
    expect(rA.syncedEventIds).toContain(eA.event_id)
    expect(rB.syncedEventIds).toContain(eB.event_id)
    expect(inFlightEventIds.size).toBe(0)
  })

  // (c) POST reject 時も finally で Set から除去され、 次回 invoke で再 pickup できる
  it('POST が reject しても finally で in-flight Set から除去される', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    const e1 = await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
    })

    const hangingClient = makeHangingClient()
    const flushPromise = flushPendingEvents(sessionId, hangingClient)
    // post() が呼ばれた = in-flight Set への add が完了したタイミングを待つ
    await hangingClient.postCalled

    // in-flight 中は Set に入っている
    expect(inFlightEventIds.has(e1.event_id)).toBe(true)

    hangingClient.reject(new Error('network error'))
    // reject なので flushPendingEvents 自体も throw する
    await expect(flushPromise).rejects.toThrow('network error')

    // finally で Set から除去されている
    expect(inFlightEventIds.has(e1.event_id)).toBe(false)

    // 次回は再 pickup できる (POST 1 回)
    const retryClient = {
      calls: [] as unknown[],
      post: async (payload: unknown) => {
        retryClient.calls.push(payload)
        return { ok: true, status: 200, body: { ok: true as const, failed: [] } }
      },
    }
    const retryResult = await flushPendingEvents(sessionId, retryClient)
    expect(retryClient.calls).toHaveLength(1)
    expect(retryResult.attempted).toBe(1)
    expect(retryResult.syncedEventIds).toContain(e1.event_id)
  })

  // (d) 部分 in-flight: events [1..5] のうち [1..3] が in-flight、 残 [4..5] のみ送信
  it('一部 event が in-flight 中でも残りの event は送信される', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })

    const events = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordAnswerEvent({
          session_id: sessionId, card_id: newId(),
          selected_answer_ids: [String(i)], is_correct: true,
        })
      )
    )
    const [e1, e2, e3, e4, e5] = events

    // [1..3] を手動で in-flight Set に追加 (1 回目 flush が掴んでいる状態を模倣)。
    // JS は single-threaded なため makeHangingClient で並走させても post() 呼出前に
    // add が完了しない競合が起きる。 Set に直接 seed することで
    // 「別 flush が既にこれらを in-flight 登録済み」と同等の状態を簡潔に再現する。
    inFlightEventIds.add(e1.event_id)
    inFlightEventIds.add(e2.event_id)
    inFlightEventIds.add(e3.event_id)

    const client = {
      calls: [] as unknown[],
      post: async (payload: unknown) => {
        client.calls.push(payload)
        return { ok: true, status: 200, body: { ok: true as const, failed: [] } }
      },
    }
    const result = await flushPendingEvents(sessionId, client)

    // [4..5] のみ送信
    expect(result.attempted).toBe(2)
    const sentPayload = client.calls[0] as { events: Array<{ event_id: string }> }
    const sentIds = sentPayload.events.map((e) => e.event_id).sort()
    expect(sentIds).toEqual([e4.event_id, e5.event_id].sort())

    // [1..3] は Set から消えていない (別の flush が管理している)
    expect(inFlightEventIds.has(e1.event_id)).toBe(true)
    expect(inFlightEventIds.has(e2.event_id)).toBe(true)
    expect(inFlightEventIds.has(e3.event_id)).toBe(true)
    // [4..5] は finally で除去済み
    expect(inFlightEventIds.has(e4.event_id)).toBe(false)
    expect(inFlightEventIds.has(e5.event_id)).toBe(false)
  })
})

describe('flushAllPendingEvents', () => {
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

  it('3 つの session に pending がある状態で session 別に 3 回 flush され各 POST に正しい session_id が乗る', async () => {
    const s1 = newId()
    const s2 = newId()
    const s3 = newId()
    await createStudySession({ session_id: s1, mode: 'smart', card_ids: [] })
    await createStudySession({ session_id: s2, mode: 'smart', card_ids: [] })
    await createStudySession({ session_id: s3, mode: 'smart', card_ids: [] })

    const e1 = await recordAnswerEvent({ session_id: s1, card_id: newId(), selected_answer_ids: ['a'], is_correct: true })
    const e2 = await recordAnswerEvent({ session_id: s2, card_id: newId(), selected_answer_ids: ['b'], is_correct: false })
    const e3 = await recordAnswerEvent({ session_id: s3, card_id: newId(), selected_answer_ids: ['c'], is_correct: true })

    const client = makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } })
    const results = await flushAllPendingEvents(client)

    // 3 session それぞれに対して POST が 1 回ずつ呼ばれる
    expect(client.calls).toHaveLength(3)

    // 各 POST に乗った session_id を収集し、3 session 全てが含まれることを確認
    const postedSessionIds = (client.calls as Array<{ session: { session_id: string } }>)
      .map((p) => p.session.session_id)
      .sort()
    expect(postedSessionIds).toEqual([s1, s2, s3].sort())

    // 各 session の events は自 session のものだけ
    const payloadForS1 = (client.calls as Array<{ session: { session_id: string }; events: Array<{ event_id: string }> }>)
      .find((p) => p.session.session_id === s1)!
    expect(payloadForS1.events.map((e) => e.event_id)).toEqual([e1.event_id])

    const payloadForS2 = (client.calls as Array<{ session: { session_id: string }; events: Array<{ event_id: string }> }>)
      .find((p) => p.session.session_id === s2)!
    expect(payloadForS2.events.map((e) => e.event_id)).toEqual([e2.event_id])

    const payloadForS3 = (client.calls as Array<{ session: { session_id: string }; events: Array<{ event_id: string }> }>)
      .find((p) => p.session.session_id === s3)!
    expect(payloadForS3.events.map((e) => e.event_id)).toEqual([e3.event_id])

    // 戻り値に 3 件の FlushResult が含まれる
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.attempted).toBe(1)
      expect(r.sessionSynced).toBe(true)
    }
  })

  it('一部 session の POST が reject しても他 session の flush は完走する', async () => {
    const sOk1 = newId()
    const sFail = newId()
    const sOk2 = newId()
    await createStudySession({ session_id: sOk1, mode: 'smart', card_ids: [] })
    await createStudySession({ session_id: sFail, mode: 'smart', card_ids: [] })
    await createStudySession({ session_id: sOk2, mode: 'smart', card_ids: [] })

    await recordAnswerEvent({ session_id: sOk1, card_id: newId(), selected_answer_ids: ['a'], is_correct: true })
    await recordAnswerEvent({ session_id: sFail, card_id: newId(), selected_answer_ids: ['b'], is_correct: false })
    await recordAnswerEvent({ session_id: sOk2, card_id: newId(), selected_answer_ids: ['c'], is_correct: true })

    // sFail の POST は reject、他は成功するクライアント
    const calls: unknown[] = []
    const rejectingClient: BulkApiClient = {
      post: async (payload) => {
        calls.push(payload)
        const p = payload as { session: { session_id: string } }
        if (p.session.session_id === sFail) {
          throw new Error('simulated network failure')
        }
        return { ok: true, status: 200, body: { ok: true, failed: [] } }
      },
    }

    // allSettled のため throw しない
    const results = await flushAllPendingEvents(rejectingClient)

    // 3 session 全てに対して POST が試みられる
    expect(calls).toHaveLength(3)

    // 成功した 2 session の events は synced になっている
    const pendingOk1 = await getPendingAnswerEvents(sOk1)
    expect(pendingOk1).toHaveLength(0)
    const pendingOk2 = await getPendingAnswerEvents(sOk2)
    expect(pendingOk2).toHaveLength(0)

    // reject した session の events は pending のまま
    const pendingFail = await getPendingAnswerEvents(sFail)
    expect(pendingFail).toHaveLength(1)

    // 戻り値には成功した 2 件の FlushResult が含まれ、reject の 1 件は除外される
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.sessionSynced)).toBe(true)
  })
})

describe('flushPendingEvents — httpStatus (retry 分類用)', () => {
  function makeMockClient(
    response: Awaited<ReturnType<BulkApiClient['post']>>,
  ): BulkApiClient {
    return { post: async () => response }
  }

  it('成功時は httpStatus=200', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
    })
    const result = await flushPendingEvents(
      sessionId,
      makeMockClient({ ok: true, status: 200, body: { ok: true, failed: [] } }),
    )
    expect(result.httpStatus).toBe(200)
  })

  it('5xx 失敗時は応答の status をそのまま httpStatus に載せる', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: [], is_correct: true,
    })
    const result = await flushPendingEvents(
      sessionId,
      makeMockClient({ ok: false, status: 503, body: null }),
    )
    expect(result.httpStatus).toBe(503)
    expect(result.failedEventIds).toHaveLength(1)
  })

  it('network 失敗 (fetch throw) は httpStatus=0', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: [], is_correct: true,
    })
    const result = await flushPendingEvents(
      sessionId,
      makeMockClient({ ok: false, status: 0, body: null }),
    )
    expect(result.httpStatus).toBe(0)
  })
})

describe('flushPendingEvents — last_attempted_at write 配線', () => {
  it('flush 試行時に対象 event の last_attempted_at が書かれる (失敗で pending 残置でも記録)', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    const e1 = await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
    })
    // 記録直後は未試行
    expect(e1.last_attempted_at ?? null).toBeNull()

    // 失敗 client で flush → event は pending のまま、 last_attempted_at は記録される
    await flushPendingEvents(sessionId, { post: async () => ({ ok: false, status: 503, body: null }) })

    const stored = await getClientDb().answer_events.where('event_id').equals(e1.event_id).first()
    expect(stored).toBeDefined()
    expect(typeof stored!.last_attempted_at).toBe('string')
    // ISO8601 としてパース可能
    expect(Number.isNaN(Date.parse(stored!.last_attempted_at!))).toBe(false)
  })
})

describe('dropStalePendingAnswerEvents — 24h 超 silent drop', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('answered_at が maxAge より古い pending を drop (sync_status=failed)、 新しいものは残す', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    const now = Date.parse('2026-05-29T12:00:00.000Z')

    const oldEvent = await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
      answered_at: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25h 前
    })
    const freshEvent = await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['b'], is_correct: false,
      answered_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(), // 1h 前
    })

    const dropped = await dropStalePendingAnswerEvents(now, DAY_MS)

    // 戻り値に古い event_id が含まれる
    expect(dropped).toEqual([oldEvent.event_id])

    // 古い event は pending から外れ failed に、 新しい event は pending 維持
    const pending = await getPendingAnswerEvents()
    expect(pending.map((p) => p.event_id)).toEqual([freshEvent.event_id])
    const stored = await getClientDb().answer_events.where('event_id').equals(oldEvent.event_id).first()
    expect(stored!.sync_status).toBe('failed')
  })

  it('境界 (ちょうど maxAge) は drop しない / 古いものが無ければ空配列', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    const now = Date.parse('2026-05-29T12:00:00.000Z')
    await recordAnswerEvent({
      session_id: sessionId, card_id: newId(), selected_answer_ids: ['a'], is_correct: true,
      answered_at: new Date(now - DAY_MS).toISOString(), // ちょうど 24h (境界は残す)
    })
    const dropped = await dropStalePendingAnswerEvents(now, DAY_MS)
    expect(dropped).toEqual([])
    expect(await countPendingAnswerEvents()).toBe(1)
  })

  it('synced / failed は走査対象外 (pending のみ drop)', async () => {
    const sessionId = newId()
    await createStudySession({ session_id: sessionId, mode: 'smart', card_ids: [] })
    const now = Date.parse('2026-05-29T12:00:00.000Z')
    const oldAnswered = new Date(now - 48 * 60 * 60 * 1000).toISOString()
    // synced 済の古い event を直接 seed
    await getClientDb().answer_events.add({
      event_id: newId(), session_id: sessionId, card_id: newId(),
      selected_answer_ids: [], is_correct: true, answered_at: oldAnswered,
      sync_status: 'synced',
    })
    const dropped = await dropStalePendingAnswerEvents(now, DAY_MS)
    expect(dropped).toEqual([])
  })
})
