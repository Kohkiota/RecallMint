/**
 * tests/contract/entity-mutations-bulk.contract.test.ts
 *
 * Wire-contract snapshot for POST /api/entity-mutations/bulk.
 *
 * Frozen faces (spec §3.2 entity-mutations row + P0 brief):
 *   1. Envelope shape: { ok, applied, failed }
 *   2. Extracted DB mutation INSERT values (not raw Drizzle SQL objects — AST-fragile)
 *   3. All 6 error codes:
 *        unauthenticated 401 / user_not_synced 401 / invalid_json 400 /
 *        invalid_payload 400 / duplicate_mutation_id 400 / 503
 *   4. 503 Retry-After header value (hard assert = '30')
 *   5. 200-failed semantics: unknown entity/op/invalid patch → failed[] + HTTP 200
 *   6. skipLog delete: card/tag_category/tag_option .delete → applied counted, NO INSERT
 *   7. Cascade serial fallback: card.create → serial path (Promise.allSettled not called)
 *   8. Op inventory drift guard: 9-pair (entity_type, op) + skipLog/cascadeLike flags
 *   9. Representative tag ops: tag_category.update_field + tag_option.create
 *
 * NOT frozen (§A-excluded):
 *   - Internal logger payloads (event/err fields change with implementation)
 *   - Zod issues array shape (schema-version-fragile)
 *   - timing metrics
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted state (runs before vi.mock factories, before module imports) ───────
// Inlined to avoid import-before-hoisting issues; resetState() from fixtures is
// called in beforeEach to restore to exactly this shape.
const { state } = vi.hoisted(() => ({
  state: {
    existingMutationIds: new Set<string>(),
    mutationInsertValues: null as null | Record<string, unknown>,
    mutationInsertConflictTarget: null as null | unknown,
    cardFieldUpdateCalls: [] as Array<{
      cardId: string
      userId: string
      field: string
      value: unknown
    }>,
    cardFieldUpdateResults: new Map<string, 'applied' | 'failed'>(),
    cardDeleteCalls: [] as Array<{ cardId: string; userId: string }>,
    cardCreateResults: new Map<string, { examNotFound: boolean; created: boolean }>(),
    cardCreateCalls: [] as Array<{ userId: string; input: Record<string, unknown> }>,
    txShouldThrow: false,
    getDbError: null as null | Error,
    loggerWarnCalls: [] as Array<Record<string, unknown>>,
    loggerErrorCalls: [] as Array<Record<string, unknown>>,
  },
}))

// ── Mocks (all declared before route/fixture imports) ─────────────────────────

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn((...args: unknown[]) => {
      state.loggerWarnCalls.push(args[0] as Record<string, unknown>)
    }),
    error: vi.fn((...args: unknown[]) => {
      state.loggerErrorCalls.push(args[0] as Record<string, unknown>)
    }),
    info: vi.fn(),
  },
}))

// card-field-handlers mock: each handler records the call and returns 'applied'
// (or a per-cardId override from state.cardFieldUpdateResults).
vi.mock('@/lib/cards/card-field-handlers', () => {
  const makeHandler = (field: string) =>
    vi.fn(async (_tx: unknown, cardId: string, userId: string, value: unknown) => {
      state.cardFieldUpdateCalls.push({ cardId, userId, field, value })
      return state.cardFieldUpdateResults.get(cardId) ?? 'applied'
    })
  return {
    CARD_FIELD_HANDLERS: {
      title: makeHandler('title'),
      sort_key: makeHandler('sort_key'),
      question_text: makeHandler('question_text'),
      explanation_text: makeHandler('explanation_text'),
      memo: makeHandler('memo'),
      options: makeHandler('options'),
      tag_option_ids: makeHandler('tag_option_ids'),
    },
  }
})

// apply-card-mutation mock: create/delete ops captured in state.
vi.mock('@/lib/cards/apply-card-mutation', () => ({
  applyCardDelete: vi.fn(async (_tx: unknown, cardId: string, userId: string) => {
    state.cardDeleteCalls.push({ cardId, userId })
  }),
  applyCardCreateWithId: vi.fn(
    async (_tx: unknown, userId: string, input: Record<string, unknown>) => {
      state.cardCreateCalls.push({ userId, input })
      const key = input['cardId'] as string
      const result = state.cardCreateResults.get(key)
      if (result !== undefined) return result
      return { examNotFound: false, created: true }
    },
  ),
}))

// apply-tag-mutation mock: all tag apply functions return 'applied'.
// Cascade serial fallback test needs these to be registered so groupMutations
// can detect cascadeLike=true ops and flip serialFallback=true.
vi.mock('@/lib/tags/apply-tag-mutation', () => ({
  applyTagCategoryCreate: vi.fn(async () => 'applied'),
  applyTagCategoryUpdate: vi.fn(async () => 'applied'),
  applyTagCategoryDelete: vi.fn(async () => 'applied'),
  applyTagOptionCreate: vi.fn(async () => 'applied'),
  applyTagOptionUpdate: vi.fn(async () => 'applied'),
  applyTagOptionDelete: vi.fn(async () => 'applied'),
}))

// getDb mock: throws if state.getDbError is set (envelope-level 503 path),
// otherwise returns the fakeDb built from makeFakeDb(state).
// makeFakeDb is imported below and referenced lazily — it is resolved by the
// time getDb() is called in any test (after all module imports are processed).
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => {
    if (state.getDbError) throw state.getDbError
    return makeFakeDb(state)
  }),
}))

// ── Route under test ──────────────────────────────────────────────────────────
import { POST } from '../../app/api/entity-mutations/bulk/route'

// ── Mocked dependency handles ─────────────────────────────────────────────────
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'

// ── Fixtures ──────────────────────────────────────────────────────────────────
import {
  resetState,
  makeFakeDb,
  makeReq,
  FAKE_USER,
  VALID_CARD_ID,
  VALID_CARD_ID_2,
  VALID_MUTATION_ID,
  VALID_MUTATION_ID_2,
  makeUpdateFieldMutation,
  makeDeleteMutation,
  makeCreateMutation,
} from '../fixtures/entity-mutations'

// ── Registry (for inventory drift guard — server-only is stubbed by vitest.config) ──
import { ENTITY_MUTATION_REGISTRY } from '@/lib/sync/server/entity-mutation-registry'

// ── Auth errors ───────────────────────────────────────────────────────────────
import { UnauthenticatedError } from '@/lib/auth/errors'

// ── Tag entity fixed IDs (deterministic, visually synthetic) ─────────────────
const VALID_TAG_CATEGORY_ID = 'cccccccc-cccc-4ccc-accc-cccccccccccc' as const
const VALID_TAG_OPTION_ID   = 'dddddddd-dddd-4ddd-addd-dddddddddddd' as const

// ── Tag mutation factories ────────────────────────────────────────────────────

function makeTagCategoryUpdateMutation(
  overrides: Partial<{
    mutation_id: string
    entity_id: string
    field: string
    value: unknown
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'tag_category',
    entity_id: overrides.entity_id ?? VALID_TAG_CATEGORY_ID,
    op: 'update_field',
    patch: {
      field: overrides.field ?? 'name',
      value: overrides.value ?? 'Updated Category',
    },
    edited_at: '2026-05-30T10:00:00.000Z',
  }
}

function makeTagCategoryDeleteMutation(
  overrides: Partial<{ mutation_id: string; entity_id: string }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'tag_category',
    entity_id: overrides.entity_id ?? VALID_TAG_CATEGORY_ID,
    op: 'delete',
    patch: {},
    edited_at: '2026-05-30T10:00:00.000Z',
  }
}

function makeTagOptionCreateMutation(
  overrides: Partial<{
    mutation_id: string
    entity_id: string
    patch: Record<string, unknown>
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'tag_option',
    entity_id: overrides.entity_id ?? VALID_TAG_OPTION_ID,
    op: 'create',
    patch: overrides.patch ?? {
      category_id: VALID_TAG_CATEGORY_ID,
      name: 'New Option',
    },
    edited_at: '2026-05-30T10:00:00.000Z',
  }
}

function makeTagOptionDeleteMutation(
  overrides: Partial<{ mutation_id: string; entity_id: string }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    entity_type: 'tag_option',
    entity_id: overrides.entity_id ?? VALID_TAG_OPTION_ID,
    op: 'delete',
    patch: {},
    edited_at: '2026-05-30T10:00:00.000Z',
  }
}

// ── Helper: extract serializable fields from mutationInsertValues ─────────────
//
// The raw INSERT values contain:
//   - editedAt: Date instance (serializable via .toISOString())
//   - appliedAt: sql`now()` Drizzle SQL object (AST-fragile — do NOT snapshot content)
//
// We snapshot the extracted primitive fields only to avoid snapshot churn
// when Drizzle internals change.
function extractInsertValues(
  vals: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!vals) return null
  return {
    mutationId:      vals['mutationId'],
    entityType:      vals['entityType'],
    entityId:        vals['entityId'],
    userId:          vals['userId'],
    op:              vals['op'],
    patch:           vals['patch'],
    editedAt:        vals['editedAt'] instanceof Date
                       ? vals['editedAt'].toISOString()
                       : null,
    // appliedAt is sql`now()` — record presence only (not content)
    appliedAtPresent: vals['appliedAt'] !== null &&
                      typeof vals['appliedAt'] === 'object',
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  resetState(state)
  for (const handler of Object.values(CARD_FIELD_HANDLERS)) {
    vi.mocked(handler).mockClear()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/entity-mutations/bulk — wire contract', () => {

  // ── §1 Error codes ────────────────────────────────────────────────────────────

  it('401 unauthenticated: getCurrentUser throws UnauthenticatedError', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('401 user_not_synced: getCurrentUser resolves null (Clerk session present, users row absent)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('400 invalid_json: malformed JSON body', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const req = new Request('http://localhost/api/entity-mutations/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('400 invalid_payload: mutation_id fails UUID validation (envelope zod)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [{
        mutation_id: 'not-a-uuid',
        entity_type: 'card',
        entity_id: VALID_CARD_ID,
        op: 'update_field',
        patch: { field: 'title', value: 'x' },
        edited_at: '2026-05-30T10:00:00.000Z',
      }],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    const body = await res.json()
    // Snapshot error field; issues array is not snapshotted (schema-version-fragile)
    expect(body.error).toBe('invalid_payload')
    expect(body.error).toMatchSnapshot()
  })

  it('400 duplicate_mutation_id: same mutation_id appears twice in one batch', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, entity_id: VALID_CARD_ID }),
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, entity_id: VALID_CARD_ID_2 }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(400)
    // Hard assert: no Retry-After on 400 (permanent error, not retriable)
    expect(res.headers.get('Retry-After')).toBeNull()
    // Hard assert: DB not reached (envelope rejected before any processing)
    expect(state.mutationInsertValues).toBeNull()
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('503 transient_unavailable: envelope-level DB error → Retry-After: 30', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // PG serialization_failure (SQLSTATE 40001) is a known transient code
    const pgErr = new Error('serialization failure')
    ;(pgErr as Error & { code: string }).code = '40001'
    state.getDbError = pgErr

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(503)
    // Hard assert: Retry-After header value = BULK_TRANSIENT_RETRY_SEC (30)
    expect(res.headers.get('Retry-After')).toBe('30')
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  // ── §2 200-failed semantics ───────────────────────────────────────────────────

  it('200-failed: unknown entity_type → failed[] + HTTP 200 (not 400)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [{
        mutation_id: VALID_MUTATION_ID,
        entity_type: 'unknown_entity',
        entity_id: VALID_CARD_ID,
        op: 'update_field',
        patch: { field: 'title', value: 'x' },
        edited_at: '2026-05-30T10:00:00.000Z',
      }],
    }
    const res = await POST(makeReq(payload))
    // §3.2 spec: unknown registry entry → per-mutation failed, NOT envelope 400
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('200-failed: unknown op for known entity_type → failed[] + HTTP 200', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [{
        mutation_id: VALID_MUTATION_ID,
        entity_type: 'card',
        entity_id: VALID_CARD_ID,
        op: 'no_such_op',
        patch: {},
        edited_at: '2026-05-30T10:00:00.000Z',
      }],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot()
  })

  it('200-failed: invalid patch (card.create missing exam_id) → failed[] + HTTP 200, no INSERT', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({
      mutations: [makeCreateMutation({ patch: { title: 'No exam id' } })],
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot()
    // Hard assert: failed mutations never reach the INSERT path
    expect(state.mutationInsertValues).toBeNull()
    expect(state.cardCreateCalls).toHaveLength(0)
  })

  it('200-failed: invalid patch (tag_category.update_field disallowed field) → failed[] + HTTP 200', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // tagCategoryUpdateFieldPatchSchema enforces field: z.enum(['name','color','sort_key'])
    const payload = {
      mutations: [{
        mutation_id: VALID_MUTATION_ID,
        entity_type: 'tag_category',
        entity_id: VALID_TAG_CATEGORY_ID,
        op: 'update_field',
        patch: { field: 'select_type', value: 'multi' }, // select_type is immutable, not in enum
        edited_at: '2026-05-30T10:00:00.000Z',
      }],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot()
    expect(state.mutationInsertValues).toBeNull()
  })

  // ── §3 skipLog delete ─────────────────────────────────────────────────────────

  it('skipLog: card.delete → applied:1 in envelope, NO entity_mutations INSERT', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot() // { ok: true, applied: 1, failed: [] }
    // Hard assert: skipLog=true for card.delete means no INSERT (DDD-move regression guard)
    expect(state.mutationInsertValues).toBeNull()
    // Apply itself ran: applyCardDelete was called
    expect(state.cardDeleteCalls).toHaveLength(1)
    expect(state.cardDeleteCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
    })
  })

  it('skipLog: tag_category.delete → applied:1, NO entity_mutations INSERT', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeTagCategoryDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot()
    expect(state.mutationInsertValues).toBeNull()
  })

  it('skipLog: tag_option.delete → applied:1, NO entity_mutations INSERT', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeTagOptionDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot()
    expect(state.mutationInsertValues).toBeNull()
  })

  // ── §4 cascade serial fallback ────────────────────────────────────────────────

  it('cascade serial fallback: card.create in batch → serial path, Promise.allSettled NOT called', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const allSettledSpy = vi.spyOn(Promise, 'allSettled')

    // 1 non-cascade update_field + 1 cascadeLike card.create → entire batch falls back to serial
    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID,   entity_id: VALID_CARD_ID }),
      makeCreateMutation({      mutation_id: VALID_MUTATION_ID_2,  entity_id: VALID_CARD_ID_2 }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchSnapshot() // { ok: true, applied: 2, failed: [] }

    // Hard assert: serial path taken (groupMutationsByEntityKey detected cascadeLike)
    expect(allSettledSpy).not.toHaveBeenCalled()
    allSettledSpy.mockRestore()
  })

  // ── §5 Op inventory drift guard ───────────────────────────────────────────────
  //
  // This test goes RED if any DDD refactor:
  //   - adds or removes an entity_type from the registry
  //   - adds, removes, or renames an op within any entity_type
  //   - changes skipLog or cascadeLike flags
  //
  // This ensures that tag_* ops cannot break silently after a refactor
  // that only explicitly tests card ops.

  it('op inventory drift guard: 9-pair (entity_type, op) matches HEAD registry + correct flags', () => {
    type FlagExpect = { skipLog: boolean; cascadeLike: boolean }
    const expected: Record<string, Record<string, FlagExpect>> = {
      card: {
        update_field: { skipLog: false, cascadeLike: false },
        create:       { skipLog: false, cascadeLike: true  },
        delete:       { skipLog: true,  cascadeLike: true  },
      },
      tag_category: {
        update_field: { skipLog: false, cascadeLike: false },
        create:       { skipLog: false, cascadeLike: false },
        delete:       { skipLog: true,  cascadeLike: true  },
      },
      tag_option: {
        update_field: { skipLog: false, cascadeLike: false },
        create:       { skipLog: false, cascadeLike: false },
        delete:       { skipLog: true,  cascadeLike: true  },
      },
    }

    // entity_type set must match exactly (no silent additions/removals)
    expect(Object.keys(ENTITY_MUTATION_REGISTRY).sort()).toEqual(
      Object.keys(expected).sort(),
    )

    // per-entity_type: op set + flags must match exactly
    for (const [entityType, expectedOps] of Object.entries(expected)) {
      const entityRegistry = ENTITY_MUTATION_REGISTRY[entityType]
      expect(entityRegistry, `registry[${entityType}] must be defined`).toBeDefined()

      expect(
        Object.keys(entityRegistry!).sort(),
        `${entityType}: op set`,
      ).toEqual(Object.keys(expectedOps).sort())

      for (const [op, expectedFlags] of Object.entries(expectedOps)) {
        const entry = entityRegistry![op]
        expect(entry, `registry[${entityType}][${op}] must exist`).toBeDefined()

        expect(
          !!entry!.skipLog,
          `${entityType}.${op} skipLog`,
        ).toBe(expectedFlags.skipLog)

        expect(
          !!entry!.cascadeLike,
          `${entityType}.${op} cascadeLike`,
        ).toBe(expectedFlags.cascadeLike)
      }
    }
  })

  // ── §6 Representative tag ops ─────────────────────────────────────────────────

  it('tag_category.update_field: applied:1 + entity_mutations INSERT (extracted values)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeTagCategoryUpdateMutation()] }))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchSnapshot()

    // Extracted INSERT values (no Drizzle SQL objects)
    expect(extractInsertValues(state.mutationInsertValues)).toMatchSnapshot()
  })

  it('tag_option.create: applied:1 + entity_mutations INSERT (extracted values)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeTagOptionCreateMutation()] }))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchSnapshot()

    // Extracted INSERT values
    expect(extractInsertValues(state.mutationInsertValues)).toMatchSnapshot()
  })

  // ── §7 card.update_field happy path with extracted mutation INSERT values ──────

  it('card.update_field happy path: envelope + extracted DB mutation INSERT values', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({
      mutations: [makeUpdateFieldMutation({ field: 'title', value: 'Hello' })],
    }))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toMatchSnapshot() // { ok: true, applied: 1, failed: [] }

    // Extracted INSERT values: only primitives + editedAt as ISO string
    // Does NOT snapshot the raw Drizzle SQL object (appliedAt = sql`now()`)
    expect(extractInsertValues(state.mutationInsertValues)).toMatchSnapshot()
  })
})
