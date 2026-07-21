import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
// NOTE: `UnauthenticatedError` は static import でなく dynamic import で取得する。
// この test 環境 (Vitest 4.1.5) では同一 module でも static top-level import と
// `await import()` (asset-actions.ts の実 load 経路 = importActions()) が別
// module instance を返す既知の挙動があり、 static import した class で
// `instanceof` すると asset-actions.ts 内部の catch (`e instanceof
// UnauthenticatedError`) と一致しない。 実装側の contract は正しいので、
// test 側を asset-actions.ts と同じ dynamic import 経路に揃えて検証する。
async function importUnauthenticatedError() {
  const mod = await import('@/lib/auth/errors')
  return mod.UnauthenticatedError
}

// drizzle の SQL condition tree (and/inArray/eq の組立結果) から Param.value を
// 再帰収集する。 tree は column <-> table の循環参照を持つため
// JSON.stringify は使えない (TypeError: Converting circular structure to
// JSON) — visited Set で循環を打ち切りつつ queryChunks / value を辿る。
function collectDrizzleParamValues(node: unknown, visited = new Set<unknown>()): unknown[] {
  if (node === null || typeof node !== 'object') return []
  if (visited.has(node)) return []
  visited.add(node)

  const values: unknown[] = []
  const obj = node as Record<string, unknown>
  if ('value' in obj && !('queryChunks' in obj)) {
    values.push(obj.value)
  }
  const queryChunks = obj.queryChunks
  if (Array.isArray(queryChunks)) {
    for (const chunk of queryChunks) {
      values.push(...collectDrizzleParamValues(chunk, visited))
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      values.push(...collectDrizzleParamValues(item, visited))
    }
  }
  return values
}

// asset-actions のテスト (画像フェーズ A design spec §3.1/§6)。
// reserveAsset: 認可 / zod 検証 / INSERT(reserved) + presignPutUrl
// finalizeAsset: owner scope(cross-user reject) / idempotent / HEAD 検証(exists・
//   byte_size一致・content-length null reject) / UPDATE(ready)
// resolveAssetUrls: ≤50 件制限 / empty / ready+owner フィルタ / presignGetUrl

const {
  mockGetCurrentUser,
  mockPresignPutUrl,
  mockPresignGetUrl,
  mockHeadObject,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockPresignPutUrl: vi.fn(),
  mockPresignGetUrl: vi.fn(),
  mockHeadObject: vi.fn(),
  dbState: {
    insertTable: null as unknown,
    insertValues: null as Record<string, unknown> | null,
    // finalizeAsset の SELECT が返す行 (デフォルト = 1 行の reserved asset)
    selectResult: [] as Record<string, unknown>[],
    // finalizeAsset の 0 行 UPDATE 後 re-SELECT が返す行 (idempotency 判別)。
    // null なら 2 回目 SELECT も selectResult を再利用する (再取得しないテスト用)。
    reSelectResult: null as Record<string, unknown>[] | null,
    // finalizeAsset の SELECT 呼び出し回数 (1 回目=初期 SELECT / 2 回目=re-SELECT)。
    finalizeSelectCall: 0,
    // resolveAssetUrls の SELECT が返す行
    selectManyResult: [] as Record<string, unknown>[],
    whereArgs: [] as unknown[][],
    // UPDATE 呼び出し記録
    updateTable: null as unknown,
    updateSetValues: null as Record<string, unknown> | null,
    updateWhereArgs: [] as unknown[][],
    updateCalled: false,
    // UPDATE ... .returning() が返す行 (atomic status guard: 0 行 = reserved で
    // なかった = 並行 promote された)。デフォルト 1 行 = 通常の reserved→ready 成功。
    updateReturningResult: [{ id: 'updated-1' }] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/storage/r2', () => ({
  presignPutUrl: mockPresignPutUrl,
  presignGetUrl: mockPresignGetUrl,
  headObject: mockHeadObject,
}))

