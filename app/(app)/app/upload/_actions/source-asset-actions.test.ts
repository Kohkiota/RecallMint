import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import sharp from 'sharp'
// reconcileSniffedAndDecodedMime/verifyImageBytes は directive 無し module
// ('use server' 制約がない)側へ移設済(build-blocker fix)。 static import で
// 問題ない(この file の dynamic import 迂回は 'use server' file 側の
// instanceof 問題を避けるための措置であり、 このモジュールには適用不要)。
import {
  reconcileSniffedAndDecodedMime,
  verifyImageBytes,
  DECODE_MAX_PIXELS,
} from '../_lib/source-image-verify'

// ②-4a Task 5: source-asset-actions のテスト。
// reserveSource: 認可(owner+status='reserved') / zod 検証 / presignPutUrl(既存 temp
//   objectKey へ・DB は非永続)。新規 INSERT は行わない(T4 が既に作成済)。
// finalizeSource: owner scope(cross-user reject) / idempotent(ready) / no-resurrection
//   (deleting) / R2 GET 失敗 reject / magic-byte・decode・寸法検証 / 検証済バイトを
//   最終 key へ putObject(server 書込) / 条件付き UPDATE(5 列 + object_key + ready_at
//   + status を同時に確定・TOCTOU CAS)。
//
// dynamic import 経路(instanceof UnauthenticatedError の module instance 一致問題)は
// asset-actions.test.ts の既存パターンをそのまま踏襲する。

async function importUnauthenticatedError() {
  const mod = await import('@/lib/auth/errors')
  return mod.UnauthenticatedError
}

// drizzle の SQL condition tree から Param.value を再帰収集する
// (asset-actions.test.ts の collectDrizzleParamValues と同一実装)。
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

const {
  mockGetCurrentUser,
  mockPresignPutUrl,
  mockGetObject,
  mockPutObject,
  mockDeleteObject,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockPresignPutUrl: vi.fn(),
  mockGetObject: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  dbState: {
    selectResult: [] as Record<string, unknown>[],
    reSelectResult: null as Record<string, unknown>[] | null,
    selectCallCount: 0,
    whereArgs: [] as unknown[][],
    updateTable: null as unknown,
    updateSetValues: null as Record<string, unknown> | null,
    updateWhereArgs: [] as unknown[][],
    updateCalled: false,
    updateReturningResult: [{ id: 'updated-1' }] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/storage/r2', () => ({
  presignPutUrl: mockPresignPutUrl,
  getObject: mockGetObject,
  putObject: mockPutObject,
  deleteObject: mockDeleteObject,
}))

vi.mock('@/lib/db', () => {
  function makeSelectChain() {
    const obj: Record<string, unknown> = {}
    obj['where'] = (...args: unknown[]) => {
      dbState.whereArgs.push(args)
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      dbState.selectCallCount += 1
      const rows =
        dbState.selectCallCount >= 2 && dbState.reSelectResult !== null
          ? dbState.reSelectResult
          : dbState.selectResult
      return Promise.resolve(rows).then(onFulfilled, onRejected)
    }
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
    obj['returning'] = (_cols?: unknown) => Promise.resolve(dbState.updateReturningResult)
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(undefined).then(onFulfilled, onRejected)
    return obj
  }

  return {
    getDb: () => ({
      select: (_columns?: unknown) => ({
        from: (_table: unknown) => makeSelectChain(),
      }),
      update: (table: unknown) => makeUpdateChain(table),
    }),
  }
})

vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => {
    const { getDb } = await import('@/lib/db')
    return fn(getDb())
  },
}))

async function importActions() {
  return await import('./source-asset-actions')
}

function resetDbState() {
  dbState.selectResult = []
  dbState.reSelectResult = null
  dbState.selectCallCount = 0
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
  mockGetObject.mockReset()
  mockPutObject.mockReset()
  mockDeleteObject.mockReset()
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
  mockPutObject.mockResolvedValue('success')
  mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })
})

const VALID_ASSET_UUID = '11111111-1111-4111-8111-111111111111'
const VALID_ASSET_UUID_2 = '22222222-2222-4222-8222-222222222222'
const TEMP_OBJECT_KEY = `users/user-1/src/tmp/${VALID_ASSET_UUID}`

