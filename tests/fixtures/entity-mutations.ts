/**
 * tests/fixtures/entity-mutations.ts
 *
 * Per-route fixtures for POST /api/entity-mutations/bulk contract tests.
 *
 * Ported from app/api/entity-mutations/bulk/route.test.ts:
 *   - Fixed IDs (FAKE_USER, VALID_CARD_ID, VALID_MUTATION_ID, …)
 *   - Mutation payload factories (makeUpdateFieldMutation, makeDeleteMutation,
 *     makeCreateMutation, VALID_CREATE_PATCH)
 *   - Request builder (makeReq)
 *   - Fake-tx / fakeDb builder (accepts state — no global state in fixture)
 *
 * Usage in contract tests:
 *   import { createState, makeFakeDb, makeReq, … } from '../fixtures/entity-mutations'
 *
 *   const { state } = vi.hoisted(() => ({ state: createState() }))
 *   // pass state to vi.mock factories that need it
 *   vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => makeFakeDb(state)) }))
 */

import { getTableName } from 'drizzle-orm'
import type { User } from '@/lib/db/schema'
import { FIXED_USER_ID } from './common'

// ─── Fixed IDs ────────────────────────────────────────────────────────────

export const FAKE_USER = {
  id: FIXED_USER_ID,
} as unknown as User

export const VALID_CARD_ID = '44444444-4444-4444-a444-444444444444' as const
export const VALID_CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as const
export const VALID_MUTATION_ID = '55555555-5555-4555-a555-555555555555' as const
export const VALID_MUTATION_ID_2 = '66666666-6666-4666-a666-666666666666' as const
export const VALID_MUTATION_ID_3 = '77777777-7777-4777-a777-777777777777' as const
export const VALID_EXAM_ID = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee' as const

// ─── State ────────────────────────────────────────────────────────────────

/** Mutable state captured by the fake-tx / fakeDb to enable assertions. */
export interface EntityMutationsState {
  /** mutation_ids known to be "already stored" (idempotency gate). */
  existingMutationIds: Set<string>
  /** Last INSERT values recorded for entity_mutations table. */
  mutationInsertValues: null | Record<string, unknown>
  /** onConflictDoNothing target arg from last INSERT. */
  mutationInsertConflictTarget: null | unknown
  /** Calls captured from CARD_FIELD_HANDLERS mock (update_field path). */
  cardFieldUpdateCalls: Array<{
    cardId: string
    userId: string
    field: string
    value: unknown
  }>
  /**
   * Per-cardId override: 'failed' makes the handler return 'failed'.
   * Unset card IDs default to 'applied'.
   */
  cardFieldUpdateResults: Map<string, 'applied' | 'failed'>
  /** Calls captured from applyCardDelete mock. */
  cardDeleteCalls: Array<{ cardId: string; userId: string }>
  /**
   * Per-cardId override for applyCardCreateWithId.
   * Unset card IDs default to { examNotFound: false, created: true }.
   */
  cardCreateResults: Map<string, { examNotFound: boolean; created: boolean }>
  /** Calls captured from applyCardCreateWithId mock. */
  cardCreateCalls: Array<{ userId: string; input: Record<string, unknown> }>
  /** Set to true to make the tx SELECT/INSERT throw. */
  txShouldThrow: boolean
  /** Non-null to make getDb() throw instead of returning fakeDb. */
  getDbError: null | Error
  /** logger.warn call args captured. */
  loggerWarnCalls: Array<Record<string, unknown>>
  /** logger.error call args captured. */
  loggerErrorCalls: Array<Record<string, unknown>>
}

/** Create a fresh, reset EntityMutationsState. Use in beforeEach or vi.hoisted. */
export function createState(): EntityMutationsState {
  return {
    existingMutationIds: new Set(),
    mutationInsertValues: null,
    mutationInsertConflictTarget: null,
    cardFieldUpdateCalls: [],
    cardFieldUpdateResults: new Map(),
    cardDeleteCalls: [],
    cardCreateResults: new Map(),
    cardCreateCalls: [],
    txShouldThrow: false,
    getDbError: null,
    loggerWarnCalls: [],
    loggerErrorCalls: [],
  }
}

/** Reset all fields of `state` in-place (for use in beforeEach without re-creating). */
export function resetState(state: EntityMutationsState): void {
  state.existingMutationIds = new Set()
  state.mutationInsertValues = null
  state.mutationInsertConflictTarget = null
  state.cardFieldUpdateCalls = []
  state.cardFieldUpdateResults = new Map()
  state.cardDeleteCalls = []
  state.cardCreateResults = new Map()
  state.cardCreateCalls = []
  state.txShouldThrow = false
  state.getDbError = null
  state.loggerWarnCalls = []
  state.loggerErrorCalls = []
}

