// POST /api/review-events/bulk の unit test。
// 実 DB は叩かず、getCurrentUser / withTenantTx を mock して route + orchestrator の
// 制御フロー (auth / zod / clamp / 直列化 / 冪等 / 順序ガード / applied / 再集計 /
// tx throw 分類) を検証する。
//
// replayCard は mock しない (純関数・決定論的) — cards UPDATE の VALUES から
// FSRS fold の結果を間接検証する。
// 時刻は fake timer で固定する (clamp の採取点 receivedAt = handler 内の new Date())。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ZodError } from 'zod'

import { UnauthenticatedError } from '@/lib/auth/errors'

// ---------------------------------------------------------------------------
// hoisted state (test 間で reset)
// ---------------------------------------------------------------------------
const { state } = vi.hoisted(() => ({
  state: {} as import('@/tests/fixtures/review-events').ReviewEventsState,
}))

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/db/report-rls-context-failure', () => ({
  reportRlsContextFailure: vi.fn(async () => {}),
}))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: (_userId: string, fn: (tx: unknown) => unknown) =>
    fn(makeFakeTx(state)),
}))

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { logger } from '@/lib/logger'
import {
  addCardRow,
  addExistingEventRow,
  createState,
  decodeValuesFromSql,
  makeFakeTx,
  makeReq,
  makeValidPayload,
  resetState,
  sqlParams,
  FAKE_USER,
  VALID_CARD_ID,
  VALID_CARD_ID_2,
  VALID_EVENT_ID,
  VALID_EVENT_ID_2,
  VALID_EVENT_ID_3,
  VALID_SESSION_ID,
} from '@/tests/fixtures/review-events'
import { POST } from './route'

// handler 内で採取される receivedAt。全 test でこの時刻に固定する。
const RECEIVED_AT = new Date('2026-05-26T01:00:00.000Z')

function insertedRow(eventId: string) {
  const rows = state.answerEventInsertValues
  if (!rows) throw new Error('answer_events INSERT が呼ばれていない')
  const found = rows.find((r) => r.eventId === eventId)
  if (!found) throw new Error(`INSERT rows に ${eventId} がない`)
  return found
}

function cardTuple(cardId: string) {
  const capture = state.bulkUpdateCapture
  if (!capture) throw new Error('cards UPDATE が呼ばれていない')
  const found = decodeValuesFromSql(capture.fromSql).find((t) => t.id === cardId)
  if (!found) throw new Error(`VALUES に cardId=${cardId} がない`)
  return found
}

/** markApplied の WHERE から event_id 群を取り出す (先頭は userId)。 */
function appliedEventIds(): string[] {
  if (state.markAppliedCalls.length === 0) return []
  const params = sqlParams(state.markAppliedCalls[0].where) as string[]
  return params.slice(1)
}

