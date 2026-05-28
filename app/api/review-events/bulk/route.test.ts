// POST /api/review-events/bulk の unit test。
// 実 DB は叩かず、 getCurrentUser / getDb / submitReviewTx を mock して
// route handler の制御フロー (auth / zod / upsert / per-event tx / partial failure /
// idempotency) を検証する。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// hoisted state (test 間で reset、 各 mock fn が参照する)
// ---------------------------------------------------------------------------
const { state } = vi.hoisted(() => ({
  state: {
    // study_sessions upsert
    sessionUpsertCalls: [] as Array<{
      values: Record<string, unknown>
      conflictSet: Record<string, unknown>
      conflictSetWhere: unknown
    }>,
    sessionUpsertShouldThrow: false,
    // answer_events insert
    eventInsertCalls: [] as Array<{ values: Record<string, unknown>; returnRows: { id: string }[] }>,
    // each call's returning rows is decided by per-event resolver
    eventDuplicateEventIds: new Set<string>(),
    // submitReviewTx
    submitReviewTxCalls: [] as Array<{ userId: string; cardId: string; rating: number; now: Date }>,
    submitReviewTxThrowingCardIds: new Set<string>(),
  },
}))

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/cards/submit-review-tx', () => ({
  submitReviewTx: vi.fn(
    async (
      _tx: unknown,
      args: { userId: string; cardId: string; rating: number; now: Date },
    ) => {
      state.submitReviewTxCalls.push(args)
      if (state.submitReviewTxThrowingCardIds.has(args.cardId)) {
        throw new Error('card not found')
      }
      return { correct: args.rating >= 2 }
    },
  ),
}))

// drizzle-orm の sql / eq 等の named export を実物のまま借りつつ、
// route 内で使う API surface だけは fake db で差し替える。
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => fakeDb),
}))

// ---------------------------------------------------------------------------
// fake DB (instance shared across tests, state reset in beforeEach)
// ---------------------------------------------------------------------------
const fakeDb = {
  // study_sessions upsert chain: db.insert(t).values(v).onConflictDoUpdate({target, set, setWhere})
  insert: (_table: unknown) => ({
    values: (vals: Record<string, unknown>) => ({
      onConflictDoUpdate: async (conf: {
        target: unknown
        set: Record<string, unknown>
        setWhere?: unknown
      }) => {
        if (state.sessionUpsertShouldThrow) {
          throw new Error('boom')
        }
        state.sessionUpsertCalls.push({
          values: vals,
          conflictSet: conf.set,
          conflictSetWhere: conf.setWhere,
        })
      },
    }),
  }),
  // per-event tx: db.transaction(async (tx) => { ... })
  transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(makeTx())
  },
}

function makeTx() {
  return {
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: (_conf: unknown) => ({
          returning: async (_cols: unknown) => {
            const eventId = vals.eventId as string
            if (state.eventDuplicateEventIds.has(eventId)) {
              state.eventInsertCalls.push({ values: vals, returnRows: [] })
              return []
            }
            const rows = [{ id: `row-${eventId}` }]
            state.eventInsertCalls.push({ values: vals, returnRows: rows })
            return rows
          },
        }),
      }),
    }),
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { POST } from './route'

// zod v4 z.uuid() は version=1..8 + variant=8/9/a/b の RFC 4122 format を強制するため、
// テスト fixture も valid format で書く。 各値は version=4 (v4 UUID) / variant=a で固定。
const FAKE_USER = { id: '11111111-1111-4111-a111-111111111111' } as unknown as User
const VALID_SESSION_ID = '22222222-2222-4222-a222-222222222222'
const VALID_EXAM_ID = '33333333-3333-4333-a333-333333333333'
const VALID_CARD_ID = '44444444-4444-4444-a444-444444444444'
const VALID_EVENT_ID = '55555555-5555-4555-a555-555555555555'
const VALID_EVENT_ID_2 = '66666666-6666-4666-a666-666666666666'
const VALID_EVENT_ID_3 = '77777777-7777-4777-a777-777777777777'
const VALID_CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'

