// POST /api/card-mutations/bulk の unit test。
// 実 DB は叩かず、 getCurrentUser / getDb を mock して route handler の制御フロー
// (auth / zod / 冪等 gate / update_field / delete / orphan / create stub) を検証する。
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
    // card_mutations SELECT (冪等チェック)
    // mutation_id をキーとして「既存ならそのエントリが返る」
    existingMutationIds: new Set<string>(),

    // card_mutations INSERT 記録
    mutationInsertValues: null as null | Record<string, unknown>,
    // onConflictDoNothing に渡された target 記録
    mutationInsertConflictTarget: null as null | unknown,

    // applyCardFieldUpdate の mock (lib/cards/apply-card-mutation をモック)
    // card_id → found:true / false を制御
    cardFieldUpdateResults: new Map<string, boolean>(),
    cardFieldUpdateCalls: [] as Array<{
      cardId: string
      userId: string
      setData: Record<string, unknown>
    }>,

    // applyCardDelete の呼出記録
    cardDeleteCalls: [] as Array<{ cardId: string; userId: string }>,

    // buildSetClause の mock 制御
    // field → { ok: true/false, error?: string, data?: Record<string, unknown> }
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

// apply-card-mutation を mock (純関数の validation ロジックを test に引き込まない)
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
}))

// getDb は fakeDb を返す
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => fakeDb),
}))

// ---------------------------------------------------------------------------
// fake tx
// ---------------------------------------------------------------------------

// Drizzle の SQL オブジェクトから Param の値を再帰的に収集する。
// 各 Param の .value (string) を配列で返す。
// (Drizzle の queryChunks 構造は eq/and どちらでも同様に辿れる)
function collectParamValues(cond: unknown): string[] {
  const results: string[] = []
  function walk(obj: unknown) {
    if (obj === null || typeof obj !== 'object') return
    const o = obj as Record<string, unknown>
    // Param ノード: constructor.name === 'Param' かつ value: string
    if (
      typeof (obj as { constructor?: { name?: string } }).constructor?.name === 'string' &&
      (obj as { constructor: { name: string } }).constructor.name === 'Param' &&
      typeof o['value'] === 'string'
    ) {
      results.push(o['value'] as string)
      return
    }
    // queryChunks 配列を再帰
    if ('queryChunks' in o && Array.isArray(o['queryChunks'])) {
      for (const chunk of o['queryChunks'] as unknown[]) walk(chunk)
    }
    // 通常の配列
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item)
    }
  }
  walk(cond)
  return results
}

