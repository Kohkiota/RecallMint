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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

    // T-A1: envelope-level 致命 error (getDb 経路で throw 等) を simulate するため、
    // getDb() 自体を throw させる error を test 側から差し替え可能にする。
    // null = 既存挙動 (fakeDb を返す)、 非 null = throw する error。
    getDbError: null as null | Error,

    // logger warn の記録
    loggerWarnCalls: [] as Array<Record<string, unknown>>,
    // T-A1 用: envelope-level error の log を観測する (logger.error 呼出)
    loggerErrorCalls: [] as Array<Record<string, unknown>>,
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
    error: vi.fn((...args: unknown[]) => {
      state.loggerErrorCalls.push(args[0] as Record<string, unknown>)
    }),
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
      // Tag-2c: card 編集 UI からのタグ付与/解除 (whole-set replace + cards.updated_at bump)
      tag_option_ids: makeHandler('tag_option_ids'),
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

// apply-tag-mutation は cascade serial fallback 検証 (T-B3 case (b)) で
// `tag_category.delete` / `tag_option.delete` の registry path を踏むため mock 化。
// 戻り値は 'applied' 固定 (= cascade serial 経路の挙動確認が目的、 apply 内部は
// 別 test で覆われている)。
vi.mock('@/lib/tags/apply-tag-mutation', () => ({
  applyTagCategoryCreate: vi.fn(async () => 'applied'),
  applyTagCategoryUpdate: vi.fn(async () => 'applied'),
  applyTagCategoryDelete: vi.fn(async () => 'applied'),
  applyTagOptionCreate: vi.fn(async () => 'applied'),
  applyTagOptionUpdate: vi.fn(async () => 'applied'),
  applyTagOptionDelete: vi.fn(async () => 'applied'),
}))

// getDb は fakeDb を返す (T-A1: state.getDbError 設定で throw に切替可能)
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => {
    if (state.getDbError) throw state.getDbError
    return fakeDb
  }),
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
import { assertSequentialPath } from '@/lib/sync/server/group-mutations-by-entity-key'
// logger は (f) group-level fatal で `mockImplementationOnce` 用に直接参照する。
import { logger } from '@/lib/logger'
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
  options: [{ id: 'a', uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'A', isCorrect: false }],
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
  state.getDbError = null
  state.loggerWarnCalls = []
  state.loggerErrorCalls = []
  // CARD_FIELD_HANDLERS の各 spy も reset (vi.clearAllMocks は mock factory 内の
  // vi.fn() もクリアするが、 後で mockImplementationOnce 等を上書きした場合に備える)。
  for (const handler of Object.values(CARD_FIELD_HANDLERS)) {
    vi.mocked(handler).mockClear()
  }
})

