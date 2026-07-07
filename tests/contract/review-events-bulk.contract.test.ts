/**
 * tests/contract/review-events-bulk.contract.test.ts
 *
 * Wire-contract snapshot for POST /api/review-events/bulk.
 *
 * Frozen faces (spec §3.2 review-events row + §A + P0 brief):
 *   1. { ok, failed } response shape
 *   2. Captured DB writes (extracted values, NOT raw Drizzle SQL):
 *      sessionUpsert, answerEvent INSERT, reviews INSERT, study_days UPSERT
 *   3. rating derive contract (§A #7):
 *      - answer_events INSERT has NO rating column (ratingPresent: false frozen)
 *      - reviews.rating and study_days.correct_count derived via deriveRating
 *      - correct_count = rating>=2, NOT is_correct
 *      - golden divergence case: rating=3 (Good) + is_correct=false
 *        → reviews.rating=3 AND correct_count=1 (rating>=2 wins over is_correct=false)
 *   4. Branch coverage (each frozen via snapshot):
 *      - duplicate event skip → absent from failed[], FSRS not applied
 *      - orphan event → event_id in failed[], HTTP 200
 *      - tx rollback → all applicable events in failed[], HTTP 200
 *      - 503 + Retry-After header value (hard-assert '30')
 *
 * NOT frozen:
 *   - logger payloads (event/err fields implementation-fragile)
 *   - zod issues array shape (schema-version-fragile)
 *   - timing metrics
 *   - conflictSet SQL expressions (Drizzle AST-fragile)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted state (runs before vi.mock factories, before module imports) ───────
// Inlined to avoid import-before-hoisting issues; resetState() from fixtures is
// called in beforeEach to restore to exactly this shape.
const { state } = vi.hoisted(() => ({
  state: {
    sessionUpsertCalls: [] as Array<{
      values: Record<string, unknown>
      conflictSet: Record<string, unknown>
      conflictSetWhere: unknown
    }>,
    sessionUpsertShouldThrow: false,
    sessionUpsertError: null as null | Error,
    answerEventInsertValues: null as null | Record<string, unknown>[],
    duplicateEventIds: new Set<string>(),
    cardRows: new Map<string, Record<string, unknown>>(),
    bulkUpdateCapture: null as null | {
      set: Record<string, unknown>
      fromSql: unknown
      where: unknown
    },
    bulkUpdateCallCount: 0,
    bulkUpdateReturnOverride: null as null | Array<{ id: string }>,
    reviewsInsertValues: null as null | Record<string, unknown>[],
    studyDaysUpsertCalls: [] as Array<{
      values: Record<string, unknown>
      conflictSet: Record<string, unknown>
    }>,
    executeDistinctRowsOverride: [
      { day: '2026-05-25', distinct_count: 1 },
    ] as Array<{ day: string; distinct_count: number }>,
    executeCallCount: 0,
    executeCalls: [] as unknown[],
    txShouldThrow: false,
  },
}))

// ── Mocks (all declared before route/fixture imports) ─────────────────────────

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => makeFakeDb(state)),
}))

// ── Route under test ──────────────────────────────────────────────────────────
import { POST } from '../../app/api/review-events/bulk/route'

// ── Mocked dependency handles ─────────────────────────────────────────────────
import { getCurrentUser } from '@/lib/auth/ensure-user'

// ── Fixtures ──────────────────────────────────────────────────────────────────
import {
  resetState,
  makeFakeDb,
  makeReq,
  makeValidPayload,
  addCardRow,
  FAKE_USER,
  VALID_CARD_ID,
  VALID_CARD_ID_2,
  VALID_EVENT_ID,
  VALID_EVENT_ID_2,
} from '../fixtures/review-events'

// ── BULK_TRANSIENT_RETRY_SEC for Retry-After hard-assert ──────────────────────
import { BULK_TRANSIENT_RETRY_SEC } from '@/lib/retry/classify-bulk-error'

// ── Value extractors (no raw Drizzle SQL/AST objects in snapshots) ────────────

/**
 * Extract serializable fields from a session upsert call.
 * Converts Date values to ISO strings; flags I-1 (cardIds absent from conflictSet)
 * and C-1 (setWhere defined).
 */
