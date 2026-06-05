// POST /api/entity-mutations/bulk の unit test。
// 実 DB は叩かず、 getCurrentUser / getDb を mock して route handler の制御フロー
// (auth / zod / 冪等 gate / registry dispatch / patch 検証) を検証する。
//
// S-sync-1 で旧 /api/card-mutations/bulk から汎用化。 envelope は entity_type +
// entity_id を持ち、 per-mutation の (entity_type, op) で registry を引く。
// 現状 registry に登録されている entity_type は 'card' のみで、 既存テストの挙動
// (update_field / create / delete + 冪等 + 部分失敗 + log INSERT) を完全に維持する。
//
// 既存 review-events/bulk/route.test.ts の流儀に揃える:
//   - vi.hoisted() で state object を共有
//   - vi.mock() で getCurrentUser / getDb / logger をモック
//   - fake tx を手作りして DB interaction を検証

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { UnauthenticatedError } from '@/lib/auth/errors'
import type { User } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// hoisted state (test 間で reset)
// ---------------------------------------------------------------------------
const { state } = vi.hoisted(() => ({
  state: {
    // entity_mutations SELECT (冪等チェック)
    // mutation_id をキーとして「既存ならそのエントリが返る」
    existingMutationIds: new Set<string>(),

    // entity_mutations INSERT 記録
    mutationInsertValues: null as null | Record<string, unknown>,
    // onConflictDoNothing に渡された target 記録
    mutationInsertConflictTarget: null as null | unknown,

    // applyCardFieldUpdate の mock (lib/cards/apply-card-mutation をモック)
    // entity_id (=card_id) → found:true / false を制御
    cardFieldUpdateResults: new Map<string, boolean>(),
    cardFieldUpdateCalls: [] as Array<{
      cardId: string
      userId: string
      setData: Record<string, unknown>
    }>,

    // applyCardDelete の呼出記録
    cardDeleteCalls: [] as Array<{ cardId: string; userId: string }>,

    // applyCardCreateWithId の mock 制御
    cardCreateResults: new Map<
      string,
      { examNotFound: boolean; created: boolean }
    >(),
    cardCreateCalls: [] as Array<{
      userId: string
      input: Record<string, unknown>
    }>,

    // buildSetClause の mock 制御
    buildSetClauseResults: new Map<
      string,
      { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
    >(),
    buildSetClauseCalls: [] as Array<{ field: string; value: unknown }>,

    // tx を throw させるフラグ
    txShouldThrow: false,

    // logger warn の記録
    loggerWarnCalls: [] as Array<Record<string, unknown>>,
  },
}))

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn((...args: unknown[]) => {
      state.loggerWarnCalls.push(args[0] as Record<string, unknown>)
    }),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

// apply-card-mutation を mock (純関数の validation ロジックを test に引き込まない)。
// registry は apply-card-mutation の関数を直接呼ぶため、 ここを mock すれば
// registry の dispatch 経路も含めて検証できる。
vi.mock('@/lib/cards/apply-card-mutation', () => ({
  buildSetClause: vi.fn((field: string, value: unknown) => {
    state.buildSetClauseCalls.push({ field, value })
    const result = state.buildSetClauseResults.get(field)
    if (result !== undefined) return result
    // default: ok=true、 setData は { [field]: value }
    return { ok: true, data: { [field]: value } }
  }),
  applyCardFieldUpdate: vi.fn(
    async (
      _tx: unknown,
      cardId: string,
      userId: string,
      setData: Record<string, unknown>,
    ) => {
      state.cardFieldUpdateCalls.push({ cardId, userId, setData })
      const found = state.cardFieldUpdateResults.get(cardId) ?? true
      return { found, examId: 'exam-id-stub' }
    },
  ),
  applyCardDelete: vi.fn(async (_tx: unknown, cardId: string, userId: string) => {
    state.cardDeleteCalls.push({ cardId, userId })
  }),
  applyCardCreateWithId: vi.fn(
    async (
      _tx: unknown,
      userId: string,
      input: Record<string, unknown>,
    ) => {
      state.cardCreateCalls.push({ userId, input })
      const key = input['cardId'] as string
      const result = state.cardCreateResults.get(key)
      if (result !== undefined) return result
      // default: exam exists, card inserted successfully
      return { examNotFound: false, created: true }
    },
  ),
}))

// getDb は fakeDb を返す
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => fakeDb),
}))