vi.mock('@/lib/db', () => {
  function makeSelectChain(resultKey: 'selectResult' | 'selectManyResult') {
    const obj: Record<string, unknown> = {}
    obj['where'] = (...args: unknown[]) => {
      dbState.whereArgs.push(args)
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      let rows = dbState[resultKey]
      // finalizeAsset は 0 行 UPDATE 後に status 判別のため 2 回目 SELECT を行う。
      // reSelectResult が積まれていれば 2 回目以降はそれを返す (idempotency 判別)。
      if (resultKey === 'selectResult') {
        dbState.finalizeSelectCall += 1
        if (dbState.finalizeSelectCall >= 2 && dbState.reSelectResult !== null) {
          rows = dbState.reSelectResult
        }
      }
      return Promise.resolve(rows).then(onFulfilled, onRejected)
    }
    return obj
  }

  function makeInsertChain(table: unknown) {
    const obj: Record<string, unknown> = {}
    obj['values'] = (vals: Record<string, unknown>) => {
      dbState.insertTable = table
      dbState.insertValues = vals
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(undefined).then(onFulfilled, onRejected)
    return obj
  }

  function makeUpdateChain(table: unknown) {
    const obj: Record<string, unknown> = {}
    dbState.updateTable = table
    obj['set'] = (vals: Record<string, unknown>) => {
      dbState.updateSetValues = vals
      return obj
    }
    obj['where'] = (...args: unknown[]) => {
      dbState.updateCalled = true
      dbState.updateWhereArgs.push(args)
      return obj
    }
    // atomic status guard 後、 実装は .returning() で更新行を受け取る。 mock は
    // updateReturningResult をそのまま返す (0 行 = 並行 promote シミュレート)。
    obj['returning'] = (_cols?: unknown) => Promise.resolve(dbState.updateReturningResult)
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(undefined).then(onFulfilled, onRejected)
    return obj
  }

  // resolveAssetUrls は複数件 SELECT (selectManyResult) を使う。 reserveAsset /
  // finalizeAsset の select は 1 件 SELECT (selectResult) を使う。 呼び分けは
  // テストごとに使う action で区別する (同一テスト内で select が複数回呼ばれる
  // ことはない設計のため、 selectManyResult が明示的に積まれていれば resolve 系
  // テストとみなして優先する単純な判定で十分)。
  return {
    getDb: () => ({
      select: (_columns?: unknown) => ({
        from: (_table: unknown) => {
          return makeSelectChain(
            dbState.selectManyResult.length > 0 ? 'selectManyResult' : 'selectResult',
          )
        },
      }),
      insert: (table: unknown) => makeInsertChain(table),
      update: (table: unknown) => makeUpdateChain(table),
    }),
  }
})

// RLS-P3 Wave2: reserve/finalize/resolve は withTenantTx で包まれた(finalize は
// read tx → headObject → write tx の 2 分割)。RLS-P3 Task 2 で withTenantTx(userId, fn)
// 署名へ変更(getDb を内部取得)。unit では pass-through stub が本物同様に getDb() を内部で
// 呼び、その mock db を fn へ流す(select/update の呼び順は共有 dbState で保持)。GUC 挙動は iso で担保。
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => {
    const { getDb } = await import('@/lib/db')
    return fn(getDb())
  },
}))

async function importActions() {
  return await import('./asset-actions')
}

function resetDbState() {
  dbState.insertTable = null
  dbState.insertValues = null
  dbState.selectResult = []
  dbState.reSelectResult = null
  dbState.finalizeSelectCall = 0
  dbState.selectManyResult = []
  dbState.whereArgs = []
  dbState.updateTable = null
  dbState.updateSetValues = null
  dbState.updateWhereArgs = []
  dbState.updateCalled = false
  dbState.updateReturningResult = [{ id: 'updated-1' }]
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockPresignPutUrl.mockReset()
  mockPresignGetUrl.mockReset()
  mockHeadObject.mockReset()
  resetDbState()
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-1',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
  mockPresignPutUrl.mockResolvedValue('https://r2.example.com/put-signed')
  mockPresignGetUrl.mockResolvedValue('https://r2.example.com/get-signed')
})