function extractSessionUpsert(call: {
  values: Record<string, unknown>
  conflictSet: Record<string, unknown>
  conflictSetWhere: unknown
}) {
  const { values, conflictSet } = call
  return {
    values: {
      sessionId: values['sessionId'],
      userId: values['userId'],
      examId: values['examId'],
      mode: values['mode'],
      cardIds: values['cardIds'],
      status: values['status'],
      startedAt:
        values['startedAt'] instanceof Date
          ? values['startedAt'].toISOString()
          : values['startedAt'],
      completedAt:
        values['completedAt'] instanceof Date
          ? values['completedAt'].toISOString()
          : (values['completedAt'] ?? null),
    },
    conflictSet: {
      status: conflictSet['status'],
      completedAt:
        conflictSet['completedAt'] instanceof Date
          ? conflictSet['completedAt'].toISOString()
          : (conflictSet['completedAt'] ?? null),
      // I-1: card_ids must NOT be in conflictSet (frozen: false)
      cardIdsPresent: 'cardIds' in conflictSet,
    },
    // C-1: setWhere must be defined (cross-tenant write prevention)
    setWhereDefined: call.conflictSetWhere !== undefined,
  }
}

/**
 * Extract serializable fields from answer_events INSERT rows.
 * Converts answeredAt Date → ISO string.
 * Includes ratingPresent flag to freeze the contract that rating is ABSENT.
 */
function extractAnswerEventRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    eventId: row['eventId'],
    sessionId: row['sessionId'],
    cardId: row['cardId'],
    userId: row['userId'],
    selectedAnswerIds: row['selectedAnswerIds'],
    isCorrect: row['isCorrect'],
    answeredAt:
      row['answeredAt'] instanceof Date
        ? (row['answeredAt'] as Date).toISOString()
        : row['answeredAt'],
    elapsedMs: row['elapsedMs'],
    // rating MUST be absent from answer_events — this is the contract
    ratingPresent: 'rating' in row,
  }))
}

/**
 * Extract serializable fields from reviews INSERT rows.
 * Converts reviewedAt Date → ISO string.
 */
function extractReviewRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    userId: row['userId'],
    cardId: row['cardId'],
    rating: row['rating'],
    reviewedAt:
      row['reviewedAt'] instanceof Date
        ? (row['reviewedAt'] as Date).toISOString()
        : row['reviewedAt'],
  }))
}

/**
 * Extract serializable fields from a study_days UPSERT call.
 * The INSERT values are all primitives. The conflictSet SQL expressions
 * (reviewCount += N, correctCount += N) are Drizzle SQL — not snapshotted.
 */