// ---------------------------------------------------------------------------
// fake tx
// ---------------------------------------------------------------------------

// Drizzle の SQL オブジェクトから Param の値を再帰的に収集する。
function collectParamValues(cond: unknown): string[] {
  const results: string[] = []
  function walk(obj: unknown) {
    if (obj === null || typeof obj !== 'object') return
    const o = obj as Record<string, unknown>
    if (
      typeof (obj as { constructor?: { name?: string } }).constructor?.name === 'string' &&
      (obj as { constructor: { name: string } }).constructor.name === 'Param' &&
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

function extractMutationIdFromWhere(cond: unknown): string | null {
  const values = collectParamValues(cond)
  for (const v of values) {
    if (state.existingMutationIds.has(v)) return v
  }
  return null
}

function makeFakeTx(shouldThrow = false) {
  return {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: unknown) => ({
          limit: (_n: unknown) => {
            if (shouldThrow) throw new Error('tx forced throw')
            // where 条件から mutation_id を取り出し、existingMutationIds に含まれれば
            // 「既存」として 1 行返す。含まれなければ空配列 (新規)。
            const found = extractMutationIdFromWhere(cond) !== null
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

// ---------------------------------------------------------------------------
// fakeDb — handler level の db mock
// ---------------------------------------------------------------------------
const fakeDb = {
  transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = makeFakeTx(state.txShouldThrow)
    return cb(tx)
  },
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { entityMutations } from '@/lib/db/schema'
import { POST } from './route'

const FAKE_USER = { id: '11111111-1111-4111-a111-111111111111' } as unknown as User
const VALID_CARD_ID = '44444444-4444-4444-a444-444444444444'
const VALID_CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const VALID_MUTATION_ID = '55555555-5555-4555-a555-555555555555'
const VALID_MUTATION_ID_2 = '66666666-6666-4666-a666-666666666666'
const VALID_MUTATION_ID_3 = '77777777-7777-4777-a777-777777777777'
const VALID_EXAM_ID = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'

// create op の有効な patch (registry の cardCreatePatchSchema に通るもの)
const VALID_CREATE_PATCH = {
  exam_id: VALID_EXAM_ID,
  title: 'New Card',
  sort_key: 'Q-01',
  question_text: '問題テキスト',
  options: [{ id: 'a', text: 'A', isCorrect: false }],
  explanation_text: null,
  memo: null,
}

function makeReq(payload: unknown): Request {
  return new Request('http://localhost/api/entity-mutations/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function makeUpdateFieldMutation(
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

function makeDeleteMutation(
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

function makeCreateMutation(
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

beforeEach(() => {
  vi.clearAllMocks()
  state.existingMutationIds = new Set()
  state.mutationInsertValues = null
  state.mutationInsertConflictTarget = null
  state.cardFieldUpdateResults = new Map()
  state.cardFieldUpdateCalls = []
  state.cardDeleteCalls = []
  state.cardCreateResults = new Map()
  state.cardCreateCalls = []
  state.buildSetClauseResults = new Map()
  state.buildSetClauseCalls = []
  state.txShouldThrow = false
  state.loggerWarnCalls = []
})

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
describe('POST /api/entity-mutations/bulk', () => {
  // --- 認証 ---

  it('未ログイン (UnauthenticatedError) → 401 unauthenticated、 DB に触れない', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new UnauthenticatedError())
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(state.mutationInsertValues).toBeNull()
  })

  it('Clerk session あるが users 行未 sync (null) → 401 user_not_synced', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'user_not_synced' })
    expect(state.mutationInsertValues).toBeNull()
  })

  // --- zod validation (envelope) ---

  it('invalid JSON body → 400 invalid_json', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const req = new Request('http://localhost/api/entity-mutations/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_json' })
  })

  it('zod validation 失敗 (mutation_id が非 UUID) → 400 invalid_payload + issues', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [
        {
          mutation_id: 'not-a-uuid',
          entity_type: 'card',
          entity_id: VALID_CARD_ID,
          op: 'update_field',
          patch: { field: 'title', value: 'x' },
          edited_at: '2026-05-30T10:00:00.000Z',
        },
      ],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: unknown[] }
    expect(body.error).toBe('invalid_payload')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('未知の (entity_type, op) → per-mutation failed (registry 不在)', async () => {
    // envelope zod は op を string min(1) で通すため、 envelope レベルでは 400 にならない。
    // registry に該当 entry がなければ per-mutation failed として扱う。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [
        {
          mutation_id: VALID_MUTATION_ID,
          entity_type: 'card',
          entity_id: VALID_CARD_ID,
          op: 'unknown_op',
          patch: {},
          edited_at: '2026-05-30T10:00:00.000Z',
        },
      ],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
  })

  it('未知の entity_type → per-mutation failed', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [
        {
          mutation_id: VALID_MUTATION_ID,
          entity_type: 'unknown_entity',
          entity_id: VALID_CARD_ID,
          op: 'update_field',
          patch: { field: 'title', value: 'x' },
          edited_at: '2026-05-30T10:00:00.000Z',
        },
      ],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
  })

  it('mutations 配列が 1001 件 → 400 invalid_payload (zod .max(1000))', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutations = Array.from({ length: 1001 }, (_, i) => ({
      mutation_id: `${i.toString().padStart(8, '0')}-0000-4000-a000-000000000000`,
      entity_type: 'card',
      entity_id: VALID_CARD_ID,
      op: 'delete',
      patch: {},
      edited_at: '2026-05-30T10:00:00.000Z',
    }))
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_payload')
  })

  it('patch が非 object → 400 invalid_payload', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [
        {
          mutation_id: VALID_MUTATION_ID,
          entity_type: 'card',
          entity_id: VALID_CARD_ID,
          op: 'update_field',
          patch: 'not-an-object',
          edited_at: '2026-05-30T10:00:00.000Z',
        },
      ],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_payload')
  })

  // --- 冪等 gate ---

  it('冪等: 同 mutation_id を 2 回 POST → 1 回目 applied:1、 2 回目 applied:0 (mutation log 1 行のみ)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)

    const res1 = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body1.ok).toBe(true)
    expect(body1.applied).toBe(1)
    expect(body1.failed).toHaveLength(0)
    expect(state.mutationInsertValues).not.toBeNull()

    // 2 回目: 同 mutation_id が existingMutationIds にあるとマーク → skip
    state.existingMutationIds.add(VALID_MUTATION_ID)
    state.mutationInsertValues = null
    state.cardFieldUpdateCalls = []

    const res2 = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body2.applied).toBe(0)
    expect(body2.failed).toHaveLength(0)
    expect(state.cardFieldUpdateCalls).toHaveLength(0)
    expect(state.mutationInsertValues).toBeNull()
  })

  it('冪等 mixed batch: 既存 mutation + 新規 mutation → applied:1, skipped:1, log INSERT は新規分のみ', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.existingMutationIds.add(VALID_MUTATION_ID)

    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, entity_id: VALID_CARD_ID }),
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID_2, entity_id: VALID_CARD_ID_2, field: 'title', value: 'New' }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0].cardId).toBe(VALID_CARD_ID_2)

    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues).toMatchObject({
      mutationId: VALID_MUTATION_ID_2,
      entityType: 'card',
      entityId: VALID_CARD_ID_2,
    })
  })

  // --- update_field op ---

  it('update_field 正常系: buildSetClause → applyCardFieldUpdate → log INSERT + applied:1', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation({ field: 'title', value: 'Hello' })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(state.buildSetClauseCalls).toHaveLength(1)
    expect(state.buildSetClauseCalls[0]).toMatchObject({ field: 'title', value: 'Hello' })

    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
    })

    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues).toMatchObject({
      mutationId: VALID_MUTATION_ID,
      entityType: 'card',
      entityId: VALID_CARD_ID,
      userId: FAKE_USER.id,
      op: 'update_field',
    })
  })

  it('update_field: buildSetClause 失敗 → failed[]、 applyCardFieldUpdate は呼ばれない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.buildSetClauseResults.set('title', { ok: false, error: '検証エラー' })

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation({ field: 'title', value: '' })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)

    expect(state.cardFieldUpdateCalls).toHaveLength(0)
    expect(state.mutationInsertValues).toBeNull()
  })

  it('update_field: patch.field が未指定 → failed[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutation = {
      mutation_id: VALID_MUTATION_ID,
      entity_type: 'card',
      entity_id: VALID_CARD_ID,
      op: 'update_field',
      patch: { value: 'something' }, // field キーなし
      edited_at: '2026-05-30T10:00:00.000Z',
    }
    const res = await POST(makeReq({ mutations: [mutation] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
  })

  it('update_field: orphan card (applyCardFieldUpdate found:false) → failed[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.cardFieldUpdateResults.set(VALID_CARD_ID, false)

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)

    expect(state.mutationInsertValues).toBeNull()
  })

  // --- delete op ---

  it('delete 正常系: applyCardDelete → applied:1 (log INSERT なし)', async () => {
    // delete op は registry の skipLog=true により log INSERT をスキップ。
    // 監査 log としての価値が低く、 再送 dedupe は tombstone + 自然冪等で担保する
    // (旧 card-mutations 経路の挙動を維持)。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(state.cardDeleteCalls).toHaveLength(1)
    expect(state.cardDeleteCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
    })

    expect(state.mutationInsertValues).toBeNull()
  })

  it('delete: idempotent — 存在しない card も applied:1 (applyCardDelete は silent success)、log INSERT なし', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)
    expect(state.mutationInsertValues).toBeNull()
  })

  // --- create op ---

  it('create 正常系: applyCardCreateWithId → log INSERT → applied:1', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeCreateMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(state.cardCreateCalls).toHaveLength(1)
    expect(state.cardCreateCalls[0]).toMatchObject({
      userId: FAKE_USER.id,
      input: { cardId: VALID_CARD_ID, examId: VALID_EXAM_ID },
    })

    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues).toMatchObject({
      mutationId: VALID_MUTATION_ID,
      entityType: 'card',
      entityId: VALID_CARD_ID,
      userId: FAKE_USER.id,
      op: 'create',
    })
  })

  it('create: 冪等再送 (同 mutation_id 既存) → gate skip, applied:0', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.existingMutationIds.add(VALID_MUTATION_ID)

    const res = await POST(makeReq({ mutations: [makeCreateMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toHaveLength(0)

    expect(state.cardCreateCalls).toHaveLength(0)
    expect(state.mutationInsertValues).toBeNull()
  })

  it('create: exam 不在 (examNotFound) → failed[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.cardCreateResults.set(VALID_CARD_ID, { examNotFound: true, created: false })

    const res = await POST(makeReq({ mutations: [makeCreateMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)

    expect(state.mutationInsertValues).toBeNull()
  })

  it('create: patch 不正 (exam_id 欠如) → per-mutation failed[]、applyCardCreateWithId 呼ばれない', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const badPatch = { title: 'No exam id' }
    const res = await POST(makeReq({ mutations: [makeCreateMutation({ patch: badPatch })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
    expect(state.cardCreateCalls).toHaveLength(0)
  })

  it('create: patch 不正 (question_text 欠如) → per-mutation failed[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const badPatch = {
      exam_id: VALID_EXAM_ID,
      title: 'Title',
      sort_key: null,
      options: [{ id: 'a', text: 'A', isCorrect: false }],
      explanation_text: null,
      memo: null,
    }
    const res = await POST(makeReq({ mutations: [makeCreateMutation({ patch: badPatch })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
    expect(state.cardCreateCalls).toHaveLength(0)
  })

  it("create: sort_key='' / explanation_text='' / memo='' → applyCardCreateWithId に null で渡す (UPDATE path と同じ正規化)", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const patchWithEmpty = {
      ...VALID_CREATE_PATCH,
      sort_key: '',
      explanation_text: '',
      memo: '',
    }
    const res = await POST(makeReq({ mutations: [makeCreateMutation({ patch: patchWithEmpty })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(state.cardCreateCalls).toHaveLength(1)
    const input = state.cardCreateCalls[0]!.input
    expect(input['sortKey']).toBeNull()
    expect(input['explanationText']).toBeNull()
    expect(input['memo']).toBeNull()
  })

  it('create: ON CONFLICT skip (別 mutation_id 同 entity_id) → { created: false } → log INSERT → applied:1', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.cardCreateResults.set(VALID_CARD_ID, { examNotFound: false, created: false })

    const res = await POST(makeReq({ mutations: [makeCreateMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(state.mutationInsertValues).not.toBeNull()
  })

  it('update_field の per-op patch 検証: field が不正値 → per-mutation failed[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const badMutation = {
      mutation_id: VALID_MUTATION_ID,
      entity_type: 'card',
      entity_id: VALID_CARD_ID,
      op: 'update_field',
      patch: { field: 'not_a_valid_field', value: 'x' },
      edited_at: '2026-05-30T10:00:00.000Z',
    }
    const res = await POST(makeReq({ mutations: [badMutation] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
    expect(state.cardFieldUpdateCalls).toHaveLength(0)
  })

  // --- 複数 mutations の独立処理 ---

  it('複数 mutations: update_field + delete が個別に処理される', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, entity_id: VALID_CARD_ID }),
      makeDeleteMutation({ mutation_id: VALID_MUTATION_ID_2, entity_id: VALID_CARD_ID_2 }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(2)
    expect(body.failed).toHaveLength(0)

    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0].cardId).toBe(VALID_CARD_ID)
    expect(state.cardDeleteCalls).toHaveLength(1)
    expect(state.cardDeleteCalls[0].cardId).toBe(VALID_CARD_ID_2)
  })

  it('複数 mutations: 一部 failed でも他は applied、 200 で返す (部分失敗)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.cardFieldUpdateResults.set(VALID_CARD_ID, false)

    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, entity_id: VALID_CARD_ID }),
      makeDeleteMutation({ mutation_id: VALID_MUTATION_ID_2, entity_id: VALID_CARD_ID_2 }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toEqual([VALID_MUTATION_ID])
  })

  it('mutations が空配列 → 200 applied:0 failed:[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(0)
    expect(body.failed).toHaveLength(0)
  })

  // --- 予期せぬ throw ---

  it('tx 内 throw (DB 接続障害等) → その mutation を failed[]、 logger.warn、 200 で返す', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.txShouldThrow = true

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
    expect(state.loggerWarnCalls).toHaveLength(1)
    expect(state.loggerWarnCalls[0]).toMatchObject({
      event: 'entity_mutations.bulk.mutation_failed',
      mutationId: VALID_MUTATION_ID,
      entityType: 'card',
    })
  })

  it('tx throw が 1 件: 他の mutations は引き続き処理される', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const { applyCardFieldUpdate } = await import('@/lib/cards/apply-card-mutation')
    let callCount = 0
    vi.mocked(applyCardFieldUpdate).mockImplementation(async (_tx, cardId, userId, setData) => {
      state.cardFieldUpdateCalls.push({ cardId, userId, setData })
      callCount++
      if (callCount === 1) throw new Error('first call throws')
      return { found: true, examId: 'exam-id-stub' }
    })

    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID }),
      makeDeleteMutation({ mutation_id: VALID_MUTATION_ID_2 }),
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID_3 }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.failed).toContain(VALID_MUTATION_ID)
    expect(body.applied).toBe(2)
  })

  // --- response contract ---

  it('response contract: always { ok: true, applied, failed } with status 200', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(typeof body.applied).toBe('number')
    expect(Array.isArray(body.failed)).toBe(true)
  })

  // --- log INSERT 確認 ---

  it('onConflictDoNothing target が mutation_id 列を指す (並走 race backstop)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(state.mutationInsertConflictTarget).not.toBeNull()
    const target = (state.mutationInsertConflictTarget as Record<string, unknown>)['target']
    expect((target as { name: string }).name).toBe(entityMutations.mutationId.name)
    expect((target as { name: string }).name).toBe('mutation_id')
  })

  it('log INSERT に appliedAt (sql now()) が含まれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(state.mutationInsertValues).not.toBeNull()
    expect(typeof state.mutationInsertValues!['appliedAt']).toBe('object')
  })

  it('log INSERT に editedAt (Date インスタンス) が含まれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq({ mutations: [makeUpdateFieldMutation({ edited_at: '2026-05-30T10:00:00.000Z' })] }))
    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues!['editedAt']).toBeInstanceOf(Date)
  })
})