const validInput = {
  mime: 'image/webp' as const,
  byteSize: 1000,
  width: 800,
  height: 600,
  hash: 'abc123hash',
}

describe('reserveAsset', () => {
  it('auth fail → { ok: false }, no INSERT', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { reserveAsset } = await importActions()
    const r = await reserveAsset(validInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
    expect(dbState.insertTable).toBeNull()
  })

  it('unauthenticated (getCurrentUser throws UnauthenticatedError) → resolves { ok: false }, no INSERT', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { reserveAsset } = await importActions()
    const r = await reserveAsset(validInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
    expect(dbState.insertTable).toBeNull()
  })

  it('non-UnauthenticatedError from getCurrentUser propagates (not masked)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('db down'))
    const { reserveAsset } = await importActions()
    await expect(reserveAsset(validInput)).rejects.toThrow('db down')
  })

  it('invalid mime (enum 外) → { ok: false }, no INSERT', async () => {
    const { reserveAsset } = await importActions()
    // image/gif は enum {webp,png,jpeg} 外ゆえ reject。
    const r = await reserveAsset({
      ...validInput,
      mime: 'image/gif' as unknown as 'image/webp',
    })
    expect(r.ok).toBe(false)
    expect(dbState.insertTable).toBeNull()
  })

  it('valid jpeg (fallback 元画像) → INSERT with .jpg objectKey, presign image/jpeg', async () => {
    // client fallback(iOS/WebKit 修正 T5)が元 jpeg を direct PUT する経路。 enum が jpeg を
    // 受けないと RESERVE_FAILED に落ちるため、 client fallback 適格 type との連動を pin する。
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, mime: 'image/jpeg' as const })
    expect(r.ok).toBe(true)
    const vals = dbState.insertValues!
    expect(vals.mime).toBe('image/jpeg')
    if (r.ok && r.data) {
      expect(vals.objectKey).toBe(`users/user-1/${r.data.assetId}.jpg`)
      expect(mockPresignPutUrl).toHaveBeenCalledWith(
        vals.objectKey,
        'image/jpeg',
        1000,
      )
    }
  })

  it('byteSize 0 → { ok: false }, no INSERT', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, byteSize: 0 })
    expect(r.ok).toBe(false)
    expect(dbState.insertTable).toBeNull()
  })

  it('byteSize > 5MiB hard cap → { ok: false }, no INSERT', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, byteSize: 5 * 1024 * 1024 + 1 })
    expect(r.ok).toBe(false)
    expect(dbState.insertTable).toBeNull()
  })

  it('byteSize = 5MiB exactly → valid (boundary)', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, byteSize: 5 * 1024 * 1024 })
    expect(r.ok).toBe(true)
  })

  it('non-integer width/height → { ok: false }', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, width: 800.5 })
    expect(r.ok).toBe(false)
  })

  it('width/height above the cap → { ok: false }, no INSERT (Postgres integer overflow 防衛)', async () => {
    const { reserveAsset } = await importActions()
    const rw = await reserveAsset({ ...validInput, width: 100_001 })
    expect(rw.ok).toBe(false)
    const rh = await reserveAsset({ ...validInput, height: 2_147_483_648 })
    expect(rh.ok).toBe(false)
    expect(dbState.insertTable).toBeNull()
  })

  it('over-long hash → { ok: false }, no INSERT', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, hash: 'a'.repeat(129) })
    expect(r.ok).toBe(false)
    expect(dbState.insertTable).toBeNull()
  })

  it('empty hash → { ok: false }', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, hash: '' })
    expect(r.ok).toBe(false)
  })

  it('valid webp input → INSERT with objectKey users/{userId}/{assetId}.webp, status reserved, all fields, presignPutUrl called, returns {assetId, uploadUrl}', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset(validInput)
    expect(r.ok).toBe(true)
    expect(getTableName(dbState.insertTable as never)).toBe('assets')

    const vals = dbState.insertValues!
    expect(vals.userId).toBe('user-1')
    expect(vals.mime).toBe('image/webp')
    expect(vals.byteSize).toBe(1000)
    expect(vals.width).toBe(800)
    expect(vals.height).toBe(600)
    expect(vals.hash).toBe('abc123hash')
    expect(vals.status).toBe('reserved')
    // reference_count / unreferenced_at は書かない (dormant column、 DB default 任せ)
    expect(vals).not.toHaveProperty('referenceCount')
    expect(vals).not.toHaveProperty('unreferencedAt')

    if (r.ok && r.data) {
      expect(vals.id).toBe(r.data.assetId)
      expect(vals.objectKey).toBe(`users/user-1/${r.data.assetId}.webp`)
      expect(r.data.uploadUrl).toBe('https://r2.example.com/put-signed')
      // byteSize が presign に渡ること (Content-Length 署名固定 = storage size cap)
      expect(mockPresignPutUrl).toHaveBeenCalledWith(vals.objectKey, 'image/webp', 1000)
    }
  })

  it('valid png input → objectKey extension .png', async () => {
    const { reserveAsset } = await importActions()
    const r = await reserveAsset({ ...validInput, mime: 'image/png' })
    expect(r.ok).toBe(true)
    const vals = dbState.insertValues!
    if (r.ok && r.data) {
      expect(vals.objectKey).toBe(`users/user-1/${r.data.assetId}.png`)
    }
  })
})

