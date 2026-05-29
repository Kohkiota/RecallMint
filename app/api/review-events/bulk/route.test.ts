// POST /api/review-events/bulk の unit test。
// 実 DB は叩かず、 getCurrentUser / getDb を mock して route handler の制御フロー
// (auth / zod / upsert / single-tx / idempotency / orphan / rollback) を検証する。
//
// replayCard は mock しない (純関数・決定論的) — DB result assertions で
// FSRS fold の正しさを間接検証する。
// submitReviewTx は削除済み; tx ops の record で assertする。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// hoisted state (test 間で reset)
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

    // answer_events insert — bulk insert に渡された rows と返却する event_ids を記録
    answerEventInsertValues: null as null | Record<string, unknown>[],
    // duplicate と扱う event_ids (returning() が省く)
    duplicateEventIds: new Set<string>(),

    // cards SELECT が返す行セット (card_id → row)
    // card_id が absent = orphan (not found)
    cardRows: new Map<string, Record<string, unknown>>(),

    // cards UPDATE の single VALUES UPDATE キャプチャ。
    // Phase 2e は 1 tx あたり最大 1 回しか呼ばれない。
    // set: .set() に渡された object
    // fromSql: .from() に渡された Drizzle SQL object (VALUES 節を含む)
    // where: .where() に渡された条件 object
    // callCount: update() が呼ばれた回数 (1 を期待)
    bulkUpdateCapture: null as null | {
      set: Record<string, unknown>
      fromSql: unknown
      where: unknown
    },
    bulkUpdateCallCount: 0,
    // RETURNING の返却を test から差し替える (null = VALUES から全件 decode し件数一致)。
    bulkUpdateReturnOverride: null as null | Array<{ id: string }>,

    // reviews INSERT 記録
    reviewsInsertValues: null as null | Record<string, unknown>[],

    // study_days INSERT/UPSERT 記録
    studyDaysUpsertCalls: [] as Array<{
      values: Record<string, unknown>
      conflictSet: Record<string, unknown>
    }>,

    // execute() (COUNT DISTINCT) の返却値
    executeDistinctResult: [{ c: 2 }] as Array<{ c: number }>,

    // tx を throw させるフラグ (rollback テスト用)
    txShouldThrow: false,
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

// getDb は fakeDb を返す
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => fakeDb),
}))

// ---------------------------------------------------------------------------
// fake tx — transaction callback に渡す drizzle tx 相当の fake
// ---------------------------------------------------------------------------

// tx.select().from().where() — cards SELECT を模倣
// IN 相当: anyOf card_ids の指定を解析する代わりに全 cardRows を返す
// (テストは cardRows に必要な card_id だけ入れて orphan を制御する)
function makeFakeTx(throwAfterInsert = false) {
  // cards SELECT チェーン
  const selectChain = {
    from: (_table: unknown) => ({
      where: (_cond: unknown) =>
        Promise.resolve([...state.cardRows.values()]),
    }),
  }

  return {
    select: (_cols?: unknown) => selectChain,

    // insert への dispatch: answerEvents / reviews / studyDays テーブルを識別する
    insert: (table: unknown) => {
      // table オブジェクトの Symbol(drizzle:Name) で判別
      // fallback: table を JSON 文字列化して "answer_events" / "reviews" / "study_days" を探す
      // drizzle getTableName でテーブル識別 (Symbol 直参照より安全)
      const tname = (() => {
        try {
          return getTableName(table as Parameters<typeof getTableName>[0])
        } catch {
          return ''
        }
      })()

      return {
        values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = Array.isArray(vals) ? vals : [vals]

          if (tname === 'answer_events') {
            state.answerEventInsertValues = rows

            if (throwAfterInsert) {
              throw new Error('tx forced throw')
            }

            return {
              onConflictDoNothing: (_conf: unknown) => ({
                returning: (_cols: unknown) => {
                  // duplicate を除いた rows の eventId を返す
                  const returned = rows
                    .filter(
                      (r) =>
                        !state.duplicateEventIds.has(r.eventId as string),
                    )
                    .map((r) => ({ eventId: r.eventId as string }))
                  return Promise.resolve(returned)
                },
              }),
            }
          }

          if (tname === 'reviews') {
            state.reviewsInsertValues = rows
            return Promise.resolve()
          }

          if (tname === 'study_days') {
            return {
              onConflictDoUpdate: (conf: {
                target: unknown
                set: Record<string, unknown>
              }) => {
                state.studyDaysUpsertCalls.push({
                  values: rows[0],
                  conflictSet: conf.set,
                })
                return Promise.resolve()
              },
            }
          }

          // studySessions など (session upsert は db level で処理するが念のため)
          return {
            onConflictDoUpdate: () => Promise.resolve(),
          }
        },
      }
    },

    // cards UPDATE chain — Phase 2e は単一 VALUES UPDATE (1 round-trip)。
    // .set() → .from(sqlFragment) → .where() のチェーンを記録する。
    update: (_table: unknown) => {
      state.bulkUpdateCallCount++
      return {
        set: (vals: Record<string, unknown>) => ({
          from: (fromSql: unknown) => ({
            where: (cond: unknown) => {
              state.bulkUpdateCapture = { set: vals, fromSql, where: cond }
              return {
                // RETURNING cards.id 模倣。 override 未設定なら VALUES の card_id を全件返す
                // (= finalStates と件数一致 → mismatch なし)。
                returning: (_cols: unknown) => {
                  if (state.bulkUpdateReturnOverride !== null) {
                    return Promise.resolve(state.bulkUpdateReturnOverride)
                  }
                  const tuples = decodeValuesFromSql(fromSql)
                  return Promise.resolve(tuples.map((t) => ({ id: t.id })))
                },
              }
            },
          }),
        }),
      }
    },

    // study_days COUNT DISTINCT
    execute: (_query: unknown) =>
      Promise.resolve(state.executeDistinctResult),
  }
}