describe('reserveSource', () => {
  const validInput = {
    assetId: VALID_ASSET_UUID,
    mime: 'image/webp' as const,
    byteSize: 1000,
  }

  it('auth fail → { ok: false }, no presign', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { reserveSource } = await importActions()
    const r = await reserveSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('unauthenticated (getCurrentUser throws UnauthenticatedError) → resolves { ok: false }, no presign', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { reserveSource } = await importActions()
    const r = await reserveSource(validInput)
    expect(r.ok).toBe(false)
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('non-UnauthenticatedError from getCurrentUser propagates (not masked)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('db down'))
    const { reserveSource } = await importActions()
    await expect(reserveSource(validInput)).rejects.toThrow('db down')
  })

  it('invalid mime (enum 外) → { ok: false }, no DB query', async () => {
    const { reserveSource } = await importActions()
    const r = await reserveSource({ ...validInput, mime: 'image/gif' as unknown as 'image/webp' })
    expect(r.ok).toBe(false)
    expect(dbState.whereArgs).toEqual([])
  })

  it('non-UUID assetId → { ok: false }, no DB query', async () => {
    const { reserveSource } = await importActions()
    const r = await reserveSource({ ...validInput, assetId: 'not-a-uuid' })
    expect(r.ok).toBe(false)
    expect(dbState.whereArgs).toEqual([])
  })

  it('byteSize over MAX_ASSET_BYTES → { ok: false }, no DB query', async () => {
    const { reserveSource } = await importActions()
    const r = await reserveSource({ ...validInput, byteSize: 5 * 1024 * 1024 + 1 })
    expect(r.ok).toBe(false)
    expect(dbState.whereArgs).toEqual([])
  })

  it('row not found (missing / foreign / non-reserved — owner+status SELECT returns 0 rows) → { ok: false }, no presign', async () => {
    dbState.selectResult = []
    const { reserveSource } = await importActions()
    const r = await reserveSource(validInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
    expect(mockPresignPutUrl).not.toHaveBeenCalled()
  })

  it('success: authorizes the reserved row and presigns its temp objectKey (server-owned, not client-supplied)', async () => {
    dbState.selectResult = [{ objectKey: TEMP_OBJECT_KEY }]
    const { reserveSource } = await importActions()
    const r = await reserveSource(validInput)
    expect(r.ok).toBe(true)
    if (r.ok && r.data) {
      expect(r.data.uploadUrl).toBe('https://r2.example.com/put-signed')
    }
    expect(mockPresignPutUrl).toHaveBeenCalledWith(TEMP_OBJECT_KEY, 'image/webp', 1000)

    // authorize 用 SELECT の WHERE param に status='reserved' が焼き込まれている
    // (owner+status の二重 gate)。
    expect(dbState.whereArgs.length).toBe(1)
    const paramValues = collectDrizzleParamValues(dbState.whereArgs[0])
    expect(paramValues).toContain('reserved')
    expect(paramValues).toContain(VALID_ASSET_UUID)
    expect(paramValues).toContain('user-1')
  })
})

describe('finalizeSource', () => {
  let pngBytes: Buffer

  beforeEach(async () => {
    pngBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
  })

  const reservedRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: VALID_ASSET_UUID,
    userId: 'user-1',
    sourceDocumentId: 'doc-1',
    sourceId: 's1',
    objectKey: TEMP_OBJECT_KEY,
    mime: null,
    contentHash: null,
    byteSize: null,
    width: null,
    height: null,
    status: 'reserved',
    originalFilename: 'a.png',
    sourceKind: 'image',
    createdAt: new Date(),
    readyAt: null,
    pageCount: null,
    rotation: null,
    rasterizer: null,
    ...overrides,
  })

  it('auth fail → { ok: false }, no GET/PUT/UPDATE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('unauthenticated (getCurrentUser throws UnauthenticatedError) → resolves { ok: false }, no GET/PUT/UPDATE', async () => {
    const UnauthenticatedError = await importUnauthenticatedError()
    mockGetCurrentUser.mockRejectedValueOnce(new UnauthenticatedError())
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('non-UUID assetId → { ok: false }, no DB select', async () => {
    const { finalizeSource } = await importActions()
    const r = await finalizeSource('not-a-uuid')
    expect(r.ok).toBe(false)
    expect(dbState.whereArgs).toEqual([])
  })

  it('missing row (cross-user or nonexistent — owner-scoped SELECT returns 0 rows) → { ok: false }, no GET', async () => {
    dbState.selectResult = []
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID_2)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('already ready → { ok: true } idempotent, no GET/PUT/UPDATE/DELETE (critical: at this point asset.objectKey is the FINAL key, not temp — must never be deleted)', async () => {
    dbState.selectResult = [reservedRow({ status: 'ready' })]
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
    expect(mockDeleteObject).not.toHaveBeenCalled()
  })

  it('status=deleting (GC 回収確定後) → { ok: false }, no GET/PUT/UPDATE (no-resurrection read-time gate)', async () => {
    dbState.selectResult = [reservedRow({ status: 'deleting' })]
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('R2 GET returns null (object missing/timeout) → { ok: false }, no PUT/UPDATE', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce(null)
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('non-image bytes (no recognized magic-byte signature) → rejected, no promote, no ready', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: Buffer.from('not an image, just text') })
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('truncated image bytes (magic bytes intact, body cut short) → decode fails, rejected, no promote, no ready', async () => {
    dbState.selectResult = [reservedRow()]
    // PNG signature を残しつつ末尾を切り詰める (header は健全でも pixel decode で失敗する)。
    const truncated = pngBytes.subarray(0, Math.floor(pngBytes.length / 2))
    mockGetObject.mockResolvedValueOnce({ bytes: truncated })
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('width exceeds MAX_IMAGE_DIMENSION (extreme aspect ratio, low total pixel count) → rejected, no promote, no ready', async () => {
    dbState.selectResult = [reservedRow()]
    // 200,000 x 1 = 200,000 px 総数(DECODE_MAX_PIXELS を大幅に下回り decode 自体は
    // 軽量)だが width が MAX_IMAGE_DIMENSION(100,000)を超える — 寸法上限チェック単体を
    // decode bomb 防御(limitInputPixels)と独立に検証する。
    const wide = await sharp({
      create: { width: 200_000, height: 1, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .png()
      .toBuffer()
    mockGetObject.mockResolvedValueOnce({ bytes: wide })
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbState.updateCalled).toBe(false)
  })

  it('R2 PUT (promote) fails ("error" outcome) → { ok: false }, no UPDATE', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
    mockPutObject.mockResolvedValueOnce('error')
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(false)
  })

  // Critical fix (concurrent-finalize race): 条件付き PUT が 'precondition_failed'
  // を返した時、 最終 key の実体を GET して hash 照合する。 一致(= 同一バイトの
  // 並行 finalize)なら再 PUT せず CAS へ進む。
  it('conditional PUT precondition_failed + hash MATCH (byte-identical concurrent finalize) → proceeds to CAS without re-PUT', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject
      .mockResolvedValueOnce({ bytes: pngBytes }) // temp key GET
      .mockResolvedValueOnce({ bytes: pngBytes }) // final key GET (hash compare) — 同一バイト
    mockPutObject.mockResolvedValueOnce('precondition_failed')
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    // 再 PUT していない(条件付き PUT が唯一の呼び出し)。
    expect(mockPutObject).toHaveBeenCalledTimes(1)
    expect(dbState.updateCalled).toBe(true)
    const vals = dbState.updateSetValues!
    expect(vals.status).toBe('ready')
  })

  // Critical fix: precondition_failed + hash MISMATCH(別バイトの concurrent
  // finalize が先に最終 key を確定済み)→ loud failure、CAS を実行しない
  // (metadata と物理オブジェクトの不整合を作らない)。
  it('conditional PUT precondition_failed + hash MISMATCH (different-bytes concurrent finalize already won) → loud failure, no CAS, no re-PUT', async () => {
    dbState.selectResult = [reservedRow()]
    const otherBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer()
    mockGetObject
      .mockResolvedValueOnce({ bytes: pngBytes }) // temp key GET (このバイトを検証)
      .mockResolvedValueOnce({ bytes: otherBytes }) // final key GET — 別バイトが既に存在
    mockPutObject.mockResolvedValueOnce('precondition_failed')
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(mockPutObject).toHaveBeenCalledTimes(1) // 再 PUT していない
    expect(dbState.updateCalled).toBe(false) // CAS していない
  })

  // Critical fix: precondition_failed 後の最終key GET が null(直後にGC等で
  // 消えた等・実体確認不能)→ loud failure、CASしない。
  it('conditional PUT precondition_failed + final-key GET returns null (cannot verify) → loud failure, no CAS', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject
      .mockResolvedValueOnce({ bytes: pngBytes }) // temp key GET
      .mockResolvedValueOnce(null) // final key GET 失敗
    mockPutObject.mockResolvedValueOnce('precondition_failed')
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(false)
  })

  it('success: recomputes hash/dims from actual bytes, promotes to the FINAL key via a conditional putObject (ifNoneMatch=true, server write), and the conditional UPDATE sets all 5 verified columns + object_key(final) + ready_at + status=ready together', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)

    expect(mockGetObject).toHaveBeenCalledWith(TEMP_OBJECT_KEY)

    const expectedFinalKey = `users/user-1/src/${VALID_ASSET_UUID}.png`
    // temp→最終 promote: putObject が最終 key + 検証済(= GET で取得した元)バイト +
    // ifNoneMatch:true(first-writer-wins・spec §7.4)で呼ばれる(server 書込・
    // client は最終 key の presigned を持たない)。
    expect(mockPutObject).toHaveBeenCalledWith(expectedFinalKey, pngBytes, 'image/png', {
      ifNoneMatch: true,
    })

    expect(getTableName(dbState.updateTable as never)).toBe('source_assets')
    const vals = dbState.updateSetValues!
    expect(vals.mime).toBe('image/png')
    expect(vals.byteSize).toBe(pngBytes.length)
    expect(vals.width).toBe(4)
    expect(vals.height).toBe(4)
    expect(vals.objectKey).toBe(expectedFinalKey)
    expect(vals.status).toBe('ready')
    expect(vals).toHaveProperty('readyAt')
    expect(vals).toHaveProperty('contentHash')
    expect(typeof vals.contentHash).toBe('string')
    expect((vals.contentHash as string).length).toBe(64) // SHA-256 hex

    // 条件付き UPDATE の WHERE に status='reserved' が焼き込まれている(TOCTOU CAS)。
    expect(dbState.updateWhereArgs.length).toBe(1)
    const paramValues = collectDrizzleParamValues(dbState.updateWhereArgs[0])
    expect(paramValues).toContain('reserved')

    // 通常系(CAS に勝った)では最終 key の孤児は生まれない(orphan cleanup 対象
    // 外)が、 promote 元の temp key は不要になるため明示 delete される
    // (Important fix: temp object leak 対処)。
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(TEMP_OBJECT_KEY)
  })

  it('jpeg input → final key extension .jpg, mime image/jpeg', async () => {
    const jpegBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .jpeg()
      .toBuffer()
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: jpegBytes })
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    const vals = dbState.updateSetValues!
    expect(vals.mime).toBe('image/jpeg')
    expect(vals.objectKey).toBe(`users/user-1/src/${VALID_ASSET_UUID}.jpg`)
  })

  it('webp input → final key extension .webp, mime image/webp', async () => {
    const webpBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .webp()
      .toBuffer()
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: webpBytes })
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    const vals = dbState.updateSetValues!
    expect(vals.mime).toBe('image/webp')
    expect(vals.objectKey).toBe(`users/user-1/src/${VALID_ASSET_UUID}.webp`)
  })

  // write-time race (finalizeAsset の atomic status guard と同型): SELECT 時点は
  // reserved でも UPDATE までに GC reconciler が deleting へ promote しうる。
  // Important fix(lost-CAS orphan): この呼出の putObject は 'success'(実際に
  // finalKey へ書込)だったのに CAS に負けた — GC promote は object_key を
  // 書き換えない(temp key のまま)ため current.objectKey(temp) !==
  // finalObjectKey → 孤児化した自分の PUT を deleteObject で明示的に消す。
  it('write-time race: reserved at SELECT but UPDATE matches 0 rows (concurrent GC promote to deleting) → { ok: false }, orphaned final object is deleted', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
    dbState.updateReturningResult = []
    dbState.reSelectResult = [{ status: 'deleting', objectKey: TEMP_OBJECT_KEY }]
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(true)
    const expectedFinalKey = `users/user-1/src/${VALID_ASSET_UUID}.png`
    expect(mockDeleteObject).toHaveBeenCalledWith(expectedFinalKey)
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
  })

  // Important fix: 別 mime の concurrent finalize が先に CAS に勝った(winner の
  // objectKey は winner 自身の拡張子= .jpg)場合、この呼出の finalObjectKey(.png)
  // はどの行からも参照されない孤児 — 明示 delete 対象。
  it('0-row UPDATE + re-SELECT observes ready with a DIFFERENT extension (different-mime concurrent winner) → { ok: true } idempotent, but MY orphaned final object (different key) is deleted', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
    dbState.updateReturningResult = []
    const winnerKey = `users/user-1/src/${VALID_ASSET_UUID}.jpg`
    dbState.reSelectResult = [{ status: 'ready', objectKey: winnerKey }]
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(dbState.updateCalled).toBe(true)
    const myFinalKey = `users/user-1/src/${VALID_ASSET_UUID}.png`
    // winner の key(.jpg)は消さず、自分が書いた孤児(.png)を消す(lost-CAS
    // orphan cleanup)+ row が ready に到達したので temp key も消す(temp
    // cleanup)— 合計 2 回、winner key は一度も対象にならない。
    expect(mockDeleteObject).toHaveBeenCalledWith(myFinalKey)
    expect(mockDeleteObject).toHaveBeenCalledWith(TEMP_OBJECT_KEY)
    expect(mockDeleteObject).not.toHaveBeenCalledWith(winnerKey)
    expect(mockDeleteObject).toHaveBeenCalledTimes(2)
  })

  // Important fix: 同一 mime の byte-identical concurrent finalize(winner の
  // objectKey が自分の finalObjectKey と一致)なら、自分の PUT が書いたのと
  // 同じ object を winner の行が指しているため、delete してはならない(winner
  // の key を保全)。
  it('0-row UPDATE + re-SELECT observes ready with the SAME final key (same-mime idempotent winner) → { ok: true } idempotent, does NOT delete (winner key preserved)', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
    dbState.updateReturningResult = []
    const expectedFinalKey = `users/user-1/src/${VALID_ASSET_UUID}.png`
    dbState.reSelectResult = [{ status: 'ready', objectKey: expectedFinalKey }]
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(dbState.updateCalled).toBe(true)
    // 最終 key の孤児 cleanup は対象外(winner が自分と同じ key を指すため)だが、
    // row は ready に到達しているので temp key の cleanup は行われる。
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(TEMP_OBJECT_KEY)
    expect(mockDeleteObject).not.toHaveBeenCalledWith(expectedFinalKey)
  })

  it('0-row UPDATE + re-SELECT observes row gone (no-resurrection) → { ok: false }, orphaned final object is deleted', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject.mockResolvedValueOnce({ bytes: pngBytes })
    dbState.updateReturningResult = []
    dbState.reSelectResult = []
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(false)
    expect(dbState.updateCalled).toBe(true)
    const expectedFinalKey = `users/user-1/src/${VALID_ASSET_UUID}.png`
    // row 自体が消失(not-found)= result.ok===false ゆえ temp cleanup は
    // 発火しない(orphan cleanup のみ)。
    expect(mockDeleteObject).toHaveBeenCalledWith(expectedFinalKey)
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
  })

  // precondition_failed(自分は書いていない)で CAS に負けた場合、最終 key の
  // 孤児 cleanup は対象外(自分の PUT が物理的に書いたわけではないため —
  // putResult==='success' ガード)。 だが row は ready に到達しているため、
  // temp key の cleanup(別ガード・result.ok 判定)は行われる。
  it('precondition_failed (hash match, no re-PUT) + CAS 0-row → does NOT delete the final key (never wrote it), but DOES delete the now-unused temp key', async () => {
    dbState.selectResult = [reservedRow()]
    mockGetObject
      .mockResolvedValueOnce({ bytes: pngBytes }) // temp key GET
      .mockResolvedValueOnce({ bytes: pngBytes }) // final key GET (hash compare) — 同一バイト
    mockPutObject.mockResolvedValueOnce('precondition_failed')
    dbState.updateReturningResult = []
    const expectedFinalKey = `users/user-1/src/${VALID_ASSET_UUID}.png`
    dbState.reSelectResult = [{ status: 'ready', objectKey: expectedFinalKey }]
    const { finalizeSource } = await importActions()
    const r = await finalizeSource(VALID_ASSET_UUID)
    expect(r.ok).toBe(true)
    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(TEMP_OBJECT_KEY)
    expect(mockDeleteObject).not.toHaveBeenCalledWith(expectedFinalKey)
  })
})