const VALID_ASSET_UUID = '11111111-1111-4111-8111-111111111111'
const VALID_ASSET_UUID_2 = '22222222-2222-4222-8222-222222222222'

describe('finalizeAsset', () => {
  const readyAsset = {
    id: VALID_ASSET_UUID,
    userId: 'user-1',
    objectKey: `users/user-1/${VALID_ASSET_UUID}.webp`,
    mime: 'image/webp',
    byteSize: 1000,
    width: 800,
    height: 600,
    hash: 'abc123hash',
    status: 'reserved',
    createdAt: new Date(),
    readyAt: null,
    referenceCount: 0,
    unreferencedAt: null,
  }

  it('auth fail → { ok: false }, no HEAD/UPDATE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockHeadObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('unauthenticated (getCurrentUser throws UnauthenticatedError) → resolves { ok: false }, no HEAD/UPDATE', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockHeadObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('non-UnauthenticatedError from getCurrentUser propagates (not masked)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('db down'))
    const { finalizeAsset } = await importActions()
    await expect(finalizeAsset(VALID_ASSET_UUID)).rejects.toThrow('db down')
  })

  it('non-UUID assetId → { ok: false }, no DB select', async () => {
    // select().from().where() records into dbState.whereArgs — untouched
    // means the DB select was never reached (short-circuited before it).
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset('not-a-uuid')
    expect(r.ok).toBe(false)
    expect(dbState.whereArgs).toEqual([])
    expect(dbState.updateCalled).toBe(false)
  })

  it('missing assetId → { ok: false }', async () => {
    dbState.selectResult = []
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID_2)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(false)
  })

  it('cross-user assetId (row belongs to another user) → { ok: false } (owner-scoped SELECT returns nothing)', async () => {
    // owner scope の WHERE user_id=? が正しければ他 user の asset は 0 行で返る
    dbState.selectResult = []
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID_2)
    expect(r.ok).toBe(false)
    expect(mockHeadObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('already ready → { ok: true } idempotent, no HEAD call', async () => {
    dbState.selectResult = [{ ...readyAsset, status: 'ready' }]
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(mockHeadObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('HEAD exists:false → { ok: false }, no UPDATE', async () => {
    dbState.selectResult = [readyAsset]
    mockHeadObject.mockResolvedValueOnce({ exists: false, contentLength: null })
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(false)
  })

  it('contentLength mismatch → { ok: false }, no UPDATE', async () => {
    dbState.selectResult = [readyAsset]
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: 999 })
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(false)
  })

  it('contentLength null → { ok: false } (explicit reject, not lenient), no UPDATE', async () => {
    dbState.selectResult = [readyAsset]
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: null })
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(false)
  })

  it('success: HEAD exists + contentLength matches byteSize → UPDATE status=ready + ready_at, { ok: true }', async () => {
    dbState.selectResult = [readyAsset]
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: 1000 })
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(mockHeadObject).toHaveBeenCalledWith(`users/user-1/${VALID_ASSET_UUID}.webp`)
    expect(getTableName(dbState.updateTable as never)).toBe('assets')
    expect(dbState.updateSetValues?.status).toBe('ready')
    expect(dbState.updateSetValues).toHaveProperty('readyAt')
    expect(dbState.updateCalled).toBe(true)
  })

  // R1 (画像 GC v2・G2 domain 配線): canFinalize ガードが deleting/deleted の
  // asset を ready へ遷移させないこと。 GC 回収確定後の asset を finalize 再呼び
  // 出しで復活させない防衛 (spec §4.9)。
  it.each(['deleting', 'deleted'] as const)(
    'status=%s → { ok: false }, no HEAD/UPDATE, status unchanged (canFinalize ガード)',
    async (status) => {
      dbState.selectResult = [{ ...readyAsset, status }]
      const { finalizeAsset } = await importActions()
      const r = await finalizeAsset(VALID_ASSET_UUID)
      expect(r.ok).toBe(false)
      expect(mockHeadObject).not.toHaveBeenCalled()
      expect(dbState.updateCalled).toBe(false)
    },
  )

  // R1 (画像 GC v2・atomic status guard): write-time TOCTOU 防御。 SELECT 時点で
  // reserved でも、 UPDATE までに GC reconciler が reserved→deleting へ promote し
  // うる。 UPDATE の WHERE に status='reserved' を含め atomic に遷移させ、 0 行更新
  // (並行 promote 済) なら成功を返さず not-found とする。
  it('UPDATE WHERE に status=reserved が含まれる (atomic guard)', async () => {
    dbState.selectResult = [readyAsset] // status='reserved'
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: 1000 })
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    // UPDATE の WHERE param 値に 'reserved' が焼き込まれていること (SQL 条件木を辿る)。
    expect(dbState.updateWhereArgs.length).toBe(1)
    const paramValues = collectDrizzleParamValues(dbState.updateWhereArgs[0])
    expect(paramValues).toContain('reserved')
  })

  it('write-time race: reserved at SELECT だが UPDATE が 0 行 (並行 promote) → { ok: false }, not success', async () => {
    dbState.selectResult = [readyAsset] // read-time は reserved → canFinalize 通過
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: 1000 })
    // UPDATE ... status='reserved' が 0 行にマッチ (SELECT 後に deleting へ promote された)。
    dbState.updateReturningResult = []
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    // UPDATE 自体は試みられる (read-time guard は通過している) が、 0 行ゆえ成功にしない。
    expect(dbState.updateCalled).toBe(true)
  })

  // R1 (画像 GC v2・冪等性維持): atomic guard の 0 行分岐が finalize の冪等性を
  // 壊さないこと。 並行する 2 本の finalize が同 reserved asset を叩くと、 先行が
  // ready 化し、 後続の UPDATE は 0 行 (もう reserved でない) になる。 後続は re-SELECT
  // で ready を観測し、 冪等成功 (呼び出し側が望んだ end-state) を返す。
  it('0-row UPDATE + re-SELECT が ready → { ok: true } (冪等性維持 = 並行 finalize が先勝ち)', async () => {
    dbState.selectResult = [readyAsset] // 初期 SELECT = reserved → canFinalize 通過
    mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: 1000 })
    dbState.updateReturningResult = [] // 並行 finalize が先に ready 化 → 0 行
    dbState.reSelectResult = [{ ...readyAsset, status: 'ready' }] // 再取得で ready を観測
    const { finalizeAsset } = await importActions()
    const r = await finalizeAsset(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(dbState.updateCalled).toBe(true)
  })

  // R1 (画像 GC v2・no-resurrection): 0 行分岐 + re-SELECT が deleting / 行消失なら
  // GC promote が先勝ちしたケース。 復活させず not-found を返す。
  it.each([
    ['deleting', [{ id: VALID_ASSET_UUID, userId: 'user-1', status: 'deleting' }]],
    ['row gone', [] as Record<string, unknown>[]],
  ] as const)(
    '0-row UPDATE + re-SELECT が %s → { ok: false } (no-resurrection = GC promote が先勝ち)',
    async (_label, reSelect) => {
      dbState.selectResult = [readyAsset] // 初期 SELECT = reserved → canFinalize 通過
      mockHeadObject.mockResolvedValueOnce({ exists: true, contentLength: 1000 })
      dbState.updateReturningResult = [] // GC が deleting へ promote → 0 行
      dbState.reSelectResult = reSelect as Record<string, unknown>[]
      const { finalizeAsset } = await importActions()
      const r = await finalizeAsset(VALID_ASSET_UUID)
      expect(r.ok).toBe(false)
      expect(dbState.updateCalled).toBe(true)
    },
  )
})

