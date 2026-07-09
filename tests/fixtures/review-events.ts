/**
 * tests/fixtures/review-events.ts
 *
 * Per-route fixtures for POST /api/review-events/bulk contract tests.
 *
 * Ported from app/api/review-events/bulk/route.test.ts:
 *   - Fixed IDs (FAKE_USER, VALID_SESSION_ID, VALID_CARD_ID, …)
 *   - Event payload factory (makeValidPayload)
 *   - addCardRow helper (populates cardRows map with FSRS initial state)
 *   - Request builder (makeReq)
 *   - State type + factory (createState / resetState)
 *   - Fake-tx / fakeDb builder (closes over state)
 *
 * Usage in contract tests:
 *   import { createState, makeFakeDb, makeReq, makeValidPayload, addCardRow }
 *     from '../fixtures/review-events'
 *
 *   const { state } = vi.hoisted(() => ({ state: createState() }))
 *   vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => makeFakeDb(state)) }))
 */

import { getTableName } from 'drizzle-orm'
import type { User } from '@/lib/db/schema'
import { FIXED_USER_ID } from './common'

// ─── VALUES decoder (ported from app/api/review-events/bulk/route.test.ts) ──
//
// Drizzle SQL queryChunks から per-card tuple のバインドパラメータ値を収集する。
// Drizzle の sql tagged template は ${value} を queryChunks に直接プリミティブ値
// として格納する (Param ラッパーなし)。StringChunk はクエリテキスト部分なので除外。
// SQL インスタンスと sql.join の結果は再帰展開する。
//
// 各 tuple のフィールド順 (route.ts と同一, 14 列):
//   [0] id, [1] due, [2] stability, [3] difficulty, [4] elapsedDays,
//   [5] scheduledDays, [6] reps, [7] lapses, [8] state, [9] learningSteps,
//   [10] lastReview, [11] answered, [12] lastCorrect, [13] currentStreak

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

function collectParamValues(obj: unknown, depth = 0): unknown[] {
  if (depth > 30) return []
  if (obj === null) return [null]
  if (obj === undefined) return []
  // StringChunk: .value が string[] (配列) を持つ → スキップ
  if (
    typeof obj === 'object' &&
    'value' in obj &&
    Array.isArray((obj as Record<string, unknown>).value) &&
    !(obj as Record<string, unknown>).queryChunks
  ) {
    return []
  }
  // SQL インスタンス: .queryChunks 配列を持つ
  if (typeof obj === 'object' && obj !== null && 'queryChunks' in obj) {
    const chunks = (obj as { queryChunks: unknown[] }).queryChunks
    return chunks.flatMap((c) => collectParamValues(c, depth + 1))
  }
  // 配列
  if (Array.isArray(obj)) {
    return obj.flatMap((x) => collectParamValues(x, depth + 1))
  }
  // プリミティブ値 = バインドパラメータ
  const t = typeof obj
  if (t === 'string' || t === 'number' || t === 'boolean' || obj instanceof Date) {
    return [obj]
  }
  return []
}

/** fromSql (Drizzle SQL object) から per-card tuple の配列を復元する。 */
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

// ─── Fixed IDs ────────────────────────────────────────────────────────────

export const FAKE_USER = { id: FIXED_USER_ID } as unknown as User

export const VALID_SESSION_ID = '22222222-2222-4222-a222-222222222222' as const
export const VALID_EXAM_ID = '33333333-3333-4333-a333-333333333333' as const
export const VALID_CARD_ID = '44444444-4444-4444-a444-444444444444' as const
export const VALID_EVENT_ID = '55555555-5555-4555-a555-555555555555' as const
export const VALID_EVENT_ID_2 = '66666666-6666-4666-a666-666666666666' as const
export const VALID_EVENT_ID_3 = '77777777-7777-4777-a777-777777777777' as const
export const VALID_CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as const

// ─── State ────────────────────────────────────────────────────────────────

/** Mutable state captured by the fake-tx / fakeDb for review-events route. */
export interface ReviewEventsState {
  // study_sessions upsert
  sessionUpsertCalls: Array<{
    values: Record<string, unknown>
    conflictSet: Record<string, unknown>
    conflictSetWhere: unknown
  }>
  sessionUpsertShouldThrow: boolean
  sessionUpsertError: null | Error

  // G1: study_sessions row store — session_id → persisted row.
  // Lets the upsert fake model ON CONFLICT DO UPDATE merge semantics
  // (INSERT when absent / apply conflictSet when userId matches / no-op on
  // userId mismatch) so status-transition + I-1/C-1 goldens can assert the
  // persisted value, not just captured args. sessionUpsertCalls recording is
  // unchanged (additive).
  sessionRows: Map<string, Record<string, unknown>>

  // answer_events insert
  answerEventInsertValues: null | Record<string, unknown>[]
  duplicateEventIds: Set<string>