// canonical review Minor: sniffed magic-byte format と sharp decode format が
// 食い違う分岐(verifyImageBytes 内の decodedMime !== sniffed 相当)を明示 pin
// する。 3 形式のシグネチャ先頭バイトは相互排他(0x89/0xFF/0x52)かつ sharp 自身の
// format dispatch も magic-byte 起点のため、 実バイト(sharp を mock しない)では
// この不一致を再現できない(実測: PNG 署名+別形式実バイトの frankenstein buffer は
// sharp が decode 失敗として reject する — 「別 format として成功裏に decode」は
// 作れない)。 ゆえに比較ロジックを pure 関数として分離し(reconcileSniffedAndDecodedMime)、
// sharp を mock せずにこの分岐だけを直接検証する。
describe('reconcileSniffedAndDecodedMime (defense-in-depth format 突合せ)', () => {
  it('sniffed と decoded format が一致 → その mime を返す', () => {
    expect(reconcileSniffedAndDecodedMime('image/png', 'png')).toBe('image/png')
    expect(reconcileSniffedAndDecodedMime('image/jpeg', 'jpeg')).toBe('image/jpeg')
    expect(reconcileSniffedAndDecodedMime('image/webp', 'webp')).toBe('image/webp')
  })

  it('sniffed と decoded format が食い違う(例: PNG署名なのに jpeg として decode) → null', () => {
    expect(reconcileSniffedAndDecodedMime('image/png', 'jpeg')).toBeNull()
    expect(reconcileSniffedAndDecodedMime('image/jpeg', 'webp')).toBeNull()
    expect(reconcileSniffedAndDecodedMime('image/webp', 'png')).toBeNull()
  })

  it('decoded format が enum 3 種の外(gif/tiff/heif 等) → null', () => {
    expect(reconcileSniffedAndDecodedMime('image/png', 'gif')).toBeNull()
    expect(reconcileSniffedAndDecodedMime('image/jpeg', 'tiff')).toBeNull()
    expect(reconcileSniffedAndDecodedMime('image/webp', 'heif')).toBeNull()
  })
})