describe('resolveAssetUrls', () => {
  it('auth fail → { ok: false }', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls(['asset-1'])
    expect(r.ok).toBe(false)
  })

  it('unauthenticated (getCurrentUser throws UnauthenticatedError) → resolves { ok: false }', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls(['asset-1'])
    expect(r.ok).toBe(false)
  })

  it('non-UnauthenticatedError from getCurrentUser propagates (not masked)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('db down'))
    const { resolveAssetUrls } = await importActions()
    await expect(resolveAssetUrls(['asset-1'])).rejects.toThrow('db down')
  })

  it('single non-UUID id → { ok: true, data: [] }, no DB query', async () => {
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls(['not-a-uuid'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual([])
    expect(dbState.whereArgs).toEqual([])
    expect(mockPresignGetUrl).not.toHaveBeenCalled()
  })

  it('non-array input (untrusted arg) → { ok: false }, does not throw, no DB query', async () => {
    const { resolveAssetUrls } = await importActions()
    // server action 引数は runtime で untrusted。 非配列 (string / null) でも
    // 500 でなく ActionResult を返すこと (finding 3)。
    for (const bad of ['not-an-array', null, { a: 1 }, 42]) {
      const r = await resolveAssetUrls(bad as unknown as string[])
      expect(r.ok).toBe(false)
    }
    expect(dbState.whereArgs).toEqual([])
    expect(mockPresignGetUrl).not.toHaveBeenCalled()
  })

  it('mixed non-UUID + valid UUID → DB queried with only the valid UUID, non-UUID silently omitted', async () => {
    const validUuid = '11111111-1111-4111-8111-111111111111'
    dbState.selectManyResult = [
      {
        id: validUuid,
        userId: 'user-1',
        objectKey: `users/user-1/${validUuid}.webp`,
        mime: 'image/webp',
        byteSize: 1000,
        width: 800,
        height: 600,
        hash: 'h1',
        status: 'ready',
        createdAt: new Date(),
        readyAt: new Date(),
        referenceCount: 0,
        unreferencedAt: null,
      },
    ]
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls(['not-a-uuid', validUuid])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual([
        {
          assetId: validUuid,
          url: 'https://r2.example.com/get-signed',
          mime: 'image/webp',
          width: 800,
          height: 600,
        },
      ])
    }
    // where() was called (DB was queried) — assert the inArray param values
    // contain only the valid uuid, not the non-uuid string. Drizzle's SQL
    // condition tree has a `table` <-> `column` circular reference, so a
    // depth/visited-guarded walk is used instead of JSON.stringify.
    expect(dbState.whereArgs.length).toBe(1)
    const paramValues = collectDrizzleParamValues(dbState.whereArgs[0])
    expect(paramValues).toContain(validUuid)
    expect(paramValues).not.toContain('not-a-uuid')
  })

  it('> 50 ids → { ok: false }, no SELECT', async () => {
    const { resolveAssetUrls } = await importActions()
    const ids = Array.from({ length: 51 }, (_, i) => `asset-${i}`)
    const r = await resolveAssetUrls(ids)
    expect(r.ok).toBe(false)
  })

  it('empty array → { ok: true, data: [] }', async () => {
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls([])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual([])
    expect(mockPresignGetUrl).not.toHaveBeenCalled()
  })

  it('returns only ready+owner rows with presigned GET urls (non-ready/cross-user rows already excluded by SELECT WHERE)', async () => {
    dbState.selectManyResult = [
      {
        id: VALID_ASSET_UUID,
        userId: 'user-1',
        objectKey: `users/user-1/${VALID_ASSET_UUID}.webp`,
        mime: 'image/webp',
        byteSize: 1000,
        width: 800,
        height: 600,
        hash: 'h1',
        status: 'ready',
        createdAt: new Date(),
        readyAt: new Date(),
        referenceCount: 0,
        unreferencedAt: null,
      },
    ]
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls([VALID_ASSET_UUID, VALID_ASSET_UUID_2])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual([
        {
          assetId: VALID_ASSET_UUID,
          url: 'https://r2.example.com/get-signed',
          mime: 'image/webp',
          width: 800,
          height: 600,
        },
      ])
    }
    expect(mockPresignGetUrl).toHaveBeenCalledWith(`users/user-1/${VALID_ASSET_UUID}.webp`)
  })

  it('50 ids exactly → valid (boundary)', async () => {
    dbState.selectManyResult = []
    const { resolveAssetUrls } = await importActions()
    const ids = Array.from({ length: 50 }, (_, i) => `asset-${i}`)
    const r = await resolveAssetUrls(ids)
    expect(r.ok).toBe(true)
  })

  // R1 (画像 GC v2・G2 domain 配線): resolve の SELECT WHERE が status='ready' を
  // 要求すること (deleting/deleted を除外する state gate = spec §3-4 /
  // allowsNewReference と同じ意味論) を pin する。 mock DB は実 WHERE 評価を
  // 行わないため、 (1) SQL の param 値に 'ready' が含まれ 'deleting'/'deleted' が
  // 含まれないこと、 (2) selectManyResult に ready 行のみを積んだ時に他 status
  // 行が結果に混ざらないこと、の 2 点で state gate の配線を検証する。
  it('WHERE に status=ready のみ含まれる (deleting/deleted は param に現れない) + ready 行のみ返る', async () => {
    dbState.selectManyResult = [
      {
        id: VALID_ASSET_UUID,
        userId: 'user-1',
        objectKey: `users/user-1/${VALID_ASSET_UUID}.webp`,
        mime: 'image/webp',
        byteSize: 1000,
        width: 800,
        height: 600,
        hash: 'h1',
        status: 'ready',
        createdAt: new Date(),
        readyAt: new Date(),
        referenceCount: 0,
        unreferencedAt: null,
      },
    ]
    const { resolveAssetUrls } = await importActions()
    const r = await resolveAssetUrls([VALID_ASSET_UUID])
    expect(r.ok).toBe(true)
    if (r.ok && r.data) {
      expect(r.data.map((d) => d.assetId)).toEqual([VALID_ASSET_UUID])
    }
    expect(dbState.whereArgs.length).toBe(1)
    const paramValues = collectDrizzleParamValues(dbState.whereArgs[0])
    expect(paramValues).toContain('ready')
    expect(paramValues).not.toContain('deleting')
    expect(paramValues).not.toContain('deleted')
  })
})