// ─── Fake-tx / fakeDb ─────────────────────────────────────────────────────

/**
 * Walk a Drizzle SQL-like object to collect Param string values.
 * Used by the fake-tx SELECT chain to resolve the mutation_id from
 * the WHERE condition.
 */
function collectParamValues(cond: unknown): string[] {
  const results: string[] = []
  function walk(obj: unknown) {
    if (obj === null || typeof obj !== 'object') return
    const o = obj as Record<string, unknown>
    if (
      typeof (obj as { constructor?: { name?: string } }).constructor
        ?.name === 'string' &&
      (obj as { constructor: { name: string } }).constructor.name ===
        'Param' &&
      typeof o['value'] === 'string'
    ) {
      results.push(o['value'] as string)
      return
    }
    if ('queryChunks' in o && Array.isArray(o['queryChunks'])) {
      for (const chunk of o['queryChunks'] as unknown[]) walk(chunk)
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item)
    }
  }
  walk(cond)
  return results
}

function extractMutationIdFromWhere(
  state: EntityMutationsState,
  cond: unknown,
): string | null {
  const values = collectParamValues(cond)
  for (const v of values) {
    if (state.existingMutationIds.has(v)) return v
  }
  return null
}

/**
 * Build a fake Drizzle transaction object that captures DB interactions
 * into `state`.
 *
 * Ported from app/api/entity-mutations/bulk/route.test.ts `makeFakeTx`.
 */
export function makeFakeTx(state: EntityMutationsState, shouldThrow = false) {
  return {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: unknown) => ({
          limit: (_n: unknown) => {
            if (shouldThrow) throw new Error('tx forced throw')
            const found = extractMutationIdFromWhere(state, cond) !== null
            return Promise.resolve(found ? [{ mutationId: 'exists' }] : [])
          },
        }),
      }),
    }),

    insert: (table: unknown) => {
      const tname = (() => {
        try {
          return getTableName(table as Parameters<typeof getTableName>[0])
        } catch {
          return ''
        }
      })()

      return {
        values: (vals: Record<string, unknown>) => ({
          onConflictDoNothing: (conf: unknown) => {
            if (tname === 'entity_mutations') {
              state.mutationInsertValues = vals
              state.mutationInsertConflictTarget = conf
            }
            return Promise.resolve()
          },
        }),
      }
    },
  }
}

/**
 * Build the top-level fakeDb object (with `.transaction`) that the route's
 * `getDb()` mock should return.
 *
 * If `state.getDbError` is set, pass it through by throwing in the getDb mock
 * (not here — see usage note below).
 *
 * @example
 * vi.mock('@/lib/db', () => ({
 *   getDb: vi.fn(() => {
 *     if (state.getDbError) throw state.getDbError
 *     return makeFakeDb(state)
 *   }),
 * }))
 */
export function makeFakeDb(state: EntityMutationsState) {
  return {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = makeFakeTx(state, state.txShouldThrow)
      return cb(tx)
    },
  }
}

// ─── Request builder ──────────────────────────────────────────────────────

export function makeReq(payload: unknown): Request {
  return new Request('http://localhost/api/entity-mutations/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ─── Payload factories ────────────────────────────────────────────────────

/** create op patch that passes cardCreatePatchSchema. */
export const VALID_CREATE_PATCH = {
  exam_id: VALID_EXAM_ID,
  title: 'New Card',
  sort_key: 'Q-01',
  question_text: '問題テキスト',
  options: [{ id: 'a', text: 'A', isCorrect: false }],
  explanation_text: null,
  memo: null,
} as const

export function makeUpdateFieldMutation(
  overrides: Partial<{
    mutation_id: string
    entity_id: string
    field: string
    value: unknown
    edited_at: string
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'card',
    entity_id: overrides.entity_id ?? VALID_CARD_ID,
    op: 'update_field',
    patch: {
      field: overrides.field ?? 'title',
      value: overrides.value ?? 'New Title',
    },
    edited_at: overrides.edited_at ?? '2026-05-30T10:00:00.000Z',
  }
}

export function makeDeleteMutation(
  overrides: Partial<{
    mutation_id: string
    entity_id: string
    edited_at: string
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'card',
    entity_id: overrides.entity_id ?? VALID_CARD_ID,
    op: 'delete',
    patch: {},
    edited_at: overrides.edited_at ?? '2026-05-30T10:00:00.000Z',
  }
}

export function makeCreateMutation(
  overrides: Partial<{
    mutation_id: string
    entity_id: string
    edited_at: string
    patch: Record<string, unknown>
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'card',
    entity_id: overrides.entity_id ?? VALID_CARD_ID,
    op: 'create',
    patch: overrides.patch ?? VALID_CREATE_PATCH,
    edited_at: overrides.edited_at ?? '2026-05-30T10:00:00.000Z',
  }
}
