/**
 * tests/contract/review-events-bulk.contract.test.ts
 *
 * Wire-contract snapshot for POST /api/review-events/bulk (FSRS 整合 Sprint A・spec §2)。
 *
 * Frozen faces:
 *   1. request 形 = `{ events: [...] }`(session オブジェクトは廃止)
 *   2. response 形 = 200 `{ ok, failed }` / 400 / 503 + Retry-After
 *   3. 捕捉した DB write の値 (raw Drizzle SQL ではなく抽出値):
 *      answer_events INSERT / cards UPDATE の per-card tuple / applied 反転 /
 *      study_days の対象 day 確保
 *   4. 正誤 2 本立て (spec §6): answer_events は is_correct と rating を **両方** 持ち、
 *      統計列 (last_correct / current_streak) は is_correct 由来・scheduling は rating 由来
 *   5. failed[] の意味 = event_id 衝突のみ。dangling / option 不一致は applied=false で
 *      保存され failed には載らない (再送を構造的に止める終端設計)
 *
 * NOT frozen:
 *   - logger payloads (event/err fields implementation-fragile)
 *   - zod issues array shape (schema-version-fragile)
 *   - 再集計 SQL の AST (session-repository.test.ts が骨格を pin する)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted state (runs before vi.mock factories, before module imports) ──────
const { state } = vi.hoisted(() => ({
  state: {} as import('../fixtures/review-events').ReviewEventsState,
}))

// ── Mocks (all declared before route/fixture imports) ─────────────────────────

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/db/report-rls-context-failure', () => ({
  reportRlsContextFailure: vi.fn(async () => {}),
}))
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: (_userId: string, fn: (tx: unknown) => unknown) => fn(makeFakeTx(state)),
}))

// ── Route under test ──────────────────────────────────────────────────────────
import { POST } from '../../app/api/review-events/bulk/route'

// ── Mocked dependency handles ─────────────────────────────────────────────────
import { getCurrentUser } from '@/lib/auth/ensure-user'

// ── Fixtures ──────────────────────────────────────────────────────────────────
import {
  addCardRow,
  createState,
  decodeValuesFromSql,
  makeFakeTx,
  makeReq,
  makeValidPayload,
  resetState,
  sqlParams,
  FAKE_USER,
  VALID_CARD_ID,
  VALID_EVENT_ID,
  VALID_EVENT_ID_2,
} from '../fixtures/review-events'

// ── BULK_TRANSIENT_RETRY_SEC for Retry-After hard-assert ──────────────────────
import { BULK_TRANSIENT_RETRY_SEC } from '@/lib/retry/classify-bulk-error'

// handler 内で採取される receivedAt を固定する (clamp / created_at の決定性)。
const RECEIVED_AT = new Date('2026-05-26T01:00:00.000Z')

// ── Value extractors (no raw Drizzle SQL/AST objects in snapshots) ────────────

function extractAnswerEventRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    eventId: row['eventId'],
    userId: row['userId'],
    cardId: row['cardId'],
    sessionId: row['sessionId'],
    selectedAnswerIds: row['selectedAnswerIds'],
    isCorrect: row['isCorrect'],
    rating: row['rating'],
    answeredAt: (row['answeredAt'] as Date).toISOString(),
    elapsedMs: row['elapsedMs'],
    applied: row['applied'],
    createdAt: (row['createdAt'] as Date).toISOString(),
  }))
}

function extractCardUpdate() {
  const capture = state.bulkUpdateCapture
  if (!capture) return null
  return decodeValuesFromSql(capture.fromSql).map((t) => ({
    id: t.id,
    reps: t.reps,
    lapses: t.lapses,
    state: t.state,
    answered: t.answered,
    lastCorrect: t.lastCorrect,
    currentStreak: t.currentStreak,
    lastReview: t.lastReview,
  }))
}

function extractAppliedMark() {
  if (state.markAppliedCalls.length === 0) return null
  const params = sqlParams(state.markAppliedCalls[0].where) as string[]
  return {
    set: state.markAppliedCalls[0].set,
    userId: params[0],
    eventIds: params.slice(1),
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/review-events/bulk — wire contract', () => {
  // ── §1 Golden path: full DB write capture ─────────────────────────────────

  it('golden: { ok, failed } + answer_events INSERT / cards UPDATE / applied / study_days', async () => {
    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)

    expect(await res.json()).toMatchSnapshot()
    expect(extractAnswerEventRows(state.answerEventInsertValues!)).toMatchSnapshot()
    expect(extractCardUpdate()).toMatchSnapshot()
    expect(extractAppliedMark()).toMatchSnapshot()
    expect(state.studyDaysInsertValues).toMatchSnapshot()
  })

  // ── §2 正誤 2 本立て (spec §6) ─────────────────────────────────────────────

  it('2 本立て: answer_events は is_correct と rating を両方保持する', async () => {
    await POST(makeReq(makeValidPayload()))
    const row = extractAnswerEventRows(state.answerEventInsertValues!)[0]!
    expect(row.isCorrect).toBe(true)
    expect(row.rating).toBe(3)
  })

  it('2 本立て divergence: rating=3 (前進) + is_correct=false → 統計は false / scheduling は rating', async () => {
    // 統計列 (last_correct / current_streak) は is_correct だけを見る。
    // scheduling (reps / lapses / due) は rating だけを見る。両者は独立に効く。
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
    expect(extractAnswerEventRows(state.answerEventInsertValues!)).toMatchSnapshot()
    expect(extractCardUpdate()).toMatchSnapshot()
  })

  // ── §3 終端設計: applied=false 降格は failed[] に載せない ──────────────────

  it('dangling (card 不在) → applied=false で保存・failed[] は空・cards UPDATE なし', async () => {
    state.cardRows.clear()
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchSnapshot()
    expect(extractAnswerEventRows(state.answerEventInsertValues!)).toMatchSnapshot()
    expect(state.bulkUpdateCallCount).toBe(0)
  })

  it('option 不一致 (A-2) → 当該 event のみ降格・failed[] は空・他 event は適用', async () => {
    const res = await POST(
      makeReq(
        makeValidPayload({
          events: [
            {
              event_id: VALID_EVENT_ID,
              card_id: VALID_CARD_ID,
              selected_answer_ids: ['unknown-option'],
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
    expect(await res.json()).toMatchSnapshot()
    expect(extractAppliedMark()).toMatchSnapshot()
  })

  // ── §4 failed[] = event_id 衝突のみ ───────────────────────────────────────

  it('event_id 衝突 (own-scope 不在 = 他 user の行) → failed[] に載る', async () => {
    state.duplicateEventIds.add(VALID_EVENT_ID)
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchSnapshot()
  })

  // ── §5 clamp ─────────────────────────────────────────────────────────────

  it('clamp: 未来 answered_at は receivedAt に丸め created_at と同一時刻源になる', async () => {
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
              answered_at: '2026-05-26T09:00:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(extractAnswerEventRows(state.answerEventInsertValues!)).toMatchSnapshot()
  })

  // ── §6 error 応答 ────────────────────────────────────────────────────────

  it('400: schema 不正 (rating 欠落) → invalid_payload、DB 未着手', async () => {
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
    expect((await res.json()).error).toBe('invalid_payload')
    expect(state.answerEventInsertValues).toBeNull()
  })

  it('503 + Retry-After: tx throw (transient) → header 値を hard-assert', async () => {
    state.txShouldThrow = true
    const res = await POST(makeReq(makeValidPayload()))

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe(String(BULK_TRANSIENT_RETRY_SEC))
    expect(await res.json()).toMatchSnapshot()
  })

  it('200 no-op: events=[] は tx を張らず { ok, failed: [] }', async () => {
    const res = await POST(makeReq({ events: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchSnapshot()
    expect(state.cardLockCalls).toBe(0)
  })
})
