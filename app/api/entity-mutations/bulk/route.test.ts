// POST /api/entity-mutations/bulk の unit test。
// 実 DB は叩かず、 getCurrentUser / getDb を mock して route handler の制御フロー
// (auth / zod / 冪等 gate / registry dispatch / patch 検証) を検証する。
//
// S-sync-1 で旧 /api/card-mutations/bulk から汎用化。 envelope は entity_type +
// entity_id を持ち、 per-mutation の (entity_type, op) で registry を引く。
// 現状 registry に登録されている entity_type は 'card' のみで、 既存テストの挙動
// (update_field / create / delete + 冪等 + 部分失敗 + log INSERT) を完全に維持する。
//
// Tag-2a Task 2: update_field op は registry → CARD_FIELD_HANDLERS[field] の
// dispatch 経路に変わったため、 mock 対象を旧 `buildSetClause` /
// `applyCardFieldUpdate` から `CARD_FIELD_HANDLERS` 内の各 handler 関数に差し替える。
// envelope は `field: z.string().min(1)` まで緩和されており、 未知 field は
// dispatch 段で 'failed' になる (新 gate)。
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

    // CARD_FIELD_HANDLERS の handler 呼出記録 (registry dispatch 経路の検証用)。
    // 旧 applyCardFieldUpdate の (cardId, userId, setData) 観測点の代替として、
    // (cardId, userId, field, value) を保存する。
    cardFieldUpdateCalls: [] as Array<{
      cardId: string
      userId: string
      field: string
      value: unknown
    }>,
    // 個別 cardId で handler の戻り値を 'failed' に倒すための制御 (orphan / owner mismatch
    // の擬似)。 未設定 cardId は default 'applied'。
    cardFieldUpdateResults: new Map<string, 'applied' | 'failed'>(),

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

// card-field-handlers を mock。
// registry (entity-mutation-registry.ts) は `CARD_FIELD_HANDLERS[field]` を引いて
// 直接呼ぶため、 ここを spy 化すれば update_field の registry dispatch 経路を含めて
// 検証できる (純関数の値検証 zod を test に引き込まない)。
//
// 各 handler は default 'applied'、 cardFieldUpdateResults map で個別 cardId を
// 'failed' に倒せる。 呼出は cardFieldUpdateCalls に積む。
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
    },
  }
})

// apply-card-mutation は create / delete 経路のみ mock。
// (Tag-2a Task 1 で buildSetClause / applyCardFieldUpdate は撤去済み、
// update_field 経路は CARD_FIELD_HANDLERS 経由で別 module 化された。)
vi.mock('@/lib/cards/apply-card-mutation', () => ({
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
import { CARD_FIELD_HANDLERS } from '@/lib/cards/card-field-handlers'
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
  state.cardFieldUpdateCalls = []
  state.cardFieldUpdateResults = new Map()
  state.cardDeleteCalls = []
  state.cardCreateResults = new Map()
  state.cardCreateCalls = []
  state.txShouldThrow = false
  state.loggerWarnCalls = []
  // CARD_FIELD_HANDLERS の各 spy も reset (vi.clearAllMocks は mock factory 内の
  // vi.fn() もクリアするが、 後で mockImplementationOnce 等を上書きした場合に備える)。
  for (const handler of Object.values(CARD_FIELD_HANDLERS)) {
    vi.mocked(handler).mockClear()
  }
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

  it('update_field 正常系: handler dispatch → applied → log INSERT + applied:1', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation({ field: 'title', value: 'Hello' })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    // registry dispatch: CARD_FIELD_HANDLERS.title が呼ばれた
    expect(vi.mocked(CARD_FIELD_HANDLERS.title)).toHaveBeenCalledTimes(1)
    // 他 field の handler は呼ばれていない
    expect(vi.mocked(CARD_FIELD_HANDLERS.sort_key)).not.toHaveBeenCalled()
    expect(vi.mocked(CARD_FIELD_HANDLERS.options)).not.toHaveBeenCalled()

    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
      field: 'title',
      value: 'Hello',
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

  it("update_field: handler が 'failed' 返却 (値検証失敗の擬似) → failed[]、 log INSERT なし", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // title handler を 1 回だけ 'failed' に倒す (= zod safeParse 失敗を擬似)。
    vi.mocked(CARD_FIELD_HANDLERS.title).mockResolvedValueOnce('failed')

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation({ field: 'title', value: '' })] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)

    // handler は呼ばれた (dispatch は成功、 'failed' で返した)
    expect(vi.mocked(CARD_FIELD_HANDLERS.title)).toHaveBeenCalledTimes(1)
    // log INSERT は走らない
    expect(state.mutationInsertValues).toBeNull()
  })

  it('update_field: patch.field が未指定 → envelope zod で失敗 → failed[]', async () => {
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
    // どの handler も呼ばれない
    for (const handler of Object.values(CARD_FIELD_HANDLERS)) {
      expect(vi.mocked(handler)).not.toHaveBeenCalled()
    }
  })

  it("update_field: orphan card (handler 'failed' 返却) → failed[]、 log INSERT なし", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // 該当 cardId のみ 'failed' を返す (= owner-scoped UPDATE で 0 row return の擬似)
    state.cardFieldUpdateResults.set(VALID_CARD_ID, 'failed')

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)

    expect(state.mutationInsertValues).toBeNull()
  })

  it('update_field: 未知 field 名 → dispatch 段で per-mutation failed (handler 呼ばれず log INSERT なし)', async () => {
    // Tag-2a の envelope 緩和: `field: z.string().min(1)` のため、 未知 field 名は
    // envelope zod では弾けない。 代わりに registry の applyCardUpdateField が
    // CARD_FIELD_HANDLERS[field] を lookup し、 未登録なら 'failed' を返す
    // (旧 enum 早期 reject の代替 gate)。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutation = makeUpdateFieldMutation({ field: 'no_such_field', value: 'x' })

    const res = await POST(makeReq({ mutations: [mutation] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)

    // どの handler も呼ばれていない (dispatch lookup 失敗で即 failed)
    for (const handler of Object.values(CARD_FIELD_HANDLERS)) {
      expect(vi.mocked(handler)).not.toHaveBeenCalled()
    }
    // log INSERT も走らない (applied 扱いではないため)
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
    state.cardFieldUpdateResults.set(VALID_CARD_ID, 'failed')

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
    // title handler の 1 回目だけ throw、 2 回目以降は factory 既定 (return 'applied')。
    // mockImplementationOnce のみ使うことで、 本 test 終了後に implementation が
    // 永続的に上書きされる問題を避ける (clearAllMocks は mockImplementation を
    // クリアしないため)。
    vi.mocked(CARD_FIELD_HANDLERS.title).mockImplementationOnce(async () => {
      throw new Error('first call throws')
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