// spy (= `Promise.allSettled` を `vi.spyOn` で奪う case 群) が test 内 throw で
// `mockRestore` を skip した時に global state が次 test に漏れるのを防ぐ。
// 各 test 末尾の明示 `mockRestore()` と二重防御 (review Minor 2 反映)。
afterEach(() => {
  vi.restoreAllMocks()
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

  it("update_field: field='tag_option_ids' → tag_option_ids handler が dispatch される (Tag-2c)", async () => {
    // Tag-2c: card 編集 UI からのタグ付与/解除も既存 update_field op + dispatch table に
    // 1 entry 追加するだけで成立することを保証する。 envelope は無修正、 他 handler は
    // 呼ばれない、 applied → log INSERT、 までを 1 回で検証。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const OPT_UUID = '99999999-9999-4999-a999-999999999999'
    const res = await POST(
      makeReq({
        mutations: [
          makeUpdateFieldMutation({ field: 'tag_option_ids', value: [OPT_UUID] }),
        ],
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    expect(vi.mocked(CARD_FIELD_HANDLERS.tag_option_ids)).toHaveBeenCalledTimes(1)
    // 他 field の handler は呼ばれていない (dispatch 排他)
    expect(vi.mocked(CARD_FIELD_HANDLERS.title)).not.toHaveBeenCalled()
    expect(vi.mocked(CARD_FIELD_HANDLERS.options)).not.toHaveBeenCalled()

    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
      field: 'tag_option_ids',
      value: [OPT_UUID],
    })

    // applied → log INSERT 発火
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

  // --- T-A1: envelope-level transient classification (audit §10.3 (b) #11) ---

  it('T-A1: envelope-level で transient PG code (40001) を catch → 503 + Retry-After:30', async () => {
    // getDb 経路で transient SQLSTATE を持つ error を simulate する (実機では
    // connection 全断 / serialization failure 等が envelope-level に到達する経路)。
    // client retry controller (lib/retry/transient-error.ts) は HTTP 503 を transient
    // 判定 → 自動 backoff retry が成立。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const pgErr = new Error('serialization failure')
    ;(pgErr as Error & { code: string }).code = '40001'
    state.getDbError = pgErr

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('transient_unavailable')
    // envelope_failed の log が出る
    expect(state.loggerErrorCalls.length).toBeGreaterThan(0)
    expect(state.loggerErrorCalls[0]).toMatchObject({
      event: 'entity_mutations.bulk.envelope_failed',
    })
  })

  it('T-A1: envelope-level で unknown DB error → 503 default (silent lost write 回避 regression)', async () => {
    // unknown DB error を permanent (例: 500) に倒すと、 transient 由来の失敗が
    // outbox 削除されて silent lost write を再来させる。 default は transient で
    // 503 を返す (spec §1.1 目的 3 整合)。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.getDbError = new Error('unexpected envelope-level failure')

    const res = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('transient_unavailable')
  })

  it('T-A1: 明示 permanent 4xx (zod validation failure) は 既存挙動 (400 系) を維持', async () => {
    // T-A1 (OT 裁定 2026-06-12): zod 等の明示 4xx は default transient 対象外。
    // 400 が既存挙動として維持されることを assert (envelope catch 経由ではなく
    // 既存 payloadSchema.safeParse 経路で 400 が返るため、 helper 経路に到達しない)。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(
      makeReq({
        mutations: [
          {
            mutation_id: 'not-a-uuid', // 不正 envelope
            entity_type: 'card',
            entity_id: VALID_CARD_ID,
            op: 'update_field',
            patch: { field: 'title', value: 'x' },
            edited_at: '2026-05-30T10:00:00.000Z',
          },
        ],
      }),
    )
    expect(res.status).toBe(400)
    // Retry-After header は付与しない (400 は permanent、 retry 対象外)
    expect(res.headers.get('Retry-After')).toBeNull()
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_payload')
  })

  // ---------------------------------------------------------------------------
  // T-B3 #1b: 順序保証付き選択並列化 (Y-2 最大リスク task の中核)
  //
  // 並列化の検証戦略 (Promise.allSettled spy):
  //   group helper の戻り値 `serialFallback` を信頼して route が分岐するため、
  //   「並列 path を踏んだ」 = 「`Promise.allSettled` が呼ばれた」 の対応で十分。
  //   timing ベースの overlap 観測は flake 源になるので採らず、 spy で path を pin する。
  //   group 内 for-of は通常 path で serial mode = no-op の `assertSequentialPath` を踏む。
  //
  // R8 念押し:
  //   per-mutation 内部 throw は group 内 catch (= logger.warn + failed[] 積み) で吸い込み、
  //   envelope-level 致命 (= getDb 失敗 等の外側 catch) は並列化前後で不変。 case (e) が
  //   この 2 層分類が並列化で崩れないことを pin する。
  // ---------------------------------------------------------------------------

  // (a) 10 独立 key 並列発火
  it('T-B3 (a): 10 件異 entity_id の update_field → 並列 path (Promise.allSettled 経由) + applied:10 + 入力順保持', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const allSettledSpy = vi.spyOn(Promise, 'allSettled')

    // 10 件すべて異なる entity_id (= 10 独立 group)、 全件 update_field (= 非 cascade)
    const mutations = Array.from({ length: 10 }, (_, i) => {
      const cardId = `bbbbbbbb-bbbb-4bbb-aaaa-${String(i).padStart(12, '0')}`
      const mutationId = `cccccccc-cccc-4ccc-aaaa-${String(i).padStart(12, '0')}`
      return makeUpdateFieldMutation({
        mutation_id: mutationId,
        entity_id: cardId,
        field: 'title',
        value: `t-${i}`,
      })
    })

    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      applied: number
      failed: string[]
    }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(10)
    expect(body.failed).toHaveLength(0)

    // 並列 path: route が group 間で `Promise.allSettled` を 1 回呼ぶ
    expect(allSettledSpy).toHaveBeenCalledTimes(1)
    // CARD_FIELD_HANDLERS.title が 10 回呼ばれた (10 件すべて dispatch 成功)
    expect(vi.mocked(CARD_FIELD_HANDLERS.title)).toHaveBeenCalledTimes(10)
    allSettledSpy.mockRestore()
  })

  // (b) cascade serial 倒れ (4 op subtest 網羅)
  describe('T-B3 (b): cascade-like 1 件混在 → 全体 serial fallback (4 op 網羅)', () => {
    const cascadeFixtures: Array<{
      label: string
      makeMutation: (mutationId: string) => Record<string, unknown>
    }> = [
      {
        label: 'card.create',
        makeMutation: (mutationId) =>
          makeCreateMutation({
            mutation_id: mutationId,
            entity_id: 'cafe0000-0000-4000-a000-000000000001',
          }),
      },
      {
        label: 'card.delete',
        makeMutation: (mutationId) =>
          makeDeleteMutation({
            mutation_id: mutationId,
            entity_id: 'cafe0000-0000-4000-a000-000000000002',
          }),
      },
      {
        label: 'tag_category.delete',
        makeMutation: (mutationId) => ({
          mutation_id: mutationId,
          entity_type: 'tag_category',
          entity_id: 'cafe0000-0000-4000-a000-000000000003',
          op: 'delete',
          patch: {},
          edited_at: '2026-05-30T10:00:00.000Z',
        }),
      },
      {
        label: 'tag_option.delete',
        makeMutation: (mutationId) => ({
          mutation_id: mutationId,
          entity_type: 'tag_option',
          entity_id: 'cafe0000-0000-4000-a000-000000000004',
          op: 'delete',
          patch: {},
          edited_at: '2026-05-30T10:00:00.000Z',
        }),
      },
    ]

    for (const { label, makeMutation } of cascadeFixtures) {
      it(`${label} を 1 件含む 11 件 mixed → applied:11, failed:[]、 Promise.allSettled 不発火 (serial path)`, async () => {
        vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
        const allSettledSpy = vi.spyOn(Promise, 'allSettled')

        // 10 件の非 cascade update_field (異 entity_id) + 1 件の cascade-like
        const updates = Array.from({ length: 10 }, (_, i) => {
          const cardId = `dddddddd-dddd-4ddd-aaaa-${String(i).padStart(12, '0')}`
          const mutationId = `eeeeeeee-eeee-4eee-aaaa-${String(i).padStart(12, '0')}`
          return makeUpdateFieldMutation({
            mutation_id: mutationId,
            entity_id: cardId,
            field: 'title',
            value: `t-${i}`,
          })
        })
        const cascadeMutationId =
          'ffffffff-ffff-4fff-aaaa-000000000099'
        const mutations = [...updates, makeMutation(cascadeMutationId)]

        const res = await POST(makeReq({ mutations }))
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          ok: boolean
          applied: number
          failed: string[]
        }
        expect(body.ok).toBe(true)
        expect(body.applied).toBe(11)
        expect(body.failed).toHaveLength(0)
        // serial path: `Promise.allSettled` は呼ばれない
        expect(allSettledSpy).not.toHaveBeenCalled()
        allSettledSpy.mockRestore()
      })
    }
  })

  // (c) mutation_id 重複 → 400 duplicate_mutation_id
  it('T-B3 (c): mutation_id 重複 (2 件) → 400 + { error: "duplicate_mutation_id" }', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    // 同 mutation_id を 2 件 (entity_id は異なる、 envelope レベルでは他 issue なし)
    const mutations = [
      makeUpdateFieldMutation({
        mutation_id: VALID_MUTATION_ID,
        entity_id: VALID_CARD_ID,
      }),
      makeUpdateFieldMutation({
        mutation_id: VALID_MUTATION_ID,
        entity_id: VALID_CARD_ID_2,
      }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('duplicate_mutation_id')
    // Retry-After は付与しない (400 は permanent)
    expect(res.headers.get('Retry-After')).toBeNull()
    // payload 段で reject → DB に到達しない (handler / log INSERT 不発)
    expect(state.cardFieldUpdateCalls).toHaveLength(0)
    expect(state.mutationInsertValues).toBeNull()
  })

  // (d) length=1 境界 parallel OK
  // helper test case 3 は「parallel + length>1」 を gate しており、 length=1 で parallel mode
  // を踏んでも false positive にならないことを route 結合で pin する (review Recommendation 1)。
  // 実装は helper 直接呼出で十分 (route は serial mode で呼ぶ前提だが、 invariant の
  // false positive 防止を helper signature レベルで確認)。
  it('T-B3 (d): assertSequentialPath(group, "parallel") は group.length=1 で throw しない (false positive 防止)', () => {
    const single = [
      makeUpdateFieldMutation({
        mutation_id: VALID_MUTATION_ID,
        entity_id: VALID_CARD_ID,
      }),
    ]
    expect(() =>
      assertSequentialPath(
        single as unknown as Parameters<typeof assertSequentialPath>[0],
        'parallel',
      ),
    ).not.toThrow()
  })

  // (e) R8 envelope 致命の分類 2 層不変 (並列化前後で 503/Retry-After 経路維持)
  it('T-B3 (e): envelope-level getDb 致命 → 並列化前後で 503 + Retry-After 維持、 Promise.allSettled 不発火、 logger.error のみ', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const allSettledSpy = vi.spyOn(Promise, 'allSettled')
    state.getDbError = new Error('connection failed')

    // 10 件異 entity_id の update_field (= cascade なし、 通常なら並列 path に倒れる構成)
    // を入れて、 getDb 自体の throw を踏ませる。 並列化前後で envelope catch が 503 に
    // 倒れること、 group 内 throw として吸い込まれないことを pin する。
    const mutations = Array.from({ length: 10 }, (_, i) => {
      const cardId = `99999999-9999-4999-aaaa-${String(i).padStart(12, '0')}`
      const mutationId = `88888888-8888-4888-aaaa-${String(i).padStart(12, '0')}`
      return makeUpdateFieldMutation({
        mutation_id: mutationId,
        entity_id: cardId,
        field: 'title',
        value: `t-${i}`,
      })
    })

    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('transient_unavailable')

    // group 内 catch (= logger.warn) は呼ばれない (envelope-level で外側 catch が拾う)
    expect(state.loggerWarnCalls).toHaveLength(0)
    // envelope-level catch の logger.error が 1 回呼ばれた
    expect(state.loggerErrorCalls.length).toBeGreaterThan(0)
    expect(state.loggerErrorCalls[0]).toMatchObject({
      event: 'entity_mutations.bulk.envelope_failed',
    })
    // group 段以降に到達していない → Promise.allSettled も不発
    expect(allSettledSpy).not.toHaveBeenCalled()
    allSettledSpy.mockRestore()
  })

  // (f) group async body の fail-silent 防御 (review Minor 1 反映、 step 0 §5 R8 を構造的に格上げ)
  // 並列 path の `Promise.allSettled` は async function 本体の throw を rejection として
  // 吸収する。 内側 try が processMutation 周りしか囲っていない設計だと、 inner catch の
  // logger.warn / serializeDbError が万一 throw した場合に結果が Map に入らず、
  // 入力順 iterate 時に skipped と同視 = silent lost write になる。 route 側の外側 try/catch
  // (group-level fatal) が当該 group の全 mutation を failed[] に積む経路を pin する。
  it('T-B3 (f): group async body 内 logger.warn が throw → group-level fatal で全 mutation を failed[] に積む (silent skip 防御)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const allSettledSpy = vi.spyOn(Promise, 'allSettled')

    // (i) handler を 1 回 throw させて inner catch を発火
    vi.mocked(CARD_FIELD_HANDLERS.title).mockImplementationOnce(async () => {
      throw new Error('synthetic per-mutation throw')
    })
    // (ii) logger.warn の 1 回目のみ throw → inner catch から外側 catch に渡す。
    // mockImplementationOnce ゆえ、 group-level catch 内の logger.warn (2 回目) は
    // default に戻り state.loggerWarnCalls に group_failed event が push される。
    vi.mocked(logger.warn).mockImplementationOnce(() => {
      throw new Error('synthetic logger.warn fatal')
    })

    // 1 mutation = 1 group の非 cascade 並列 path。 update_field ゆえ serialFallback=false。
    const mutationId = 'ffffffff-ffff-4fff-aaaa-000000000001'
    const cardId = 'eeeeeeee-eeee-4eee-aaaa-000000000001'
    const mutations = [
      makeUpdateFieldMutation({
        mutation_id: mutationId,
        entity_id: cardId,
        field: 'title',
        value: 't-0',
      }),
    ]

    const res = await POST(makeReq({ mutations }))
    // envelope は OK (per-mutation 経路の fatal は status 200 で返す既存契約)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      applied: number
      failed: string[]
    }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(0)
    // silent skip 防御: group async body throw でも該当 group の mutation は failed[] に積まれる
    expect(body.failed).toContain(mutationId)

    // group-level fatal log が記録された (route.ts の group_failed event)
    const groupFailedLogs = state.loggerWarnCalls.filter(
      (c) => c.event === 'entity_mutations.bulk.group_failed',
    )
    expect(groupFailedLogs).toHaveLength(1)
    expect(groupFailedLogs[0]).toMatchObject({
      event: 'entity_mutations.bulk.group_failed',
      groupSize: 1,
    })

    // 並列 path に倒れたことの確認 (= group helper が serialFallback=false を返した)
    expect(allSettledSpy).toHaveBeenCalledTimes(1)
    allSettledSpy.mockRestore()
  })
})