  // cards SELECT (card_id → row)
  cardRows: Map<string, Record<string, unknown>>

  // cards UPDATE (single VALUES UPDATE)
  bulkUpdateCapture: null | {
    set: Record<string, unknown>
    fromSql: unknown
    where: unknown
  }
  bulkUpdateCallCount: number
  bulkUpdateReturnOverride: null | Array<{ id: string }>

  // reviews INSERT
  reviewsInsertValues: null | Record<string, unknown>[]

  // study_days INSERT/UPSERT
  studyDaysUpsertCalls: Array<{
    values: Record<string, unknown>
    conflictSet: Record<string, unknown>
  }>

  // execute() calls (study_days distinct-count GROUP BY query)
  executeDistinctRowsOverride: null | Array<{
    day: string
    distinct_count: number
  }>
  executeCallCount: number
  executeCalls: unknown[]

  txShouldThrow: boolean
}

/** Create a fresh ReviewEventsState. Use in vi.hoisted or beforeEach. */
export function createState(): ReviewEventsState {
  return {
    sessionUpsertCalls: [],
    sessionUpsertShouldThrow: false,
    sessionUpsertError: null,
    sessionRows: new Map(),
    answerEventInsertValues: null,
    duplicateEventIds: new Set(),
    cardRows: new Map(),
    bulkUpdateCapture: null,
    bulkUpdateCallCount: 0,
    bulkUpdateReturnOverride: null,
    reviewsInsertValues: null,
    studyDaysUpsertCalls: [],
    // Default: two days with distinct_count=2, matching existing test default.
    executeDistinctRowsOverride: [
      { day: '2026-05-25', distinct_count: 2 },
      { day: '2026-05-26', distinct_count: 2 },
    ],
    executeCallCount: 0,
    executeCalls: [],
    txShouldThrow: false,
  }
}

/** Reset all fields of `state` in-place (for beforeEach reuse). */
export function resetState(state: ReviewEventsState): void {
  state.sessionUpsertCalls = []
  state.sessionUpsertShouldThrow = false
  state.sessionUpsertError = null
  state.sessionRows = new Map()
  state.answerEventInsertValues = null
  state.duplicateEventIds = new Set()
  state.cardRows = new Map()
  state.bulkUpdateCapture = null
  state.bulkUpdateCallCount = 0
  state.bulkUpdateReturnOverride = null
  state.reviewsInsertValues = null
  state.studyDaysUpsertCalls = []
  state.executeDistinctRowsOverride = [
    { day: '2026-05-25', distinct_count: 2 },
    { day: '2026-05-26', distinct_count: 2 },
  ]
  state.executeCallCount = 0
  state.executeCalls = []
  state.txShouldThrow = false
}

// ─── Card row helper ──────────────────────────────────────────────────────

/**
 * Add a card to state.cardRows with FSRS initial values.
 * Ported from app/api/review-events/bulk/route.test.ts `addCardRow`.
 *
 * Default `options` covers ids 'a' and 'b' — the ids used by
 * makeValidPayload / existing selected_answer_ids fixtures across this
 * test file, so adding the Task 2 option-existence check doesn't require
 * every call site to pass `options` explicitly.
 */
export function addCardRow(
  state: ReviewEventsState,
  cardId: string,
  overrides: Record<string, unknown> = {},
): void {
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
    options: [
      { id: 'a', text: 'Option A', is_correct: true },
      { id: 'b', text: 'Option B', is_correct: false },
    ],
    ...overrides,
  })
}

// ─── Fake-tx / fakeDb ─────────────────────────────────────────────────────

/**
 * Build the fake transaction object for review-events route.
 * Ported from app/api/review-events/bulk/route.test.ts `makeFakeTx`.
 */