function warnedEvents(): string[] {
  return vi
    .mocked(logger.warn)
    .mock.calls.map((c) => (c[0] as { event?: string }).event ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(RECEIVED_AT)
  Object.assign(state, createState())
  resetState(state)
  vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
  addCardRow(state, VALID_CARD_ID)
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// auth / payload validation
// ---------------------------------------------------------------------------

describe('POST /api/review-events/bulk — auth / validation', () => {
  it('未ログイン (UnauthenticatedError) → 401、DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(state.answerEventInsertValues).toBeNull()
  })

  it('Clerk session あるが users 行未 sync (null) → 401 user_not_synced、DB 未着手', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'user_not_synced' })
    expect(state.answerEventInsertValues).toBeNull()
  })

  it('invalid JSON body → 400 invalid_json', async () => {
    const req = new Request('http://localhost/api/review-events/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_json' })
  })

  it('event_id が非 UUID → 400 invalid_payload + issues', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: 'not-a-uuid',
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: unknown[] }
    expect(body.error).toBe('invalid_payload')
    expect(body.issues.length).toBeGreaterThan(0)
    expect(state.answerEventInsertValues).toBeNull()
  })

  it('rating 欠落 → 400 (正本一本化で required 化)', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(400)
  })

  it('rating=5 (範囲外) → 400 (zod literal union 拒否)', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 5,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(400)
  })

  it('events 配列が 1001 件 → 400 (zod .max(1000))', async () => {
    const events = Array.from({ length: 1001 }, (_, i) => ({
      event_id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
      card_id: VALID_CARD_ID,
      selected_answer_ids: ['a'],
      is_correct: true,
      rating: 3,
      answered_at: '2026-05-25T10:01:00.000Z',
    }))
    const res = await POST(makeReq({ events }))
    expect(res.status).toBe(400)
  })

  it('events=[] → 200 no-op (tx を張らない)', async () => {
    const res = await POST(makeReq({ events: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    expect(state.cardLockCalls).toBe(0)
    expect(state.answerEventInsertValues).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 正常系 — 9 手順の観測
// ---------------------------------------------------------------------------

describe('POST /api/review-events/bulk — 正常系', () => {
  it('card ロック → INSERT(applied=false) → cards UPDATE → applied 反転 → study_days 再集計', async () => {
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // 手順 3: cards を ID 昇順 FOR UPDATE でロック
    expect(state.cardLockCalls).toBe(1)
    expect((state.cardLockOrderBy as { name: string }).name).toBe('id')

    // 手順 4: applied=false + created_at = receivedAt で INSERT
    const row = insertedRow(VALID_EVENT_ID)
    expect(row).toMatchObject({
      eventId: VALID_EVENT_ID,
      userId: FAKE_USER.id,
      cardId: VALID_CARD_ID,
      sessionId: null,
      selectedAnswerIds: ['a'],
      isCorrect: true,
      rating: 3,
      elapsedMs: null,
      applied: false,
    })
    expect(row.answeredAt).toEqual(new Date('2026-05-25T10:01:00.000Z'))
    expect(row.createdAt).toEqual(RECEIVED_AT)

    // 手順 6: cards UPDATE は 1 round-trip
    expect(state.bulkUpdateCallCount).toBe(1)
    const tuple = cardTuple(VALID_CARD_ID)
    expect(tuple.reps).toBe(1)
    expect(tuple.answered).toBe(true)
    expect(tuple.lastCorrect).toBe(true)
    expect(tuple.currentStreak).toBe(1)

    // 手順 7: applied 反転
    expect(state.markAppliedCalls).toHaveLength(1)
    expect(state.markAppliedCalls[0].set).toEqual({ applied: true })
    expect(appliedEventIds()).toEqual([VALID_EVENT_ID])

    // 手順 8: JST day の行確保 + 再集計 1 文
    expect(state.studyDaysInsertValues).toEqual([
      { userId: FAKE_USER.id, day: '2026-05-25' },
    ])
    expect(state.studyDaysLockCalls).toBe(1)
    expect(state.executeCalls).toHaveLength(1)
  })

  it('session_id / elapsed_ms は指定どおり保存される', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              session_id: VALID_SESSION_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
              elapsed_ms: 4200,
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(insertedRow(VALID_EVENT_ID)).toMatchObject({
      sessionId: VALID_SESSION_ID,
      elapsedMs: 4200,
    })
  })

  it('is_correct=false は統計列に効き rating は scheduling に効く (2 本立て)', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['b'],
              is_correct: false,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(insertedRow(VALID_EVENT_ID)).toMatchObject({ isCorrect: false, rating: 3 })
    const tuple = cardTuple(VALID_CARD_ID)
    expect(tuple.lastCorrect).toBe(false)
    expect(tuple.currentStreak).toBe(0)
    // rating=3 は Again ではないので lapses は増えない
    expect(tuple.lapses).toBe(0)
  })

  it('複数 JST day を跨ぐ applied event → 対象 day が全て day 昇順で確保される', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID_2,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T15:00:00.000Z', // JST 2026-05-26 00:00
            },
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T14:59:00.000Z', // JST 2026-05-25 23:59
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(state.studyDaysInsertValues).toEqual([
      { userId: FAKE_USER.id, day: '2026-05-25' },
      { userId: FAKE_USER.id, day: '2026-05-26' },
    ])
  })

  it('2 card を 1 payload で処理 → 単一 VALUES UPDATE に両方が per-card 別 state で載る', async () => {
    addCardRow(state, VALID_CARD_ID_2)
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
            {
              event_id: VALID_EVENT_ID_2,
              card_id: VALID_CARD_ID_2,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:02:00.000Z',
            },
            {
              event_id: VALID_EVENT_ID_3,
              card_id: VALID_CARD_ID_2,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:03:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(state.bulkUpdateCallCount).toBe(1)
    expect(cardTuple(VALID_CARD_ID).reps).toBe(1)
    expect(cardTuple(VALID_CARD_ID_2).reps).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// clamp (spec §2.3)
// ---------------------------------------------------------------------------

describe('clamp', () => {
  it('未来 answered_at は receivedAt に clamp され、60s 超は warn する', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-26T02:00:00.000Z', // receivedAt + 1h
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    const row = insertedRow(VALID_EVENT_ID)
    expect(row.answeredAt).toEqual(RECEIVED_AT)
    expect(row.createdAt).toEqual(RECEIVED_AT)
    expect(warnedEvents()).toContain('review_events.bulk.clock_skew')
  })

  it('60s 以内の skew は clamp するが warn しない (ノイズを拾わない)', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-26T01:00:30.000Z', // receivedAt + 30s
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(insertedRow(VALID_EVENT_ID).answeredAt).toEqual(RECEIVED_AT)
    expect(warnedEvents()).not.toContain('review_events.bulk.clock_skew')
  })

  it('過去 answered_at は clamp しない (オフライン蓄積の正当ケース)', async () => {
    await POST(makeReq(makeValidPayload()))
    expect(insertedRow(VALID_EVENT_ID).answeredAt).toEqual(
      new Date('2026-05-25T10:01:00.000Z'),
    )
  })
})

// ---------------------------------------------------------------------------
// 順序ガード (spec §2.4)
// ---------------------------------------------------------------------------

describe('順序ガード', () => {
  it('lastReview より厳密に古い event → applied=false のまま (cards UPDATE 自体が起きない)', async () => {
    addCardRow(state, VALID_CARD_ID, {
      lastReview: new Date('2026-05-25T12:00:00.000Z'),
      reps: 3,
      answered: true,
    })
    const res = await POST(makeReq(makeValidPayload())) // answered_at 10:01 < 12:00

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    // event 行は insert 済 (受理はする)
    expect(insertedRow(VALID_EVENT_ID).applied).toBe(false)
    // 適用は無し
    expect(state.bulkUpdateCallCount).toBe(0)
    expect(state.markAppliedCalls).toHaveLength(0)
    expect(state.studyDaysInsertValues).toBeNull()
    expect(warnedEvents()).toContain('review_events.bulk.not_applied')
  })

  it('lastReview と同時刻の event は適用する (境界は >=)', async () => {
    const at = '2026-05-25T10:01:00.000Z'
    addCardRow(state, VALID_CARD_ID, {
      lastReview: new Date(at),
      reps: 3,
      answered: true,
    })
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(cardTuple(VALID_CARD_ID).reps).toBe(4)
    expect(appliedEventIds()).toEqual([VALID_EVENT_ID])
  })

  it('payload 順が逆でも answered_at 昇順に fold される', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID_2,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['b'],
              is_correct: false,
              rating: 1,
              answered_at: '2026-05-25T12:00:00.000Z',
            },
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:00:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    const tuple = cardTuple(VALID_CARD_ID)
    // 昇順 fold なら最後に適用されるのは 12:00 の incorrect event
    expect(tuple.lastCorrect).toBe(false)
    expect(tuple.currentStreak).toBe(0)
    expect(tuple.lastReview).toBe(new Date('2026-05-25T12:00:00.000Z').toISOString())
    expect(tuple.reps).toBe(2)
  })

  it('新旧混在: 古い分だけ落ち残りは適用される', async () => {
    addCardRow(state, VALID_CARD_ID, {
      lastReview: new Date('2026-05-25T11:00:00.000Z'),
      reps: 1,
      answered: true,
    })
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:00:00.000Z', // 古い → skip
            },
            {
              event_id: VALID_EVENT_ID_2,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T12:00:00.000Z', // 新しい → apply
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(appliedEventIds()).toEqual([VALID_EVENT_ID_2])
    expect(cardTuple(VALID_CARD_ID).reps).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// applied=false 降格 (dangling / A-2) — failed[] には載せない
// ---------------------------------------------------------------------------

describe('applied=false 降格', () => {
  it('card 不在 (dangling) → insert される・failed に載らない・cards UPDATE なし', async () => {
    state.cardRows.clear()
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    expect(insertedRow(VALID_EVENT_ID).applied).toBe(false)
    expect(state.bulkUpdateCallCount).toBe(0)
    expect(warnedEvents()).toContain('review_events.bulk.not_applied')
  })

  it('card の options に無い option id (A-2) → その event だけ降格し他は適用される', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['zzz'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
            {
              event_id: VALID_EVENT_ID_2,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:02:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    expect(appliedEventIds()).toEqual([VALID_EVENT_ID_2])
    expect(cardTuple(VALID_CARD_ID).reps).toBe(1)
  })

  it('options が壊れている card は fail-closed (空 selected は通る)', async () => {
    addCardRow(state, VALID_CARD_ID, { options: 'broken' })
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: [],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(appliedEventIds()).toEqual([VALID_EVENT_ID])
  })
})

// ---------------------------------------------------------------------------
// payload 内 duplicate / event_id 衝突 (spec §2.2 手順 1・4)
// ---------------------------------------------------------------------------

describe('payload 内 duplicate', () => {
  const base = {
    event_id: VALID_EVENT_ID,
    card_id: VALID_CARD_ID,
    selected_answer_ids: ['a'],
    is_correct: true,
    rating: 3 as const,
    answered_at: '2026-05-25T10:01:00.000Z',
  }

  it('同一内容の重複は先勝ちで 1 行に畳まれ warn しない', async () => {
    const res = await POST(makeReq(makeValidPayload({ events: [base, { ...base }] })))
    expect(res.status).toBe(200)
    expect(state.answerEventInsertValues).toHaveLength(1)
    expect(warnedEvents()).not.toContain(
      'review_events.bulk.duplicate_event_id_mismatch',
    )
  })

  it('内容不一致の重複は先勝ち + warn 1 行 (監査痕跡)', async () => {
    const res = await POST(
      makeReq(makeValidPayload({ events: [base, { ...base, rating: 1, is_correct: false }] })),
    )
    expect(res.status).toBe(200)
    expect(state.answerEventInsertValues).toHaveLength(1)
    // 先勝ち = 1 件目の内容が保存される
    expect(insertedRow(VALID_EVENT_ID)).toMatchObject({ rating: 3, isCorrect: true })
    expect(warnedEvents()).toContain('review_events.bulk.duplicate_event_id_mismatch')
  })
})

describe('event_id 衝突の 2 段検証', () => {
  it('非新規かつ own-scope に不在 (他 user の行) → failed[]', async () => {
    state.duplicateEventIds.add(VALID_EVENT_ID)
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [VALID_EVENT_ID] })
    expect(warnedEvents()).toContain('review_events.bulk.event_id_collision')
    // FSRS は適用しない
    expect(state.bulkUpdateCallCount).toBe(0)
  })

  it('非新規かつ自分の既存行と内容一致 (正当な再送) → failed に載らない', async () => {
    state.duplicateEventIds.add(VALID_EVENT_ID)
    addExistingEventRow(state, VALID_EVENT_ID)
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    // 既存行は不変 = 再適用もしない
    expect(state.bulkUpdateCallCount).toBe(0)
  })

  it('非新規かつ自分の既存行と内容不一致 → failed[] (先勝ち immutable)', async () => {
    state.duplicateEventIds.add(VALID_EVENT_ID)
    addExistingEventRow(state, VALID_EVENT_ID, { rating: 1, isCorrect: false })
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [VALID_EVENT_ID] })
  })

  it('新規 event と衝突 event が混在 → 新規だけ適用され衝突だけ failed', async () => {
    state.duplicateEventIds.add(VALID_EVENT_ID)
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:01:00.000Z',
            },
            {
              event_id: VALID_EVENT_ID_2,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['a'],
              is_correct: true,
              rating: 3,
              answered_at: '2026-05-25T10:02:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [VALID_EVENT_ID] })
    expect(appliedEventIds()).toEqual([VALID_EVENT_ID_2])
  })
})

// ---------------------------------------------------------------------------
// tx throw の分類 (spec §2.1 / r4)
// ---------------------------------------------------------------------------

describe('tx throw の分類', () => {
  it('unknown DB error → 503 + Retry-After:30 (silent lost write 回避の default)', async () => {
    state.txShouldThrow = true
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(await res.json()).toEqual({ error: 'bulk_ingest_failed' })
    expect(warnedEvents()).toContain('review_events.bulk.tx_failed')
  })

  it('transient PG code (40001 serialization failure) → 503', async () => {
    state.txShouldThrow = true
    state.txError = Object.assign(new Error('serialization failure'), { code: '40001' })
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('permanent-4xx (ZodError) → 400 (恒久バグを無限 retry させない)', async () => {
    state.txShouldThrow = true
    state.txError = new ZodError([])
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_payload' })
  })

  it('cards UPDATE の RETURNING 件数 mismatch → throw → 503 (rollback)', async () => {
    state.bulkUpdateReturnOverride = []
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(503)
  })
})