function makeReq(payload: unknown): Request {
  return new Request('http://localhost/api/review-events/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function makeValidPayload(
  overrides: { events?: unknown[]; session?: Record<string, unknown> } = {},
) {
  return {
    session: {
      session_id: VALID_SESSION_ID,
      exam_id: VALID_EXAM_ID,
      mode: 'smart',
      card_ids: [VALID_CARD_ID],
      started_at: '2026-05-25T10:00:00.000Z',
      status: 'active',
      ...overrides.session,
    },
    events: overrides.events ?? [
      {
        event_id: VALID_EVENT_ID,
        card_id: VALID_CARD_ID,
        selected_answer_ids: ['a'],
        is_correct: true,
        answered_at: '2026-05-25T10:01:00.000Z',
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.sessionUpsertCalls = []
  state.sessionUpsertShouldThrow = false
  state.eventInsertCalls = []
  state.eventDuplicateEventIds = new Set()
  state.submitReviewTxCalls = []
  state.submitReviewTxThrowingCardIds = new Set()
})

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
describe('POST /api/review-events/bulk', () => {
  it('未ログイン (UnauthenticatedError) → 401、 DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(state.sessionUpsertCalls).toHaveLength(0)
    expect(state.submitReviewTxCalls).toHaveLength(0)
  })

  it('Clerk session あるが users 行未 sync (null) → 401 user_not_synced、 DB 未着手', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'user_not_synced' })
    expect(state.sessionUpsertCalls).toHaveLength(0)
  })

  it('invalid JSON body → 400 invalid_json', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const req = new Request('http://localhost/api/review-events/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_json' })
  })

  it('zod validation 失敗 (event_id が非 UUID) → 400 invalid_payload + issues', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({
      events: [
        {
          event_id: 'not-a-uuid',
          card_id: VALID_CARD_ID,
          selected_answer_ids: [],
          is_correct: false,
          answered_at: '2026-05-25T10:01:00.000Z',
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: unknown[] }
    expect(body.error).toBe('invalid_payload')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)
    expect(state.sessionUpsertCalls).toHaveLength(0)
  })

  it('正常系: study_sessions upsert + answer_events insert + FSRS (rating=3 if correct)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // study_sessions upsert
    expect(state.sessionUpsertCalls).toHaveLength(1)
    expect(state.sessionUpsertCalls[0].values).toMatchObject({
      sessionId: VALID_SESSION_ID,
      userId: FAKE_USER.id,
      examId: VALID_EXAM_ID,
      mode: 'smart',
      cardIds: [VALID_CARD_ID],
      status: 'active',
    })
    // upsert conflict set には最新 status / completed_at が乗る。
    // card_ids は initial insert のみで conflict 上書き対象外 (I-1)。
    expect(state.sessionUpsertCalls[0].conflictSet).toMatchObject({
      status: 'active',
    })
    expect(
      Object.prototype.hasOwnProperty.call(
        state.sessionUpsertCalls[0].conflictSet,
        'cardIds',
      ),
    ).toBe(false)
    // C-1 fix: tenant 分離 setWhere が付いていること (具体 SQL fragment は
    // drizzle が組み立てるため値は undefined != = で defined である事実だけ assert)。
    expect(state.sessionUpsertCalls[0].conflictSetWhere).toBeDefined()

    // answer_events insert
    expect(state.eventInsertCalls).toHaveLength(1)
    expect(state.eventInsertCalls[0].values).toMatchObject({
      eventId: VALID_EVENT_ID,
      sessionId: VALID_SESSION_ID,
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
      isCorrect: true,
    })

    // FSRS: is_correct=true → rating=3
    expect(state.submitReviewTxCalls).toHaveLength(1)
    expect(state.submitReviewTxCalls[0]).toMatchObject({
      userId: FAKE_USER.id,
      cardId: VALID_CARD_ID,
      rating: 3,
    })
  })

  it('is_correct=false → FSRS rating=1 (Again)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['b'],
          is_correct: false,
          answered_at: '2026-05-25T10:01:00.000Z',
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(state.submitReviewTxCalls[0].rating).toBe(1)
  })

  it('payload に rating=2 (Hard) 明示 → derive を上書きして FSRS rating=2 が submitReviewTx に渡る', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['b'],
          is_correct: true, // derive すると 3 (Good) になるはずだが、 rating で上書き
          answered_at: '2026-05-25T10:01:00.000Z',
          rating: 2,
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(state.submitReviewTxCalls[0].rating).toBe(2)
  })

  it('payload に rating=4 (Easy) 明示 → FSRS rating=4 が submitReviewTx に渡る', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['b'],
          is_correct: true,
          answered_at: '2026-05-25T10:01:00.000Z',
          rating: 4,
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(state.submitReviewTxCalls[0].rating).toBe(4)
  })

  it('payload に rating=5 (範囲外) → 400 invalid_payload (zod literal union 拒否)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: [],
          is_correct: false,
          answered_at: '2026-05-25T10:01:00.000Z',
          // 不正値 5 (zod union は 1|2|3|4 のみ accept)
          rating: 5,
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_payload')
    expect(state.submitReviewTxCalls).toHaveLength(0)
  })

  it('重複 event_id (ON CONFLICT DO NOTHING で 0 行返り) → FSRS 適用 skip、 200', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.eventDuplicateEventIds.add(VALID_EVENT_ID)

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // event INSERT は試みる (returning が 0 件)
    expect(state.eventInsertCalls).toHaveLength(1)
    expect(state.eventInsertCalls[0].returnRows).toEqual([])
    // FSRS は適用されない
    expect(state.submitReviewTxCalls).toHaveLength(0)
  })

  it('複数 event の一部が FSRS 失敗 → 失敗 event_id だけ failed[]、 他は完走、 200', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const BAD_CARD = '99999999-9999-4999-a999-999999999999'
    state.submitReviewTxThrowingCardIds.add(BAD_CARD)

    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: '2026-05-25T10:01:00.000Z',
        },
        {
          event_id: VALID_EVENT_ID_2,
          card_id: BAD_CARD,
          selected_answer_ids: [],
          is_correct: false,
          answered_at: '2026-05-25T10:02:00.000Z',
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.failed).toEqual([VALID_EVENT_ID_2])

    // 良 event の FSRS は呼ばれている
    const goodCall = state.submitReviewTxCalls.find(
      (c) => c.cardId === VALID_CARD_ID,
    )
    expect(goodCall).toBeDefined()
  })

  it('study_sessions upsert 自体が throw → 500 session_upsert_failed、 events 未処理', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.sessionUpsertShouldThrow = true

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'session_upsert_failed' })
    expect(state.eventInsertCalls).toHaveLength(0)
    expect(state.submitReviewTxCalls).toHaveLength(0)
  })

  it('events 配列が 1001 件 → 400 invalid_payload (zod .max(1000))', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // 1001 件の合成 UUID。 zod v4 z.uuid() に通る format (version=4, variant=a)。
    const events = Array.from({ length: 1001 }, (_, i) => ({
      event_id: `${i.toString().padStart(8, '0')}-0000-4000-a000-000000000000`,
      card_id: VALID_CARD_ID,
      selected_answer_ids: [],
      is_correct: false,
      answered_at: '2026-05-25T10:01:00.000Z',
    }))
    const res = await POST(makeReq(makeValidPayload({ events })))
    expect(res.status).toBe(400)
  })

  it('events=[] (空 flush) → 200 ok:true / failed:[]、 study_sessions upsert は実行', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({ events: [] })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    expect(state.sessionUpsertCalls).toHaveLength(1)
    expect(state.submitReviewTxCalls).toHaveLength(0)
  })

  it('session.completed_at 指定 + status="completed" → upsert に渡る', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({
      session: {
        session_id: VALID_SESSION_ID,
        exam_id: VALID_EXAM_ID,
        mode: 'smart',
        card_ids: [VALID_CARD_ID],
        started_at: '2026-05-25T10:00:00.000Z',
        completed_at: '2026-05-25T10:10:00.000Z',
        status: 'completed',
      },
      events: [],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(state.sessionUpsertCalls[0].values.status).toBe('completed')
    expect(state.sessionUpsertCalls[0].values.completedAt).toBeInstanceOf(Date)
    expect(state.sessionUpsertCalls[0].conflictSet.completedAt).toBeInstanceOf(Date)
    // I-1: card_ids は initial insert にしか入らない
    expect(
      Object.prototype.hasOwnProperty.call(
        state.sessionUpsertCalls[0].conflictSet,
        'cardIds',
      ),
    ).toBe(false)
  })

  it('C-1 (S-cache-1 review): study_sessions upsert に tenant 分離 setWhere が付与される (cross-tenant write 防止)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq(makeValidPayload()))
    expect(state.sessionUpsertCalls).toHaveLength(1)
    // setWhere が定義されていれば、 drizzle は UPDATE 句に `AND user_id = $1` を
    // 付ける。 これにより他 user の session_id を upsert で改竄しようとしても
    // ON CONFLICT で UPDATE 句が match せず no-op になる。
    expect(state.sessionUpsertCalls[0].conflictSetWhere).toBeDefined()
    // values 側 (initial insert) には認証 user の id が入る (FK 不整合 / 孤児行を
    // 防ぐ defensive、 仮に attacker が自 user の id で insert しても他 user の
    // session_id と PK collision で UPDATE 経路に倒れ、 setWhere で hard reject)。
    expect(state.sessionUpsertCalls[0].values.userId).toBe(FAKE_USER.id)
  })

  it('F3: per-event tx loop が payload events 配列順で submitReviewTx を呼ぶ (同 card_id 複数回含む)', async () => {
    // 同一 card に複数 events がある場合、 FSRS は answered_at 昇順 (= payload 順) で
    // 適用されなければならない。 route の for-loop が配列順を保つことをここで固定する。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    const T1 = '2026-05-25T10:01:00.000Z'
    const T2 = '2026-05-25T10:02:00.000Z'
    const T3 = '2026-05-25T10:03:00.000Z'

    // payload: 同 card_id (VALID_CARD_ID) を t1, t3 で挟み、 別 card (VALID_CARD_ID_2) を t2 に配置。
    // 順序保証は card_id が同一かどうかに関わらず配列インデックス順で成立する。
    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: T1,
        },
        {
          event_id: VALID_EVENT_ID_2,
          card_id: VALID_CARD_ID_2,
          selected_answer_ids: [],
          is_correct: false,
          answered_at: T2,
        },
        {
          event_id: VALID_EVENT_ID_3,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: T3,
        },
      ],
    })

    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // 3 events がすべて新規 insert → submitReviewTx が 3 回呼ばれる。
    expect(state.submitReviewTxCalls).toHaveLength(3)

    // 呼出順が payload の events 配列順と一致すること。
    // route は `now: new Date(ev.answered_at)` を渡すため、 now.toISOString() で追える。
    expect(state.submitReviewTxCalls[0].cardId).toBe(VALID_CARD_ID)
    expect(state.submitReviewTxCalls[0].now).toEqual(new Date(T1))

    expect(state.submitReviewTxCalls[1].cardId).toBe(VALID_CARD_ID_2)
    expect(state.submitReviewTxCalls[1].now).toEqual(new Date(T2))

    expect(state.submitReviewTxCalls[2].cardId).toBe(VALID_CARD_ID)
    expect(state.submitReviewTxCalls[2].now).toEqual(new Date(T3))
  })
})