export function makeFakeTx(
  state: ReviewEventsState,
  throwAfterInsert = false,
) {
  const selectChain = {
    from: (_table: unknown) => ({
      where: (_cond: unknown) =>
        Promise.resolve([...state.cardRows.values()]),
    }),
  }

  return {
    select: (_cols?: unknown) => selectChain,

    insert: (table: unknown) => {
      const tname = (() => {
        try {
          return getTableName(table as Parameters<typeof getTableName>[0])
        } catch {
          return ''
        }
      })()

      return {
        values: (
          vals: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          const rows = Array.isArray(vals) ? vals : [vals]

          if (tname === 'answer_events') {
            state.answerEventInsertValues = rows
            if (throwAfterInsert) throw new Error('tx forced throw')
            return {
              onConflictDoNothing: (_conf: unknown) => ({
                returning: (_cols: unknown) => {
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
                  values: rows[0]!,
                  conflictSet: conf.set,
                })
                return Promise.resolve()
              },
            }
          }

          return { onConflictDoUpdate: () => Promise.resolve() }
        },
      }
    },

    update: (_table: unknown) => {
      state.bulkUpdateCallCount++
      return {
        set: (vals: Record<string, unknown>) => ({
          from: (fromSql: unknown) => ({
            where: (cond: unknown) => {
              state.bulkUpdateCapture = { set: vals, fromSql, where: cond }
              return {
                returning: (_cols: unknown) => {
                  if (state.bulkUpdateReturnOverride !== null) {
                    return Promise.resolve(state.bulkUpdateReturnOverride)
                  }
                  // Decode only the card IDs actually present in the
                  // captured VALUES SQL — NOT all cardRows keys.
                  // Ported from app/api/review-events/bulk/route.test.ts
                  // decodeValuesFromSql / makeFakeTx returning logic.
                  const tuples = decodeValuesFromSql(fromSql)
                  return Promise.resolve(tuples.map((t) => ({ id: t.id })))
                },
              }
            },
          }),
        }),
      }
    },

    execute: (query: unknown) => {
      state.executeCallCount++
      state.executeCalls.push(query)
      if (state.executeDistinctRowsOverride !== null) {
        return Promise.resolve(state.executeDistinctRowsOverride)
      }
      return Promise.resolve([])
    },
  }
}

/**
 * Build the top-level fakeDb for the review-events route.
 *
 * @example
 * vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => makeFakeDb(state)) }))
 */
export function makeFakeDb(state: ReviewEventsState) {
  return {
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) =>
        makeSessionUpsertChain(state, vals),
    }),

    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = makeFakeTx(state, state.txShouldThrow)
      return cb(tx)
    },
  }
}

// ─── G1: study_sessions upsert merge semantics ────────────────────────────
//
// Models ON CONFLICT DO UPDATE against state.sessionRows:
//   - no existing row      → INSERT (store full `values` row)
//   - existing, userId ==  → apply conflictSet (LWW merge into stored row)
//   - existing, userId !=  → no-op (tenant isolation = current setWhere behavior)
//
// The returned object is awaited directly by the route (no `.returning()`
// today) AND exposes `.returning()` for future callers (W phase). Making it a
// Promise with an attached `.returning` method keeps both call shapes valid
// without changing the existing `await db.insert()...onConflictDoUpdate()` path.
//
// sessionUpsertCalls recording is preserved verbatim (existing args-capture
// assertions in the 42 consumer tests must keep passing). Status-transition
// GUARD is intentionally NOT modeled here — this fake only does the current
// tenant check (userId match); the guard predicate lands in W (Task 6).

/** Result of a merge attempt: the resulting row, or null when a no-op. */
function applySessionUpsertMerge(
  state: ReviewEventsState,
  vals: Record<string, unknown>,
  conflictSet: Record<string, unknown>,
): Record<string, unknown> | null {
  const sessionId = vals['sessionId'] as string
  const existing = state.sessionRows.get(sessionId)

  // No existing row → INSERT.
  if (existing === undefined) {
    const inserted = { ...vals }
    state.sessionRows.set(sessionId, inserted)
    return inserted
  }

  // Existing row owned by a different user → UPDATE no-op (tenant isolation).
  if (existing['userId'] !== vals['userId']) {
    return null
  }

  // Existing row, same owner → apply conflictSet (LWW). card_ids is insert-only
  // (I-1): the route omits it from conflictSet, so the stored value is retained.
  const merged = { ...existing, ...conflictSet }
  state.sessionRows.set(sessionId, merged)
  return merged
}

function makeSessionUpsertChain(
  state: ReviewEventsState,
  vals: Record<string, unknown>,
) {
  return {
    onConflictDoUpdate: (conf: {
      target: unknown
      set: Record<string, unknown>
      setWhere?: unknown
    }) => {
      if (state.sessionUpsertShouldThrow) {
        throw state.sessionUpsertError ?? new Error('boom')
      }
      state.sessionUpsertCalls.push({
        values: vals,
        conflictSet: conf.set,
        conflictSetWhere: conf.setWhere,
      })
      const merged = applySessionUpsertMerge(state, vals, conf.set)

      // Awaitable (current path) + `.returning()` (future W path).
      const promise = Promise.resolve() as Promise<void> & {
        returning: () => Promise<Record<string, unknown>[]>
      }
      promise.returning = () =>
        Promise.resolve(merged === null ? [] : [merged])
      return promise
    },
  }
}

// ─── Request builder ──────────────────────────────────────────────────────

export function makeReq(payload: unknown): Request {
  return new Request('http://localhost/api/review-events/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ─── Payload factory ──────────────────────────────────────────────────────

/**
 * Build a valid review-events/bulk payload.
 * Defaults: single event for VALID_CARD_ID with is_correct=true.
 */
export function makeValidPayload(
  overrides: {
    events?: unknown[]
    session?: Record<string, unknown>
  } = {},
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
