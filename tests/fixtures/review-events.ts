/**
 * tests/fixtures/review-events.ts
 *
 * Per-route fixtures for POST /api/review-events/bulk (FSRS 整合 Sprint A の新 wire)。
 *
 * fake tx は **実 chain 形をそのまま模す** — cards / study_days は
 * `.where().orderBy().for('update')`、answer_events の衝突 SELECT は `.where()` で終端。
 * `.where()` は「await 可能かつ .orderBy() を生やせる」thenable にしてある (両方の
 * 終端形を 1 つの fake で満たすため)。
 *
 * Usage:
 *   const { state } = vi.hoisted(() => ({ state: createState() }))
 *   vi.mock('@/lib/db/tenant-tx', () => ({
 *     withTenantTx: (_u, fn) => fn(makeFakeTx(state)),
 *   }))
 */

import { getTableName, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { User } from '@/lib/db/schema'
import { FIXED_USER_ID } from './common'

// ─── VALUES decoder (cards UPDATE の per-card tuple 復元) ──────────────────
//
// Drizzle の sql tagged template は ${value} を queryChunks に直接プリミティブ値
// として格納する (Param ラッパーなし)。StringChunk はクエリテキスト部分なので除外。
// SQL インスタンスと sql.join の結果は再帰展開する。
//
// 各 tuple のフィールド順 (session-repository.ts と同一, 14 列):
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
  if (Array.isArray(obj)) {
    return obj.flatMap((x) => collectParamValues(x, depth + 1))
  }
  const t = typeof obj
  if (t === 'string' || t === 'number' || t === 'boolean' || obj instanceof Date) {
    return [obj]
  }
  return []
}

/** fromSql (Drizzle SQL object) から per-card tuple の配列を復元する。 */
export function decodeValuesFromSql(fromSql: unknown): DecodedCardTuple[] {
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

/** Drizzle の条件式 / SQL から bind パラメータ列を取り出す (where 節の中身検証用)。 */
export function sqlParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as SQL).params
}

// ─── Fixed IDs ────────────────────────────────────────────────────────────

export const FAKE_USER = { id: FIXED_USER_ID } as unknown as User

export const VALID_SESSION_ID = '22222222-2222-4222-a222-222222222222' as const
export const VALID_CARD_ID = '44444444-4444-4444-a444-444444444444' as const
export const VALID_EVENT_ID = '55555555-5555-4555-a555-555555555555' as const
export const VALID_EVENT_ID_2 = '66666666-6666-4666-a666-666666666666' as const
export const VALID_EVENT_ID_3 = '77777777-7777-4777-a777-777777777777' as const
export const VALID_CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as const

// ─── State ────────────────────────────────────────────────────────────────

/** Mutable state captured by the fake tx for the review-events route. */
export interface ReviewEventsState {
  // cards SELECT ... FOR UPDATE (card_id → row)。不在 = ロックされない card。
  cardRows: Map<string, Record<string, unknown>>
  cardLockCalls: number
  cardLockOrderBy: unknown

  // answer_events INSERT
  answerEventInsertValues: null | Record<string, unknown>[]
  /** ON CONFLICT DO NOTHING で弾かれる (= 既存行がある) event_id。 */
  duplicateEventIds: Set<string>
  /** 衝突検証の own-scope SELECT が返す既存行 (event_id → row)。 */
  existingEventRows: Map<string, Record<string, unknown>>

  // answer_events UPDATE (markApplied)
  markAppliedCalls: Array<{ set: Record<string, unknown>; where: unknown }>

  // cards UPDATE (single VALUES UPDATE)
  bulkUpdateCapture: null | {
    set: Record<string, unknown>
    fromSql: unknown
    where: unknown
  }
  bulkUpdateCallCount: number
  bulkUpdateReturnOverride: null | Array<{ id: string }>

  // study_days 再集計
  studyDaysInsertValues: null | Record<string, unknown>[]
  studyDaysLockCalls: number
  executeCalls: unknown[]

  // review_logs bulk INSERT (R0 Task 3・手順 7.5)
  reviewLogsInsertValues: null | Record<string, unknown>[]
  reviewLogsInsertCallCount: number

  /**
   * FOR UPDATE を取った表名を取得順に積む共有 log。cards / study_days を別カウンタで
   * 数えるだけでは「cards → study_days」というロック**順序**の不変条件 (deadlock 回避の
   * 全 tx 共通規約) が pin されない (順序が逆でも両カウンタは 1 のまま) ため、
   * 同一配列に記録して sequence そのものを検証できるようにする。
   */
  lockSequence: string[]

  /** answer_events INSERT 直後に throw させる (rollback テスト用)。 */
  txShouldThrow: boolean
  txError: null | Error
}

export function createState(): ReviewEventsState {
  return {
    cardRows: new Map(),
    cardLockCalls: 0,
    cardLockOrderBy: null,
    answerEventInsertValues: null,
    duplicateEventIds: new Set(),
    existingEventRows: new Map(),
    markAppliedCalls: [],
    bulkUpdateCapture: null,
    bulkUpdateCallCount: 0,
    bulkUpdateReturnOverride: null,
    studyDaysInsertValues: null,
    studyDaysLockCalls: 0,
    executeCalls: [],
    reviewLogsInsertValues: null,
    reviewLogsInsertCallCount: 0,
    lockSequence: [],
    txShouldThrow: false,
    txError: null,
  }
}