// and(eq(mutationId, id), eq(userId, uid)) から mutation_id の値を取り出す。
// collectParamValues で全 Param 値を集め、existingMutationIds に含まれるものを探す。
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
            // これにより mixed batch (既存 A + 新規 B) を正確に表現できる。
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
            if (tname === 'card_mutations') {
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
import { cardMutations } from '@/lib/db/schema'
import { POST } from './route'

const FAKE_USER = { id: '11111111-1111-4111-a111-111111111111' } as unknown as User
const VALID_CARD_ID = '44444444-4444-4444-a444-444444444444'
const VALID_CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const VALID_MUTATION_ID = '55555555-5555-4555-a555-555555555555'
const VALID_MUTATION_ID_2 = '66666666-6666-4666-a666-666666666666'
const VALID_MUTATION_ID_3 = '77777777-7777-4777-a777-777777777777'

function makeReq(payload: unknown): Request {
  return new Request('http://localhost/api/card-mutations/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function makeUpdateFieldMutation(
  overrides: Partial<{
    mutation_id: string
    card_id: string
    field: string
    value: unknown
    edited_at: string
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    card_id: overrides.card_id ?? VALID_CARD_ID,
    op: 'update_field' as const,
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
    card_id: string
    edited_at: string
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    card_id: overrides.card_id ?? VALID_CARD_ID,
    op: 'delete' as const,
    patch: {},
    edited_at: overrides.edited_at ?? '2026-05-30T10:00:00.000Z',
  }
}

function makeCreateMutation(
  overrides: Partial<{
    mutation_id: string
    card_id: string
    edited_at: string
  }> = {},
) {
  return {
    mutation_id: overrides.mutation_id ?? VALID_MUTATION_ID,
    card_id: overrides.card_id ?? VALID_CARD_ID,
    op: 'create' as const,
    patch: { title: 'New Card' },
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
  state.buildSetClauseResults = new Map()
  state.buildSetClauseCalls = []
  state.txShouldThrow = false
  state.loggerWarnCalls = []
})

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
describe('POST /api/card-mutations/bulk', () => {
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

  // --- zod validation ---

  it('invalid JSON body → 400 invalid_json', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const req = new Request('http://localhost/api/card-mutations/bulk', {
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
          card_id: VALID_CARD_ID,
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

  it('op が不正値 → 400 invalid_payload', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const payload = {
      mutations: [
        {
          mutation_id: VALID_MUTATION_ID,
          card_id: VALID_CARD_ID,
          op: 'unknown_op',
          patch: {},
          edited_at: '2026-05-30T10:00:00.000Z',
        },
      ],
    }
    const res = await POST(makeReq(payload))
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_payload')
  })

  it('mutations 配列が 1001 件 → 400 invalid_payload (zod .max(1000))', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutations = Array.from({ length: 1001 }, (_, i) => ({
      mutation_id: `${i.toString().padStart(8, '0')}-0000-4000-a000-000000000000`,
      card_id: VALID_CARD_ID,
      op: 'delete' as const,
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
          card_id: VALID_CARD_ID,
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

    // 1 回目: 新規 → apply + log INSERT
    const res1 = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body1.ok).toBe(true)
    expect(body1.applied).toBe(1)
    expect(body1.failed).toHaveLength(0)
    expect(state.mutationInsertValues).not.toBeNull()

    // 2 回目: 同 mutation_id が existingMutationIds にあるとマーク → skip
    state.existingMutationIds.add(VALID_MUTATION_ID)
    // 2 回目呼出の結果だけを確認できるよう、 1 回目の記録をリセット
    state.mutationInsertValues = null
    state.cardFieldUpdateCalls = []

    const res2 = await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body2.applied).toBe(0)
    expect(body2.failed).toHaveLength(0)
    // 2 回目は apply も log INSERT もしない
    expect(state.cardFieldUpdateCalls).toHaveLength(0)
    expect(state.mutationInsertValues).toBeNull()
  })

  it('冪等 mixed batch: 既存 mutation + 新規 mutation → applied:1, skipped:1, log INSERT は新規分のみ', async () => {
    // VALID_MUTATION_ID は既存 (skip)、 VALID_MUTATION_ID_2 は新規 (apply)。
    // fake SELECT が mutation_id 単位で判定することを確認するテスト。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    state.existingMutationIds.add(VALID_MUTATION_ID) // 既存扱いにする

    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, card_id: VALID_CARD_ID }),
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID_2, card_id: VALID_CARD_ID_2, field: 'title', value: 'New' }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    // 既存 1 件は skip (applied にカウントしない)、 新規 1 件は applied
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    // applyCardFieldUpdate は新規分 (VALID_MUTATION_ID_2) だけ呼ばれる
    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0].cardId).toBe(VALID_CARD_ID_2)

    // log INSERT は新規分のみ (VALID_MUTATION_ID_2)
    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues).toMatchObject({
      mutationId: VALID_MUTATION_ID_2,
      cardId: VALID_CARD_ID_2,
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

    // buildSetClause が field='title', value='Hello' で呼ばれた
    expect(state.buildSetClauseCalls).toHaveLength(1)
    expect(state.buildSetClauseCalls[0]).toMatchObject({ field: 'title', value: 'Hello' })

    // applyCardFieldUpdate が user.id + card_id で呼ばれた
    expect(state.cardFieldUpdateCalls).toHaveLength(1)
    expect(state.cardFieldUpdateCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
    })

    // log INSERT が呼ばれた
    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues).toMatchObject({
      mutationId: VALID_MUTATION_ID,
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
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

    // applyCardFieldUpdate は呼ばれない
    expect(state.cardFieldUpdateCalls).toHaveLength(0)
    // log INSERT も行われない
    expect(state.mutationInsertValues).toBeNull()
  })

  it('update_field: patch.field が未指定 → failed[]', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutation = {
      mutation_id: VALID_MUTATION_ID,
      card_id: VALID_CARD_ID,
      op: 'update_field' as const,
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

    // log INSERT は行われない (apply が failed)
    expect(state.mutationInsertValues).toBeNull()
  })

  // --- delete op ---

  it('delete 正常系: applyCardDelete → applied:1 (log INSERT なし)', async () => {
    // card_mutations.card_id FK は ON DELETE CASCADE のため、card 削除後に log INSERT
    // すると FK 違反になる。delete op は log INSERT をスキップする。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)

    // applyCardDelete が user.id + card_id で呼ばれた
    expect(state.cardDeleteCalls).toHaveLength(1)
    expect(state.cardDeleteCalls[0]).toMatchObject({
      cardId: VALID_CARD_ID,
      userId: FAKE_USER.id,
    })

    // delete op は log INSERT をスキップする (FK cascade で永続不可 + 自然冪等)
    expect(state.mutationInsertValues).toBeNull()
  })

  it('delete: idempotent — 存在しない card も applied:1 (applyCardDelete は silent success)、log INSERT なし', async () => {
    // applyCardDelete は内部で 0-row の場合も throw しない (idempotent 設計)。
    // よって delete op は常に applied:1 になる (orphan も含め)。
    // delete の冪等性は log ではなく applyCardDelete の自然冪等で担保するため
    // log INSERT はスキップされる。
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeDeleteMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1)
    expect(body.failed).toHaveLength(0)
    // log INSERT は行われない
    expect(state.mutationInsertValues).toBeNull()
  })

  // --- create op (未実装 stub) ---

  it('create op → failed[] に倒す (Task1.3 未対応)', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const res = await POST(makeReq({ mutations: [makeCreateMutation()] }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(0)
    expect(body.failed).toContain(VALID_MUTATION_ID)
    // applyCardFieldUpdate / applyCardDelete は呼ばれない
    expect(state.cardFieldUpdateCalls).toHaveLength(0)
    expect(state.cardDeleteCalls).toHaveLength(0)
  })

  // --- 複数 mutations の独立処理 ---

  it('複数 mutations: update_field + delete が個別に処理される', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, card_id: VALID_CARD_ID }),
      makeDeleteMutation({ mutation_id: VALID_MUTATION_ID_2, card_id: VALID_CARD_ID_2 }),
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
    // VALID_CARD_ID は orphan に設定
    state.cardFieldUpdateResults.set(VALID_CARD_ID, false)

    const mutations = [
      makeUpdateFieldMutation({ mutation_id: VALID_MUTATION_ID, card_id: VALID_CARD_ID }),
      makeDeleteMutation({ mutation_id: VALID_MUTATION_ID_2, card_id: VALID_CARD_ID_2 }),
    ]
    const res = await POST(makeReq({ mutations }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number; failed: string[] }
    expect(body.applied).toBe(1) // delete は成功
    expect(body.failed).toEqual([VALID_MUTATION_ID]) // update_field は失敗
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
    // logger.warn が呼ばれた
    expect(state.loggerWarnCalls).toHaveLength(1)
    expect(state.loggerWarnCalls[0]).toMatchObject({
      event: 'card_mutations.bulk.mutation_failed',
      mutationId: VALID_MUTATION_ID,
    })
  })

  it('tx throw が 1 件: 他の mutations は引き続き処理される', async () => {
    // 3 件中 1 件だけ tx throw → 他 2 件は正常処理
    // txShouldThrow は全 tx を throw させるため、 1 件だけ throw をシミュレートするには
    // applyCardFieldUpdate を 1 件だけ throw させる。
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
    // 1 件目の update_field throw → failed、 delete は成功、 3 件目 update_field も成功
    expect(body.failed).toContain(VALID_MUTATION_ID)
    expect(body.applied).toBe(2) // delete + 3rd update_field
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
    // conflict target は { target: cardMutations.mutationId } — mutation_id 列を指す
    expect(state.mutationInsertConflictTarget).not.toBeNull()
    const target = (state.mutationInsertConflictTarget as Record<string, unknown>)['target']
    // Drizzle column の .name は SQL 列名 (snake_case)
    expect((target as { name: string }).name).toBe(cardMutations.mutationId.name)
    expect((target as { name: string }).name).toBe('mutation_id')
  })

  it('log INSERT に appliedAt (sql now()) が含まれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq({ mutations: [makeUpdateFieldMutation()] }))
    expect(state.mutationInsertValues).not.toBeNull()
    // appliedAt は sql`now()` — オブジェクトであること (Date インスタンスでない)
    expect(typeof state.mutationInsertValues!['appliedAt']).toBe('object')
  })

  it('log INSERT に editedAt (Date インスタンス) が含まれる', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(FAKE_USER)
    await POST(makeReq({ mutations: [makeUpdateFieldMutation({ edited_at: '2026-05-30T10:00:00.000Z' })] }))
    expect(state.mutationInsertValues).not.toBeNull()
    expect(state.mutationInsertValues!['editedAt']).toBeInstanceOf(Date)
  })
})