// Critical fix(Codex 指摘・2026-07-31): DECODE_MAX_PIXELS を sharp 既定値
// (268,402,689px ≈ 1GB decode)から 40,000,000px(≈160MB decoded・A4@600DPI
// スキャンを十分許容する上限)へ引き下げた。 小さい圧縮バイト列(単色画像は
// 高圧縮率)が巨大ピクセル数へ展開する decode bomb を、 実ピクセルデコード
// (toBuffer())へ進む前の metadata() 読取り段階で遮断できることを実測する。
describe('verifyImageBytes (decode bomb 防御・DECODE_MAX_PIXELS)', () => {
  it('DECODE_MAX_PIXELS を超える寸法の小さい圧縮ファイル(単色画像)は、重い decode に進む前に reject される', async () => {
    // 6400×6251 = 40,006,400px(DECODE_MAX_PIXELS=40,000,000 を僅かに超過)。
    // 単色ゆえ圧縮後は数百バイト〜数KB程度(小さい圧縮バイト列 → 巨大展開の
    // 典型形)。 sharp の limitInputPixels は OpenInput(ヘッダ読込)時点で
    // throw するため、 verifyImageBytes の metadata() 呼出だけで reject され
    // toBuffer() の実ピクセルデコードには到達しない(実測: 本 test 自体は
    // 数十 ms で完了する — 巨大 buffer の実 decode をしていないことの傍証)。
    const overCapBytes = await sharp({
      create: {
        width: 6400,
        height: 6251,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer()
    expect(6400 * 6251).toBeGreaterThan(DECODE_MAX_PIXELS)

    const result = await verifyImageBytes(overCapBytes)
    expect(result).toBeNull()
  })

  it('DECODE_MAX_PIXELS ちょうど以下の寸法は受理される(境界)', async () => {
    // 4000×3999 = 15,996,000px(DECODE_MAX_PIXELS 未満)。 通常の試験ページ
    // スキャン相当の寸法で正常受理されることを確認する(下げすぎて実運用の
    // 高解像度スキャンを弾いていないことの回帰防止)。
    const withinCapBytes = await sharp({
      create: {
        width: 4000,
        height: 3999,
        channels: 3,
        background: { r: 200, g: 200, b: 200 },
      },
    })
      .png()
      .toBuffer()
    expect(4000 * 3999).toBeLessThan(DECODE_MAX_PIXELS)

    const result = await verifyImageBytes(withinCapBytes)
    expect(result).not.toBeNull()
    expect(result?.width).toBe(4000)
    expect(result?.height).toBe(3999)
  })
})