/** Reset all fields of `state` in-place (for beforeEach reuse). */
export function resetState(state: ReviewEventsState): void {
  Object.assign(state, createState())
}

// ─── Card row helper ──────────────────────────────────────────────────────

/**
 * Add a card to state.cardRows with FSRS initial values.
 * Default `options` covers ids 'a' and 'b' — the ids used by makeValidPayload.
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

/** 衝突検証が返す「自分の既存行」を積む (内容一致 / 不一致の両ケースで使う)。 */
export function addExistingEventRow(
  state: ReviewEventsState,
  eventId: string,
  overrides: Record<string, unknown> = {},
): void {
  state.existingEventRows.set(eventId, {
    eventId,
    cardId: VALID_CARD_ID,
    sessionId: null,
    selectedAnswerIds: ['a'],
    isCorrect: true,
    rating: 3,
    answeredAt: new Date('2026-05-25T10:01:00.000Z'),
    elapsedMs: null,
    createdAt: new Date('2026-05-25T10:05:00.000Z'),
    ...overrides,
  })
}

// ─── Fake tx ──────────────────────────────────────────────────────────────

function tableNameOf(table: unknown): string {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0])
  } catch {
    return ''
  }
}

/** await でも `.orderBy().for()` でも終端できる thenable を作る。 */
function lockableResult(
  rows: unknown[],
  onLock: (orderBy: unknown, mode: string) => void,
) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & {
    orderBy: (col: unknown) => { for: (mode: string) => Promise<unknown[]> }
  }
  promise.orderBy = (col: unknown) => ({
    for: (mode: string) => {
      onLock(col, mode)
      return Promise.resolve(rows)
    },
  })
  return promise
}

/**
 * Build the fake transaction handle passed to withTenantTx's callback.
 */
export function makeFakeTx(state: ReviewEventsState) {
  return {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => {
        const name = tableNameOf(table)
        return {
          where: (_cond: unknown) => {
            if (name === 'cards') {
              return lockableResult([...state.cardRows.values()], (col) => {
                state.cardLockCalls++
                state.cardLockOrderBy = col
                state.lockSequence.push('cards')
              })
            }
            if (name === 'study_days') {
              // 実 DB では直前の INSERT ... ON CONFLICT DO NOTHING が対象 day の行を
              // 必ず確保するため、ロックは要求 day 数ぶん返る。fake でも同じ形を返す
              // (返さないと recomputeStudyDays の行数 postcondition が常時 throw する)。
              const rows = (state.studyDaysInsertValues ?? []).map((r) => ({
                day: r.day,
              }))
              return lockableResult(rows, () => {
                state.studyDaysLockCalls++
                state.lockSequence.push('study_days')
              })
            }
            // answer_events: 衝突検証の own-scope SELECT (await で終端)
            return lockableResult([...state.existingEventRows.values()], () => {})
          },
        }
      },
    }),

    insert: (table: unknown) => {
      const name = tableNameOf(table)
      return {
        values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = Array.isArray(vals) ? vals : [vals]

          if (name === 'answer_events') {
            state.answerEventInsertValues = rows
            if (state.txShouldThrow) {
              throw state.txError ?? new Error('tx forced throw')
            }
            return {
              onConflictDoNothing: (_conf: unknown) => ({
                returning: (_cols: unknown) =>
                  Promise.resolve(
                    rows
                      .filter((r) => !state.duplicateEventIds.has(r.eventId as string))
                      .map((r) => ({ eventId: r.eventId as string })),
                  ),
              }),
            }
          }

          if (name === 'study_days') {
            state.studyDaysInsertValues = rows
            return { onConflictDoNothing: (_conf: unknown) => Promise.resolve() }
          }

          if (name === 'review_logs') {
            // insertReviewLogs は plain INSERT (onConflictDoNothing なし・spec §4) —
            // .values() を直接 await するだけの形をここでも再現する。
            state.reviewLogsInsertCallCount++
            state.reviewLogsInsertValues = rows
            return Promise.resolve(undefined)
          }

          return { onConflictDoNothing: () => Promise.resolve() }
        },
      }
    },

    update: (table: unknown) => {
      const name = tableNameOf(table)
      if (name === 'answer_events') {
        return {
          set: (vals: Record<string, unknown>) => ({
            where: (cond: unknown) => {
              state.markAppliedCalls.push({ set: vals, where: cond })
              return Promise.resolve()
            },
          }),
        }
      }
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
                  // 実 VALUES に載った card id だけを返す (= 件数一致)。
                  return Promise.resolve(
                    decodeValuesFromSql(fromSql).map((t) => ({ id: t.id })),
                  )
                },
              }
            },
          }),
        }),
      }
    },

    execute: (query: unknown) => {
      state.executeCalls.push(query)
      return Promise.resolve([])
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
 * Build a valid review-events/bulk payload (session オブジェクトは廃止済)。
 * Defaults: single event for VALID_CARD_ID with is_correct=true / rating=3。
 */
export function makeValidPayload(overrides: { events?: unknown[] } = {}) {
  return {
    events: overrides.events ?? [
      {
        event_id: VALID_EVENT_ID,
        card_id: VALID_CARD_ID,
        selected_answer_ids: ['a'],
        is_correct: true,
        rating: 3,
        answered_at: '2026-05-25T10:01:00.000Z',
      },
    ],
  }
}