// ---------------------------------------------------------------------------
// fakeDb — handler level の db mock
// ---------------------------------------------------------------------------
const fakeDb = {
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

  transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = makeFakeTx(state.txShouldThrow)
    return cb(tx)
  },
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

// 新規カード相当の FSRS 初期 state を cardRows に設定するヘルパー
function addCardRow(cardId: string, overrides: Record<string, unknown> = {}) {
  state.cardRows.set(cardId, {
    id: cardId,
    due: new Date('2026-05-25T00:00:00Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    ...overrides,
  })
}

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

// ---------------------------------------------------------------------------
// VALUES デコーダ: Drizzle SQL object の queryChunks から Param.value を収集し、
// 14 列 / tuple にチャンクして per-card state を復元する。
//
// 各 tuple のフィールド順 (route.ts と同一):
//   [0] id (uuid string)
//   [1] due (ISO string after #5789 fix、 旧 Date)
//   [2] stability (number)
//   [3] difficulty (number)
//   [4] elapsedDays (number)
//   [5] scheduledDays (number)
//   [6] reps (number)
//   [7] lapses (number)
//   [8] state (number)
//   [9] learningSteps (number)
//   [10] lastReview (ISO string | null after #5789 fix)
//   [11] answered (boolean)
//   [12] lastCorrect (boolean | null)
//   [13] currentStreak (number)
// ---------------------------------------------------------------------------
const VALUES_COLS_PER_ROW = 14

type DecodedCardTuple = {
  id: string
  due: unknown
  stability: unknown
  difficulty: unknown
  elapsedDays: unknown
  scheduledDays: unknown
  reps: unknown
  lapses: unknown
  state: unknown
  learningSteps: unknown
  lastReview: unknown
  answered: unknown
  lastCorrect: unknown
  currentStreak: unknown
}

// Drizzle SQL queryChunks を再帰探索してバインドパラメータ値を収集する。
//
// Drizzle の sql tagged template (`sql\`...\``) は ${value} を
// queryChunks に**直接プリミティブ値として**格納する (Param ラッパーなし)。
// StringChunk はクエリテキスト部分 ("::uuid," 等) なので除外する。
// SQL インスタンスと sql.join の結果は再帰展開する。
function collectParamValues(obj: unknown, depth = 0): unknown[] {
  if (depth > 30) return []

  // null は有効なパラメータ値 (lastReview, lastCorrect など)
  if (obj === null) return [null]

  if (obj === undefined) return []

  // StringChunk: クエリテキスト部分 — スキップ
  // StringChunk は .value が string[] (配列) を持つ
  if (
    typeof obj === 'object' &&
    'value' in obj &&
    Array.isArray((obj as Record<string, unknown>).value) &&
    !(obj as Record<string, unknown>).queryChunks
  ) {
    return [] // StringChunk — not a param value
  }

  // SQL インスタンス: .queryChunks 配列を持つ
  if (typeof obj === 'object' && obj !== null && 'queryChunks' in obj) {
    const chunks = (obj as { queryChunks: unknown[] }).queryChunks
    return chunks.flatMap((c) => collectParamValues(c, depth + 1))
  }

  // 配列 (sql.join の内部表現で使われる場合)
  if (Array.isArray(obj)) {
    return obj.flatMap((x) => collectParamValues(x, depth + 1))
  }

  // プリミティブ値 (string / number / boolean / Date) = バインドパラメータ
  const t = typeof obj
  if (t === 'string' || t === 'number' || t === 'boolean' || obj instanceof Date) {
    return [obj]
  }

  // その他のオブジェクト (Column, Table など) はスキップ
  return []
}

// fromSql (Drizzle SQL object) から per-card tuple の配列を復元する
function decodeValuesFromSql(fromSql: unknown): DecodedCardTuple[] {
  const params = collectParamValues(fromSql)
  if (params.length % VALUES_COLS_PER_ROW !== 0) {
    throw new Error(
      `decodeValuesFromSql: expected params count to be multiple of ${VALUES_COLS_PER_ROW}, got ${params.length}`,
    )
  }
  const tuples: DecodedCardTuple[] = []
  for (let i = 0; i < params.length; i += VALUES_COLS_PER_ROW) {
    tuples.push({
      id: params[i] as string,
      due: params[i + 1],
      stability: params[i + 2],
      difficulty: params[i + 3],
      elapsedDays: params[i + 4],
      scheduledDays: params[i + 5],
      reps: params[i + 6],
      lapses: params[i + 7],
      state: params[i + 8],
      learningSteps: params[i + 9],
      lastReview: params[i + 10],
      answered: params[i + 11],
      lastCorrect: params[i + 12],
      currentStreak: params[i + 13],
    })
  }
  return tuples
}

// cardId でタプルを引く便利ラッパー
function getCardTuple(cardId: string): DecodedCardTuple {
  const capture = state.bulkUpdateCapture
  if (!capture) throw new Error('bulkUpdateCapture is null — update was not called')
  const tuples = decodeValuesFromSql(capture.fromSql)
  const found = tuples.find((t) => t.id === cardId)
  if (!found) throw new Error(`No tuple found for cardId=${cardId}`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  state.sessionUpsertCalls = []
  state.sessionUpsertShouldThrow = false
  state.answerEventInsertValues = null
  state.duplicateEventIds = new Set()
  state.cardRows = new Map()
  state.bulkUpdateCapture = null
  state.bulkUpdateCallCount = 0
  state.bulkUpdateReturnOverride = null
  state.reviewsInsertValues = null
  state.studyDaysUpsertCalls = []
  state.executeDistinctResult = [{ c: 2 }]
  state.txShouldThrow = false

  // デフォルトで VALID_CARD_ID を存在する card として設定
  addCardRow(VALID_CARD_ID)
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
    expect(state.answerEventInsertValues).toBeNull()
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
          rating: 5,
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_payload')
    expect(state.answerEventInsertValues).toBeNull()
  })

  it('events 配列が 1001 件 → 400 invalid_payload (zod .max(1000))', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
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

  it('正常系: study_sessions upsert + answer_events insert + cards UPDATE + reviews INSERT', async () => {
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
    // I-1: card_ids は conflict 上書き対象外
    expect(
      Object.prototype.hasOwnProperty.call(
        state.sessionUpsertCalls[0].conflictSet,
        'cardIds',
      ),
    ).toBe(false)
    // C-1: setWhere が定義されていること (cross-tenant write 防止)
    expect(state.sessionUpsertCalls[0].conflictSetWhere).toBeDefined()

    // answer_events bulk insert
    expect(state.answerEventInsertValues).toHaveLength(1)
    expect(state.answerEventInsertValues![0]).toMatchObject({
      eventId: VALID_EVENT_ID,
      sessionId: VALID_SESSION_ID,
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
      isCorrect: true,
    })

    // cards UPDATE は 1 回の single VALUES UPDATE で発行される
    expect(state.bulkUpdateCallCount).toBe(1)
    expect(state.bulkUpdateCapture).not.toBeNull()
    // VALUES の中に VALID_CARD_ID のタプルが含まれる
    const tuple = getCardTuple(VALID_CARD_ID)
    // replayCard によって reps が 1 に増えているはず (初期 0 → 1 apply)
    expect(tuple.reps).toBe(1)
    expect(tuple.answered).toBe(true)

    // reviews INSERT
    expect(state.reviewsInsertValues).toHaveLength(1)
    expect(state.reviewsInsertValues![0]).toMatchObject({
      userId: FAKE_USER.id,
      cardId: VALID_CARD_ID,
      rating: 3, // is_correct=true → derive 3
    })

    // study_days UPSERT
    expect(state.studyDaysUpsertCalls).toHaveLength(1)
    expect(state.studyDaysUpsertCalls[0].values).toMatchObject({
      userId: FAKE_USER.id,
      reviewCount: 1,
      correctCount: 1, // is_correct=true, rating=3 >= 2 → correct
    })
  })

  it('is_correct=false → reviews に rating=1 (Again) が記録される', async () => {
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
    // is_correct=false → derive rating=1
    expect(state.reviewsInsertValues![0]).toMatchObject({ rating: 1 })
    // lastCorrect = false (rating 1 < 2)
    expect(getCardTuple(VALID_CARD_ID).lastCorrect).toBe(false)
    // study_days: correctCount = 0
    expect(state.studyDaysUpsertCalls[0].values).toMatchObject({ correctCount: 0 })
  })

  it('payload に rating=2 (Hard) 明示 → derive を上書きして rating=2 が reviews に入る', async () => {
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
    expect(state.reviewsInsertValues![0]).toMatchObject({ rating: 2 })
  })

  it('payload に rating=4 (Easy) 明示 → reviews に rating=4 が入る', async () => {
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
    expect(state.reviewsInsertValues![0]).toMatchObject({ rating: 4 })
  })

  it('重複 event_id (ON CONFLICT DO NOTHING で returning 0 件) → FSRS 適用 skip、 200 failed:[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.duplicateEventIds.add(VALID_EVENT_ID)

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // answer_events INSERT は試みる
    expect(state.answerEventInsertValues).toHaveLength(1)
    // FSRS apply は行われない (cards UPDATE / reviews INSERT なし)
    expect(state.bulkUpdateCallCount).toBe(0)
    expect(state.bulkUpdateCapture).toBeNull()
    expect(state.reviewsInsertValues).toBeNull()
  })

  it('events=[] (空 flush) → 200 ok:true / failed:[]、 study_sessions upsert は実行', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = makeValidPayload({ events: [] })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })
    expect(state.sessionUpsertCalls).toHaveLength(1)
    expect(state.answerEventInsertValues).toBeNull()
  })

  it('study_sessions upsert 自体が throw → 500 session_upsert_failed、 events 未処理', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.sessionUpsertShouldThrow = true

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'session_upsert_failed' })
    expect(state.answerEventInsertValues).toBeNull()
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
    // I-1: card_ids は initial insert のみ
    expect(
      Object.prototype.hasOwnProperty.call(
        state.sessionUpsertCalls[0].conflictSet,
        'cardIds',
      ),
    ).toBe(false)
  })

  it('C-1: study_sessions upsert に tenant 分離 setWhere が付与される (cross-tenant write 防止)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq(makeValidPayload()))
    expect(state.sessionUpsertCalls).toHaveLength(1)
    expect(state.sessionUpsertCalls[0].conflictSetWhere).toBeDefined()
    expect(state.sessionUpsertCalls[0].values.userId).toBe(FAKE_USER.id)
  })

  it('orphan card (SELECT で返ってこない card_id) → そのイベントのみ failed[]、 他は完走', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // VALID_CARD_ID_2 を cardRows に追加しない → orphan
    addCardRow(VALID_CARD_ID) // VALID_CARD_ID は存在

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
          card_id: VALID_CARD_ID_2, // orphan
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
    // orphan event_id だけ failed[]
    expect(body.failed).toEqual([VALID_EVENT_ID_2])

    // VALID_CARD_ID のイベントは処理された (single VALUES UPDATE が 1 回)
    expect(state.bulkUpdateCallCount).toBe(1)
    // VALUES には VALID_CARD_ID のタプルのみ (orphan VALID_CARD_ID_2 は含まない)
    const tuples = decodeValuesFromSql(state.bulkUpdateCapture!.fromSql)
    expect(tuples).toHaveLength(1)
    expect(tuples[0].id).toBe(VALID_CARD_ID)
    // reviews は VALID_CARD_ID 分のみ
    expect(state.reviewsInsertValues).toHaveLength(1)
    expect(state.reviewsInsertValues![0]).toMatchObject({ cardId: VALID_CARD_ID })
  })

  it('tx 内部 throw (rollback) → 全 applicable events が failed[]、 200 で返す', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // tx の answer_events INSERT 後に throw させる
    state.txShouldThrow = true

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failed: string[] }
    expect(body.ok).toBe(true)
    // applicable events (orphan でない) が全て failed に入る
    expect(body.failed).toContain(VALID_EVENT_ID)
  })

  it('F3: 同一 card_id への複数 events が payload 順で fold され、 reps が apply 数分 increment する', async () => {
    // 旧実装: submitReviewTx が呼出順を assert していた。
    // 新実装: replayCard fold の結果を cards UPDATE の set.reps で間接検証する。
    // 同 card に 2 events → reps = 0 → 2 になるはず。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    addCardRow(VALID_CARD_ID_2) // 2 枚目のカードも追加

    const T1 = '2026-05-25T10:01:00.000Z'
    const T2 = '2026-05-25T10:02:00.000Z'
    const T3 = '2026-05-25T10:03:00.000Z'

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
          card_id: VALID_CARD_ID, // same card as first event
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: T3,
        },
      ],
    })

    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // 3 events に対して reviews 行が 3 件
    expect(state.reviewsInsertValues).toHaveLength(3)

    // single VALUES UPDATE が 1 回 (2 カード分の tuple を含む)
    expect(state.bulkUpdateCallCount).toBe(1)
    const allTuples = decodeValuesFromSql(state.bulkUpdateCapture!.fromSql)
    expect(allTuples).toHaveLength(2)

    // VALID_CARD_ID は 2 events 適用 → reps = 2
    const cardTuple = getCardTuple(VALID_CARD_ID)
    expect(cardTuple.reps).toBe(2)

    // VALID_CARD_ID_2 は 1 event → reps = 1
    const card2Tuple = getCardTuple(VALID_CARD_ID_2)
    expect(card2Tuple.reps).toBe(1)

    // VALID_CARD_ID の 2 回目 apply は is_correct=true → lastCorrect=true
    expect(cardTuple.lastCorrect).toBe(true)

    // VALID_CARD_ID_2 は is_correct=false → lastCorrect=false
    expect(card2Tuple.lastCorrect).toBe(false)
  })

  it('payload 内 重複 event_id → 初回のみ apply (consumedSet で intra-payload dedup)', async () => {
    // 同一 event_id を 2 件含む payload。 server 側 Set(insertedEventIds) + consumedSet で
    // 初回のみ FSRS apply されること (二重 fold で reps が 2 にならない) を検証する。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
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
          event_id: VALID_EVENT_ID, // 同一 event_id (intra-payload duplicate)
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: '2026-05-25T10:02:00.000Z',
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // 初回のみ apply: reviews 1 件、 single VALUES UPDATE 1 回、 reps = 1 (二重 fold なら 2)
    expect(state.reviewsInsertValues).toHaveLength(1)
    expect(state.bulkUpdateCallCount).toBe(1)
    expect(getCardTuple(VALID_CARD_ID).reps).toBe(1)
  })

  it('複数 JST day を跨ぐ events → study_days が day ごとに分かれて upsert される', async () => {
    // JST = UTC+9。 以下 2 件は別 JST 日に落ちる (todayInJst 換算)。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const dayA = '2026-05-25T01:00:00.000Z' // JST 2026-05-25 10:00
    const dayB = '2026-05-26T01:00:00.000Z' // JST 2026-05-26 10:00
    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: dayA,
        },
        {
          event_id: VALID_EVENT_ID_2,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: dayB,
        },
      ],
    })
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // study_days は 2 日分 (day ごと) upsert される
    expect(state.studyDaysUpsertCalls).toHaveLength(2)
    const days = state.studyDaysUpsertCalls
      .map((c) => c.values.day as string)
      .sort()
    expect(days).toEqual(['2026-05-25', '2026-05-26'])
    // 各 day reviewCount=1 / correctCount=1 (どちらも is_correct=true)
    for (const call of state.studyDaysUpsertCalls) {
      expect(call.values.reviewCount).toBe(1)
      expect(call.values.correctCount).toBe(1)
    }
  })

  it('response contract: always { ok: true, failed } with status 200 (normal success)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failed: string[] }
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.failed)).toBe(true)
  })

  it('distinct-state: 2 cards with different event counts → single VALUES UPDATE contains BOTH cards with per-card-distinct final state', async () => {
    // 2 枚のカードに異なる数の event を適用し、
    // single VALUES UPDATE が 1 回だけ呼ばれ、
    // VALUES 内の各タプルが独立した最終 state を持つことを検証する。
    // cardA: 2 events (reps=2), cardB: 1 event (reps=1)
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    addCardRow(VALID_CARD_ID_2) // 2 枚目のカードも追加

    const T1 = '2026-05-25T10:01:00.000Z'
    const T2 = '2026-05-25T10:02:00.000Z'
    const T3 = '2026-05-25T10:03:00.000Z'

    const payload = makeValidPayload({
      events: [
        // cardA: 2 events
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: T1,
        },
        {
          event_id: VALID_EVENT_ID_3,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: T3,
        },
        // cardB: 1 event
        {
          event_id: VALID_EVENT_ID_2,
          card_id: VALID_CARD_ID_2,
          selected_answer_ids: [],
          is_correct: false,
          answered_at: T2,
        },
      ],
    })

    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    // single VALUES UPDATE が 1 回だけ (N=2 cards でも 1 round-trip)
    expect(state.bulkUpdateCallCount).toBe(1)

    // VALUES 内に 2 card のタプルが入っている
    const tuples = decodeValuesFromSql(state.bulkUpdateCapture!.fromSql)
    expect(tuples).toHaveLength(2)

    // cardA: 2 events 適用 → reps=2, lastCorrect=true (2 回目 is_correct=true)
    const tupleA = getCardTuple(VALID_CARD_ID)
    expect(tupleA.reps).toBe(2)
    expect(tupleA.lastCorrect).toBe(true)
    expect(tupleA.answered).toBe(true)

    // cardB: 1 event 適用 → reps=1, lastCorrect=false (is_correct=false)
    const tupleB = getCardTuple(VALID_CARD_ID_2)
    expect(tupleB.reps).toBe(1)
    expect(tupleB.lastCorrect).toBe(false)
    expect(tupleB.answered).toBe(true)
  })

  it('順序不変条件: 同 card の fold は payload 配列順で行われる (answered_at で sort しない)', async () => {
    // 不変条件 #5 の guard。 payload index 0 = Again(rating 1, answered_at 後)、
    // index 1 = Good(rating 3, answered_at 先) という「配列順と answered_at 順が逆」の
    // payload を投げる。
    // - payload 配列順 fold (Again→Good): streak 0→1、 lastCorrect=true (最後=Good)
    // - もし answered_at 昇順に sort してしまうと (Good→Again): streak 1→0、 lastCorrect=false
    // よって lastCorrect=true / currentStreak=1 を assert すれば、 answered_at sort 混入を検出できる。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    const T_LATE = '2026-05-25T10:05:00.000Z'
    const T_EARLY = '2026-05-25T10:01:00.000Z'

    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID, // payload 先頭 = Again、 answered_at は後
          card_id: VALID_CARD_ID,
          selected_answer_ids: [],
          is_correct: false,
          answered_at: T_LATE,
          rating: 1,
        },
        {
          event_id: VALID_EVENT_ID_2, // payload 2 番目 = Good、 answered_at は先
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['a'],
          is_correct: true,
          answered_at: T_EARLY,
          rating: 3,
        },
      ],
    })

    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, failed: [] })

    const tuple = getCardTuple(VALID_CARD_ID)
    // 2 events 適用
    expect(tuple.reps).toBe(2)
    // payload 順 (Again→Good) で fold → 最後の Good が支配的
    expect(tuple.lastCorrect).toBe(true)
    expect(tuple.currentStreak).toBe(1)
  })

  it('RETURNING 件数 mismatch (updated < finalStates) → throw → rollback → applicable 全件 failed[]', async () => {
    // VALUES UPDATE の RETURNING が finalStates 未満を返す状況を mock で再現
    // (実 DB では owner mismatch / 並行削除 等)。 件数照合で throw → tx rollback → failed 全件。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // 1 card / 1 event。 RETURNING を空にして updated=0 vs expected=1 を作る。
    state.bulkUpdateReturnOverride = []

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failed: string[] }
    expect(body.ok).toBe(true)
    // applicable event が全件 failed[] に積まれる (再送で event_id 冪等が効く)
    expect(body.failed).toEqual([VALID_EVENT_ID])
    // UPDATE は 1 回呼ばれた (throw は件数照合段階)
    expect(state.bulkUpdateCallCount).toBe(1)
  })
})