function extractStudyDayCall(call: {
  values: Record<string, unknown>
  conflictSet: Record<string, unknown>
}) {
  return {
    // INSERT values: all primitives
    values: {
      userId: call.values['userId'],
      day: call.values['day'],
      reviewCount: call.values['reviewCount'],
      correctCount: call.values['correctCount'],
      distinctCardCount: call.values['distinctCardCount'],
    },
    // conflictSet: only distinctCardCount is a plain value (number)
    // reviewCount/correctCount are Drizzle SQL expressions — presence only
    conflictSet: {
      distinctCardCount: call.conflictSet['distinctCardCount'],
      reviewCountIsSql: typeof call.conflictSet['reviewCount'] === 'object',
      correctCountIsSql: typeof call.conflictSet['correctCount'] === 'object',
    },
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  resetState(state)
  // Override distinct rows to match our test day (2026-05-25, 1 distinct card)
  state.executeDistinctRowsOverride = [{ day: '2026-05-25', distinct_count: 1 }]
  // Default: VALID_CARD_ID exists (not orphan)
  addCardRow(state, VALID_CARD_ID)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/review-events/bulk — wire contract', () => {

  // ── §1 Golden path: full DB write capture ─────────────────────────────────

  it('golden: { ok, failed } + all DB writes captured (sessionUpsert + answerEvent + reviews + study_days)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)

    // 1. Response shape { ok, failed }
    const body = await res.json()
    expect(body).toMatchSnapshot()

    // 2. Session upsert (extracted values)
    expect(state.sessionUpsertCalls).toHaveLength(1)
    expect(extractSessionUpsert(state.sessionUpsertCalls[0]!)).toMatchSnapshot()

    // 3. answer_events INSERT (extracted values — no rating column)
    expect(state.answerEventInsertValues).not.toBeNull()
    expect(extractAnswerEventRows(state.answerEventInsertValues!)).toMatchSnapshot()

    // 4. reviews INSERT (rating derived from is_correct=true → 3 Good)
    expect(state.reviewsInsertValues).not.toBeNull()
    expect(extractReviewRows(state.reviewsInsertValues!)).toMatchSnapshot()

    // 5. study_days UPSERT (correct_count=1 because rating=3 >= 2)
    expect(state.studyDaysUpsertCalls).toHaveLength(1)
    expect(extractStudyDayCall(state.studyDaysUpsertCalls[0]!)).toMatchSnapshot()
  })

  // ── §2 rating derive contract ─────────────────────────────────────────────

  it('derive: answer_events INSERT has NO rating column — ratingPresent frozen as false', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    await POST(makeReq(makeValidPayload()))

    expect(state.answerEventInsertValues).not.toBeNull()
    const extracted = extractAnswerEventRows(state.answerEventInsertValues!)
    // Freeze: ratingPresent must be false (rating must never appear in answer_events)
    expect(extracted[0]!.ratingPresent).toBe(false)
    expect(extracted).toMatchSnapshot()
  })

  it('derive divergence: rating=3 (explicit) + is_correct=false → reviews.rating=3 AND study_days.correct_count=1 (rating>=2 wins)', async () => {
    // THE KEY DIVERGENCE CASE (§A #7 / task brief):
    // is_correct=false means the MCQ answer was wrong.
    // rating=3 (Good) is explicitly provided by the client (FSRS rating).
    // deriveRating returns 3 (explicit wins over is_correct fallback).
    // study_days.correct_count uses (rating >= 2), NOT is_correct.
    // So: isCorrect=false BUT correct_count=1 — intentional divergence from MCQ result.
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    const payload = makeValidPayload({
      events: [
        {
          event_id: VALID_EVENT_ID,
          card_id: VALID_CARD_ID,
          selected_answer_ids: ['b'],
          is_correct: false,   // MCQ wrong
          answered_at: '2026-05-25T10:01:00.000Z',
          rating: 3,           // explicit FSRS rating = Good (>= 2)
        },
      ],
    })

    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchSnapshot()

    // answer_events: isCorrect=false preserved (raw MCQ result), no rating column
    expect(state.answerEventInsertValues).not.toBeNull()
    const answerRows = extractAnswerEventRows(state.answerEventInsertValues!)
    expect(answerRows[0]!.isCorrect).toBe(false)       // MCQ result unchanged
    expect(answerRows[0]!.ratingPresent).toBe(false)    // rating absent from answer_events
    expect(answerRows).toMatchSnapshot()

    // reviews: rating=3 (from explicit rating, NOT from is_correct=false→1 fallback)
    expect(state.reviewsInsertValues).not.toBeNull()
    const reviewRows = extractReviewRows(state.reviewsInsertValues!)
    expect(reviewRows[0]!.rating).toBe(3)
    expect(reviewRows).toMatchSnapshot()

    // study_days: correct_count=1 because rating=3 >= 2 (even though is_correct=false)
    expect(state.studyDaysUpsertCalls).toHaveLength(1)
    const studyDayExtracted = extractStudyDayCall(state.studyDaysUpsertCalls[0]!)
    expect(studyDayExtracted.values.correctCount).toBe(1)  // DIVERGENCE: is_correct=false but count=1
    expect(studyDayExtracted).toMatchSnapshot()
  })

  // ── §3 Branch: duplicate event skip ──────────────────────────────────────

  it('duplicate event skip: re-sent event_id → absent from failed[], FSRS not applied', async () => {
    // ON CONFLICT DO NOTHING skips the INSERT for a duplicate event_id.
    // The route must NOT add the duplicate to failed[] (silently skip it).
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.duplicateEventIds.add(VALID_EVENT_ID)

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)

    const body = await res.json()
    // Frozen: { ok: true, failed: [] } — duplicate is NOT in failed
    expect(body).toMatchSnapshot()

    // Hard assert: duplicate is NOT in failed
    expect((body as { failed: string[] }).failed).not.toContain(VALID_EVENT_ID)

    // FSRS not applied (no reviews INSERT, no cards UPDATE)
    expect(state.reviewsInsertValues).toBeNull()
    expect(state.bulkUpdateCallCount).toBe(0)
    // answer_events INSERT was attempted (conflict handled by DB)
    expect(state.answerEventInsertValues).toHaveLength(1)
  })

  // ── §4 Branch: orphan event → failed[] ───────────────────────────────────

  it('orphan: card not found (not in user cards) → event_id in failed[], HTTP 200', async () => {
    // VALID_CARD_ID exists (added in beforeEach); VALID_CARD_ID_2 is NOT added → orphan.
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
          event_id: VALID_EVENT_ID_2,
          card_id: VALID_CARD_ID_2, // orphan — not in state.cardRows
          selected_answer_ids: [],
          is_correct: false,
          answered_at: '2026-05-25T10:02:00.000Z',
        },
      ],
    })

    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)

    const body = await res.json()
    // Frozen: { ok: true, failed: [VALID_EVENT_ID_2] }
    expect(body).toMatchSnapshot()

    // Hard assert: only orphan event in failed, not the valid one
    expect((body as { failed: string[] }).failed).toContain(VALID_EVENT_ID_2)
    expect((body as { failed: string[] }).failed).not.toContain(VALID_EVENT_ID)
  })

  // ── §5 Branch: tx rollback → all applicable events in failed[] ────────────

  it('tx rollback: internal throw → all applicable events in failed[], HTTP 200 (rollback semantics)', async () => {
    // txShouldThrow triggers a throw after answer_events INSERT inside the tx.
    // The route catches it, logs it, and adds ALL applicable (non-orphan) events to failed[].
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.txShouldThrow = true

    const res = await POST(makeReq(makeValidPayload()))
    expect(res.status).toBe(200)

    const body = await res.json()
    // Frozen: { ok: true, failed: [VALID_EVENT_ID] }
    expect(body).toMatchSnapshot()

    // Hard assert: applicable event is in failed
    expect((body as { failed: string[] }).failed).toContain(VALID_EVENT_ID)
  })

  // ── §6 Branch: 503 + Retry-After on transient session upsert failure ──────

  it('503 + Retry-After: session upsert failure → 503 with Retry-After header (hard-assert value)', async () => {
    // Unknown DB error on session upsert → classifyBulkError defaults to transient
    // → 503 + Retry-After header for client retry controller.
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.sessionUpsertShouldThrow = true

    const res = await POST(makeReq(makeValidPayload()))

    // Hard assert status (not snapshot — must not drift to 200/500)
    expect(res.status).toBe(503)

    // Hard assert Retry-After header value = BULK_TRANSIENT_RETRY_SEC (30)
    expect(res.headers.get('Retry-After')).toBe(String(BULK_TRANSIENT_RETRY_SEC))

    const body = await res.json()
    // Frozen: { error: 'session_upsert_failed' }
    expect(body).toMatchSnapshot()

    // Events never processed (session upsert failed before tx)
    expect(state.answerEventInsertValues).toBeNull()
  })
})
