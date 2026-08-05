import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { getTableName } from 'drizzle-orm'
import sharp from 'sharp'

// ②-4a Task 10: cropFigureAndStore の unit test。
//
// r2(getObject/putObject)を mock する(実 R2 を叩かない・CLAUDE.md AI 絶対
// ルール 2 と同根拠 — 外部副作用は mock 必須)。DB は `withTenantTx` を
// mock して軽量 fake tx(select/insert とも table identity で分岐する
// in-memory recorder)へ差し替える — 本 file の目的は crop-and-store.ts の
// 分岐ロジック(412 branch・guard・決定性)であり、実 RLS/tenancy 検証は
// tests/integration/pg/crop-and-store.test.ts(iso・実 PG)の責務(brief の
// unit/iso 分担どおり)。
//
// sharp は mock しない(「tiny real buffer」方針・source-asset-finalize.test.ts
// と同じ判断) — 実際の decode/extract/encode 経路そのものを検証する。
// toCropRect(T9・pure)も mock しない — 制約#2(audit値が toCropRect の戻り値と
// 一致する)を実体で確認するため。

import { assets, assetDerivations, sourceAssets, uploadOperations } from '@/lib/db/schema'
import { toCropRect, type Box2d } from './domain/crop-geometry'

const { mockGetObject, mockPutObject, mockWithTenantTx } = vi.hoisted(() => ({
  mockGetObject: vi.fn(),
  mockPutObject: vi.fn(),
  mockWithTenantTx: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => ({
  getObject: mockGetObject,
  putObject: mockPutObject,
}))

vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: mockWithTenantTx,
}))

import {
  cropFigureAndStore,
  cropFigureFromBuffer,
  classifyCropOutcome,
  CROP_OUTCOME_CLASS,
  CROP_PIPELINE_VERSION,
  type CropAndStoreOutcome,
  type CropFigureInput,
  type CropFigureFromBufferInput,
} from './crop-and-store'

// ---------------------------------------------------------------------------
// fake tx: table identity(getTableName)で select/insert を分岐する軽量 recorder。
// crop-and-store.ts の query shape は常に `select(cols).from(table).where(cond)`
// (追加チェーンなし)・`insert(table).values(v)`(`.returning()` なし)のみ
// なので、この単純な形で全経路をカバーできる。
// ---------------------------------------------------------------------------
type FakeState = {
  uploadOperationsResult: Record<string, unknown>[]
  sourceAssetsResult: Record<string, unknown>[]
  assetsResult: Record<string, unknown>[]
  insertedAssets: Record<string, unknown>[]
  insertedDerivations: Record<string, unknown>[]
  // Important#1 fix test knob: simulate the `assets` INSERT's
  // `onConflictDoNothing({target: assets.id}).returning(...)` hitting a
  // conflict (another concurrent writer already committed the row) —
  // `.returning()` resolves to `[]` instead of inserting.
  assetsInsertConflict: boolean
}

function makeFakeState(): FakeState {
  return {
    uploadOperationsResult: [],
    sourceAssetsResult: [],
    assetsResult: [],
    insertedAssets: [],
    insertedDerivations: [],
    assetsInsertConflict: false,
  }
}

function installFakeTx(state: FakeState) {
  mockWithTenantTx.mockImplementation(async (_userId: string, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: (_cols: unknown) => ({
        from: (table: unknown) => ({
          where: async (_cond: unknown) => {
            const name = getTableName(table as never)
            if (name === 'upload_operations') return state.uploadOperationsResult
            if (name === 'source_assets') return state.sourceAssetsResult
            if (name === 'assets') return state.assetsResult
            throw new Error(`unexpected select from ${name}`)
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: Record<string, unknown>) => {
          const name = getTableName(table as never)
          // Plain `await tx.insert(table).values(v)` path (asset_derivations,
          // and the pre-fix `assets` insert this chain replaces) — thenable.
          const chain = {
            then: (
              resolve: (value: unknown) => void,
              reject: (reason?: unknown) => void,
            ) => {
              if (name === 'assets') {
                state.insertedAssets.push(v)
              } else if (name === 'asset_derivations') {
                state.insertedDerivations.push(v)
              } else {
                reject(new Error(`unexpected insert into ${name}`))
                return
              }
              resolve(undefined)
            },
            // `.onConflictDoNothing({target}).returning(cols)` path — only the
            // `assets` insert in crop-and-store.ts uses this chain.
            onConflictDoNothing: (_opts: unknown) => ({
              returning: async (_cols: unknown) => {
                if (name !== 'assets') {
                  throw new Error(`unexpected onConflictDoNothing insert into ${name}`)
                }
                if (state.assetsInsertConflict) {
                  return [] // DO NOTHING fired — another writer already has this id.
                }
                state.insertedAssets.push(v)
                return [{ id: v.id }]
              },
            }),
          }
          return chain
        },
      }),
    }
    return fn(tx)
  })
}

// table identity sanity(schema import の table object が実際に期待名を持つこと)。
// これが崩れると fake tx の分岐が静かに全部 no-op 化するため、先に固定する。
describe('fake tx table identity (sanity)', () => {
  it('schema table names match the fake tx branch keys', () => {
    expect(getTableName(uploadOperations)).toBe('upload_operations')
    expect(getTableName(sourceAssets)).toBe('source_assets')
    expect(getTableName(assets)).toBe('assets')
    expect(getTableName(assetDerivations)).toBe('asset_derivations')
  })
})

const USER_ID = 'user-1'
const OPERATION_ID = 'op-1'
const SOURCE_ID = 's1'
const SOURCE_ASSET_ID = 'source-asset-1'
const SOURCE_OBJECT_KEY = `users/${USER_ID}/src/${SOURCE_ASSET_ID}.png`
// box2d チェックの裏取り: pad±60 -> [40,40,860,860](clamp 無効)-> px 化(100x100)
// -> [4.0,4.0,86.0,86.0] -> floor/ceil -> left=4,top=4,cropW=82,cropH=82。
const VALID_BOX2D: Box2d = [100, 100, 800, 800]
const SOURCE_WIDTH = 100
const SOURCE_HEIGHT = 100

function preparedOpRow(status = 'prepared') {
  return [{ status, sourceDocumentId: 'doc-1' }]
}
function readySourceRow() {
  return [
    {
      id: SOURCE_ASSET_ID,
      objectKey: SOURCE_OBJECT_KEY,
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      status: 'ready',
    },
  ]
}

function baseInput(overrides: Partial<CropFigureInput> = {}): CropFigureInput {
  return {
    userId: USER_ID,
    operationId: OPERATION_ID,
    sourceId: SOURCE_ID,
    figureAssetId: 'figure-asset-1',
    box2d: VALID_BOX2D,
    detectTarget: 'question_text',
    ...overrides,
  }
}

let sourcePngBytes: Buffer

beforeEach(async () => {
  mockGetObject.mockReset()
  mockPutObject.mockReset()
  mockWithTenantTx.mockReset()
  sourcePngBytes = await sharp({
    create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: { r: 10, g: 200, b: 50 } },
  })
    .png()
    .toBuffer()
  mockGetObject.mockImplementation(async (key: string) => {
    if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
    return null
  })
})

describe('cropFigureAndStore — guards (constraint#1: prepared-only)', () => {
  it('operation not found -> not_prepared, no R2 touched, no insert', async () => {
    const state = makeFakeState()
    installFakeTx(state)
    // uploadOperationsResult は空(0 行)。

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'not_prepared' })
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(state.insertedAssets).toHaveLength(0)
  })

  it("operation status !== 'prepared' (e.g. still 'claimed') -> not_prepared, no R2/DB writes", async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow('claimed')
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'not_prepared' })
    expect(mockGetObject).not.toHaveBeenCalled()
    expect(mockPutObject).not.toHaveBeenCalled()
  })

  it('source_assets row missing (sourceId not found) -> source_not_ready, no R2/DB writes', async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow('prepared')
    state.sourceAssetsResult = []
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'source_not_ready' })
    expect(mockGetObject).not.toHaveBeenCalled()
  })

  it("source_assets row status !== 'ready' (still 'reserved') -> source_not_ready", async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow('prepared')
    state.sourceAssetsResult = [
      { id: SOURCE_ASSET_ID, objectKey: SOURCE_OBJECT_KEY, width: null, height: null, status: 'reserved' },
    ]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'source_not_ready' })
    expect(mockGetObject).not.toHaveBeenCalled()
  })
})

describe('cropFigureAndStore — source unreadable', () => {
  it('R2 GET of the source object fails (never-throw null) -> source_unreadable, no PUT/insert', async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    installFakeTx(state)
    mockGetObject.mockResolvedValueOnce(null)

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'source_unreadable' })
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(state.insertedAssets).toHaveLength(0)
  })
})

describe('cropFigureAndStore — crop_failed (degenerate toCropRect)', () => {
  it('inverted box_2d (x_max < x_min) -> toCropRect null -> crop_failed, no PUT/insert', async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    installFakeTx(state)

    const invertedBox: Box2d = [300, 700, 600, 200]
    // 裏取り(crop-geometry.test.ts と同じ入力): toCropRect 自体が null を返す
    // ことを直接確認しておく(このテストの前提)。
    expect(toCropRect(invertedBox, SOURCE_WIDTH, SOURCE_HEIGHT)).toBeNull()

    const result = await cropFigureAndStore(baseInput({ box2d: invertedBox }))
    expect(result).toEqual({ outcome: 'crop_failed' })
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(state.insertedAssets).toHaveLength(0)
  })
})

describe('cropFigureAndStore — happy path + audit-derived-from-toCropRect (constraint#2)', () => {
  it('fresh PUT success -> stored, assets/asset_derivations inserted with values equal to a direct toCropRect(...) call', async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    installFakeTx(state)
    mockPutObject.mockResolvedValueOnce('success')

    const input = baseInput({ figureAssetId: 'figure-asset-happy' })
    const result = await cropFigureAndStore(input)
    expect(result).toEqual({ outcome: 'stored' })

    expect(mockPutObject).toHaveBeenCalledTimes(1)
    const [putKey, putBytes, putMime, putOpts] = mockPutObject.mock.calls[0]
    expect(putKey).toBe(`users/${USER_ID}/figure-asset-happy.webp`)
    expect(putMime).toBe('image/webp')
    expect(putOpts).toEqual({ ifNoneMatch: true })

    expect(state.insertedAssets).toHaveLength(1)
    expect(state.insertedDerivations).toHaveLength(1)
    const assetRow = state.insertedAssets[0]!
    const derivationRow = state.insertedDerivations[0]!

    expect(assetRow.id).toBe('figure-asset-happy')
    expect(assetRow.userId).toBe(USER_ID)
    expect(assetRow.objectKey).toBe(putKey)
    expect(assetRow.mime).toBe('image/webp')
    expect(assetRow.status).toBe('ready')
    expect(assetRow.byteSize).toBe((putBytes as Buffer).length)
    expect(assetRow.hash).toBe(createHash('sha256').update(putBytes as Buffer).digest('hex'))

    // 制約#2 の核心: 監査値が toCropRect(...) の直接呼出結果と完全一致する
    // (crop-and-store.ts が独立に再計算していないことのpin)。
    const expectedRect = toCropRect(input.box2d, SOURCE_WIDTH, SOURCE_HEIGHT)
    expect(expectedRect).not.toBeNull()
    expect(assetRow.width).toBe(expectedRect!.cropW)
    expect(assetRow.height).toBe(expectedRect!.cropH)
    expect(derivationRow.assetId).toBe('figure-asset-happy')
    expect(derivationRow.userId).toBe(USER_ID)
    expect(derivationRow.sourceAssetId).toBe(SOURCE_ASSET_ID)
    expect(derivationRow.cropW).toBe(expectedRect!.cropW)
    expect(derivationRow.cropH).toBe(expectedRect!.cropH)
    expect(derivationRow.paddingPct).toBe(expectedRect!.paddingPct)
    expect(derivationRow.origBbox).toEqual({
      y_min: expectedRect!.origBbox[0],
      x_min: expectedRect!.origBbox[1],
      y_max: expectedRect!.origBbox[2],
      x_max: expectedRect!.origBbox[3],
    })
    expect(derivationRow.clampedBbox).toEqual({
      y_min: expectedRect!.clampedBbox[0],
      x_min: expectedRect!.clampedBbox[1],
      y_max: expectedRect!.clampedBbox[2],
      x_max: expectedRect!.clampedBbox[3],
    })
    expect(derivationRow.detectTarget).toBe('question_text')
    expect(derivationRow.pipelineVersion).toBe(CROP_PIPELINE_VERSION)
  })
})

describe('cropFigureAndStore — deterministic encode (constraint#3: same source+box2d -> identical bytes)', () => {
  it('two independent invocations with identical source bytes + box2d produce byte-identical crop output (different assetId to avoid key collision)', async () => {
    const stateA = makeFakeState()
    stateA.uploadOperationsResult = preparedOpRow()
    stateA.sourceAssetsResult = readySourceRow()
    installFakeTx(stateA)
    mockPutObject.mockResolvedValueOnce('success')
    const resultA = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-det-a' }))
    expect(resultA).toEqual({ outcome: 'stored' })
    const bytesA = mockPutObject.mock.calls[0]![1] as Buffer

    mockPutObject.mockReset()
    const stateB = makeFakeState()
    stateB.uploadOperationsResult = preparedOpRow()
    stateB.sourceAssetsResult = readySourceRow()
    installFakeTx(stateB)
    mockPutObject.mockResolvedValueOnce('success')
    const resultB = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-det-b' }))
    expect(resultB).toEqual({ outcome: 'stored' })
    const bytesB = mockPutObject.mock.calls[0]![1] as Buffer

    expect(bytesA.equals(bytesB)).toBe(true)
    expect(stateA.insertedAssets[0]!.hash).toBe(stateB.insertedAssets[0]!.hash)
  })
})

describe('cropFigureAndStore — 412 branches (constraint#5)', () => {
  async function produceReferenceBytes(): Promise<Buffer> {
    // 「前回の正常書込で実際に R2 に置かれたバイト」を用意するため、SUT 自身を
    // 1 回 'success' 経路で走らせて生成物を取得する(webp encode の厳密なバイト
    // 列をテスト側で再現・ハードコードしない — sharp/libwebp のバージョン依存を
    // テストに持ち込まないための選択)。
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    installFakeTx(state)
    mockPutObject.mockResolvedValueOnce('success')
    await cropFigureAndStore(baseInput({ figureAssetId: 'figure-ref' }))
    return mockPutObject.mock.calls[0]![1] as Buffer
  }

  it('reuse: 412 + hash match + existing assets row ready -> reused, no insert', async () => {
    const referenceBytes = await produceReferenceBytes()
    mockPutObject.mockReset()
    mockGetObject.mockReset()
    mockGetObject.mockImplementation(async (key: string) => {
      if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
      return { bytes: referenceBytes } // final key GET
    })
    mockPutObject.mockResolvedValueOnce('precondition_failed')

    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsResult = [{ status: 'ready' }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-ref' }))
    expect(result).toEqual({ outcome: 'reused' })
    expect(state.insertedAssets).toHaveLength(0)
    expect(state.insertedDerivations).toHaveLength(0)
  })

  it('crash-recovery: 412 + hash match + NO existing assets row -> proceeds to insert (stored), using the already-confirmed-matching bytes', async () => {
    const referenceBytes = await produceReferenceBytes()
    mockPutObject.mockReset()
    mockGetObject.mockReset()
    mockGetObject.mockImplementation(async (key: string) => {
      if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
      return { bytes: referenceBytes }
    })
    mockPutObject.mockResolvedValueOnce('precondition_failed')

    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsResult = [] // no row yet (crashed before INSERT last time)
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-ref' }))
    expect(result).toEqual({ outcome: 'stored' })
    expect(state.insertedAssets).toHaveLength(1)
    expect(state.insertedAssets[0]!.hash).toBe(createHash('sha256').update(referenceBytes).digest('hex'))
  })

  it('hash-mismatch loud fail: 412 + existing object bytes differ from our own recomputed bytes -> hash_mismatch, no insert', async () => {
    await produceReferenceBytes()
    mockPutObject.mockReset()
    mockGetObject.mockReset()
    const differentBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .webp()
      .toBuffer()
    mockGetObject.mockImplementation(async (key: string) => {
      if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
      return { bytes: differentBytes }
    })
    mockPutObject.mockResolvedValueOnce('precondition_failed')

    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsResult = [{ status: 'ready' }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-ref' }))
    expect(result).toEqual({ outcome: 'hash_mismatch' })
    expect(state.insertedAssets).toHaveLength(0)
  })

  it("forbidden: 412 + hash match + existing assets row status 'deleting' -> forbidden, no insert (does not resurrect a GC'd asset)", async () => {
    const referenceBytes = await produceReferenceBytes()
    mockPutObject.mockReset()
    mockGetObject.mockReset()
    mockGetObject.mockImplementation(async (key: string) => {
      if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
      return { bytes: referenceBytes }
    })
    mockPutObject.mockResolvedValueOnce('precondition_failed')

    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsResult = [{ status: 'deleting' }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-ref' }))
    expect(result).toEqual({ outcome: 'forbidden' })
    expect(state.insertedAssets).toHaveLength(0)
  })

  it("forbidden: 412 + hash match + existing assets row status 'deleted' -> forbidden, no insert", async () => {
    const referenceBytes = await produceReferenceBytes()
    mockPutObject.mockReset()
    mockGetObject.mockReset()
    mockGetObject.mockImplementation(async (key: string) => {
      if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
      return { bytes: referenceBytes }
    })
    mockPutObject.mockResolvedValueOnce('precondition_failed')

    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsResult = [{ status: 'deleted' }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-ref' }))
    expect(result).toEqual({ outcome: 'forbidden' })
    expect(state.insertedAssets).toHaveLength(0)
  })

  it('412 + GET of the final key fails (never-throw null) -> error, no insert', async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    installFakeTx(state)
    mockPutObject.mockResolvedValueOnce('precondition_failed')
    mockGetObject.mockImplementation(async (key: string) => {
      if (key === SOURCE_OBJECT_KEY) return { bytes: sourcePngBytes }
      return null
    })

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'error' })
    expect(state.insertedAssets).toHaveLength(0)
  })
})

describe('cropFigureAndStore — R2 PUT technical failure', () => {
  it("putObject returns 'error' -> error outcome, no insert", async () => {
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    installFakeTx(state)
    mockPutObject.mockResolvedValueOnce('error')

    const result = await cropFigureAndStore(baseInput())
    expect(result).toEqual({ outcome: 'error' })
    expect(state.insertedAssets).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Important#1 fix (canonical + Codex independent finding): two callers racing
// the same figureAssetId could both reach the `assets` INSERT (either via the
// ordinary 'success' PUT path, or via the 412 crash-recovery "hash match, no
// row yet" path) before either commits. Pre-fix, this was a plain unconditional
// insert -> a real Postgres run would throw a 23505 unique-violation instead of
// returning the idempotent `reused` the outcome contract promises. The fix
// routes the `assets` insert through `.onConflictDoNothing({target:
// assets.id}).returning(...)`: 0 rows returned means a concurrent writer won
// the race, so we re-read the row and apply the exact same hash/status
// semantics as the 412 branch, rather than either throwing or blindly
// re-inserting/re-declaring 'stored'.
//
// This test isolates that INSERT-level race directly (independent of which R2
// branch led to it): the PUT itself succeeds ('success' — no R2-level
// collision), but the `assets` insert races with a writer who already
// committed an identical `ready` row for this exact id.
//
// RED/GREEN verified manually (see task-10-report.md for the transcript):
// reverting `writeCropAssetRows` to a plain `await tx.insert(assets).values(...)`
// (no onConflictDoNothing) makes this test FAIL — the old code ignores
// `assetsInsertConflict` entirely, pushes a duplicate row into
// `insertedAssets`/`insertedDerivations`, and returns `{ outcome: 'stored' }`
// instead of `{ outcome: 'reused' }`. Restoring the fix makes it PASS.
// ---------------------------------------------------------------------------
describe('cropFigureAndStore — Important#1 fix: race-safe assets INSERT (ON CONFLICT DO NOTHING)', () => {
  it('insert races with a concurrent writer that already committed an identical ready row -> reused, no duplicate assets/derivations rows', async () => {
    // Establish the "other worker's" bytes/hash deterministically (same
    // source + same box2d as `baseInput()` -> byte-identical crop output,
    // constraint#3) by running the SUT once for a throwaway id.
    const refState = makeFakeState()
    refState.uploadOperationsResult = preparedOpRow()
    refState.sourceAssetsResult = readySourceRow()
    installFakeTx(refState)
    mockPutObject.mockResolvedValueOnce('success')
    await cropFigureAndStore(baseInput({ figureAssetId: 'figure-race-reference' }))
    const referenceHash = refState.insertedAssets[0]!.hash as string

    // Now the real call: fresh PUT succeeds (no R2-level collision), but the
    // `assets` INSERT races with a concurrent writer who already committed an
    // identical ready row under this exact figureAssetId.
    mockPutObject.mockReset()
    mockPutObject.mockResolvedValueOnce('success')
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsInsertConflict = true
    state.assetsResult = [{ status: 'ready', hash: referenceHash }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-race' }))
    expect(result).toEqual({ outcome: 'reused' })
    // The race loser's own insert did NOT take, and it must not compensate by
    // writing a duplicate/second row for either table.
    expect(state.insertedAssets).toHaveLength(0)
    expect(state.insertedDerivations).toHaveLength(0)
  })

  it('insert races with a concurrent writer whose committed row has a DIFFERENT hash -> hash_mismatch (loud fail), no insert', async () => {
    mockPutObject.mockResolvedValueOnce('success')
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsInsertConflict = true
    state.assetsResult = [{ status: 'ready', hash: 'deadbeef-not-our-hash' }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-race-bad' }))
    expect(result).toEqual({ outcome: 'hash_mismatch' })
    expect(state.insertedAssets).toHaveLength(0)
    expect(state.insertedDerivations).toHaveLength(0)
  })

  it("insert races with a concurrent writer whose committed row is 'deleting' -> forbidden, no insert", async () => {
    const refState = makeFakeState()
    refState.uploadOperationsResult = preparedOpRow()
    refState.sourceAssetsResult = readySourceRow()
    installFakeTx(refState)
    mockPutObject.mockResolvedValueOnce('success')
    await cropFigureAndStore(baseInput({ figureAssetId: 'figure-race-reference-2' }))
    const referenceHash = refState.insertedAssets[0]!.hash as string

    mockPutObject.mockReset()
    mockPutObject.mockResolvedValueOnce('success')
    const state = makeFakeState()
    state.uploadOperationsResult = preparedOpRow()
    state.sourceAssetsResult = readySourceRow()
    state.assetsInsertConflict = true
    state.assetsResult = [{ status: 'deleting', hash: referenceHash }]
    installFakeTx(state)

    const result = await cropFigureAndStore(baseInput({ figureAssetId: 'figure-race-deleting' }))
    expect(result).toEqual({ outcome: 'forbidden' })
    expect(state.insertedAssets).toHaveLength(0)
    expect(state.insertedDerivations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Important#2 fix (canonical): T12 needs to know, per outcome, whether a
// figure's crop should be counted as done, retried, or treated as a
// caller/state-precondition issue. Pin the exact classification (no retry
// engine/policy here — that's T12/T14's job).
// ---------------------------------------------------------------------------
describe('classifyCropOutcome / CROP_OUTCOME_CLASS (constraint: T12 terminal/retryable classification)', () => {
  it('classifies every outcome variant exactly as documented', () => {
    const expected: Record<CropAndStoreOutcome['outcome'], string> = {
      stored: 'success',
      reused: 'success',
      crop_failed: 'terminal',
      forbidden: 'terminal',
      hash_mismatch: 'terminal',
      source_unreadable: 'retryable',
      error: 'retryable',
      not_prepared: 'caller_error',
      source_not_ready: 'caller_error',
    }
    for (const [outcome, cls] of Object.entries(expected)) {
      expect(classifyCropOutcome(outcome as CropAndStoreOutcome['outcome'])).toBe(cls)
      expect(CROP_OUTCOME_CLASS[outcome as CropAndStoreOutcome['outcome']]).toBe(cls)
    }
    // every outcome variant has an entry (no silent gaps if a new outcome is
    // added to the union without updating the classification map).
    expect(Object.keys(CROP_OUTCOME_CLASS).sort()).toEqual(Object.keys(expected).sort())
  })
})

// ---------------------------------------------------------------------------
// ②-4a Task S-3: cropFigureFromBuffer(単一 invocation 経路の crop entry)。
//
// 旧 entry との差分だけを pin する:
//   ① source 行の SELECT も R2 GET も行わない(バイトと寸法を引数で受ける)
//   ② PUT key は crop asset key のみ(`src/` を含まない = source を R2 に置かない)
//   ③ provenance の source_asset_id は NULL(参照すべき source_assets 行が無い)
//   ④ 保存側の機構(rect の単一算出点 / 条件付き PUT / 412 hash 照合 / ON CONFLICT)は
//      旧 entry と同一実装を共有する
// ---------------------------------------------------------------------------
describe('cropFigureFromBuffer (S-3) — メモリのバイトから crop', () => {
  function bufferInput(overrides: Partial<CropFigureFromBufferInput> = {}): CropFigureFromBufferInput {
    return {
      userId: USER_ID,
      sourceBytes: sourcePngBytes,
      sourceWidth: SOURCE_WIDTH,
      sourceHeight: SOURCE_HEIGHT,
      sourceId: SOURCE_ID,
      figureAssetId: 'figure-asset-buf',
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
      ...overrides,
    }
  }

  it('source 行 SELECT も R2 GET もせず crop → PUT → 行確定する(key は crop asset のみ・src/ を含まない)', async () => {
    const state = makeFakeState()
    // upload_operations / source_assets を読もうとしたら fake tx が throw する
    // (installFakeTx は未知 table のみ throw するが、この 2 つは空配列を返して
    // guard 不成立になるため、そもそも読まないことを mockGetObject 側でも pin する)。
    installFakeTx(state)
    mockPutObject.mockResolvedValueOnce('success')

    const input = bufferInput()
    const result = await cropFigureFromBuffer(input)
    expect(result).toEqual({ outcome: 'stored' })

    // R2 GET は 1 度も呼ばれない(source は呼出元のメモリにある)。
    expect(mockGetObject).not.toHaveBeenCalled()

    expect(mockPutObject).toHaveBeenCalledTimes(1)
    const [putKey, putBytes, putMime, putOpts] = mockPutObject.mock.calls[0]
    expect(putKey).toBe(`users/${USER_ID}/figure-asset-buf.webp`)
    // 新経路は source を R2 に置かない = `src/` prefix の key を一切作らない。
    expect(putKey).not.toContain('/src/')
    expect(putMime).toBe('image/webp')
    expect(putOpts).toEqual({ ifNoneMatch: true })

    // rect は toCropRect の**単一呼出結果**由来(独立再計算しない・制約#2)。
    const expectedRect = toCropRect(input.box2d, SOURCE_WIDTH, SOURCE_HEIGHT)
    expect(expectedRect).not.toBeNull()
    const assetRow = state.insertedAssets[0]!
    expect(assetRow.objectKey).toBe(putKey)
    expect(assetRow.status).toBe('ready')
    expect(assetRow.byteSize).toBe((putBytes as Buffer).length)
    expect(assetRow.width).toBe(expectedRect!.cropW)
    expect(assetRow.height).toBe(expectedRect!.cropH)

    const derivationRow = state.insertedDerivations[0]!
    // 新経路に source_assets 行は存在しない(migration 0031 で nullable 化)。
    expect(derivationRow.sourceAssetId).toBeNull()
    expect(derivationRow.cropW).toBe(expectedRect!.cropW)
    expect(derivationRow.cropH).toBe(expectedRect!.cropH)
    expect(derivationRow.detectTarget).toBe('question_text')
    expect(derivationRow.pipelineVersion).toBe(CROP_PIPELINE_VERSION)
  })

  it('退化 box_2d は crop_failed(PUT も行 INSERT もしない)', async () => {
    const state = makeFakeState()
    installFakeTx(state)

    const result = await cropFigureFromBuffer(bufferInput({ box2d: [100, 800, 800, 100] }))
    expect(result).toEqual({ outcome: 'crop_failed' })
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(state.insertedAssets).toHaveLength(0)
  })

  it('412 + hash 一致 + ready 行あり → reused(旧 entry と同じ 412 機構を共有)', async () => {
    const state = makeFakeState()
    installFakeTx(state)
    // 1 回目: 実バイトを作って R2 の既存実体として使い回す。
    mockPutObject.mockResolvedValueOnce('success')
    await cropFigureFromBuffer(bufferInput())
    const storedBytes = mockPutObject.mock.calls[0][1] as Buffer

    mockPutObject.mockReset()
    mockGetObject.mockReset()
    mockPutObject.mockResolvedValueOnce('precondition_failed')
    mockGetObject.mockResolvedValueOnce({ bytes: storedBytes })
    state.assetsResult = [{ status: 'ready' }]
    state.insertedAssets.length = 0
    state.insertedDerivations.length = 0

    const result = await cropFigureFromBuffer(bufferInput())
    expect(result).toEqual({ outcome: 'reused' })
    expect(state.insertedAssets).toHaveLength(0)
    expect(state.insertedDerivations).toHaveLength(0)
  })

  it("putObject が 'error' なら error(行を作らない)", async () => {
    const state = makeFakeState()
    installFakeTx(state)
    mockPutObject.mockResolvedValueOnce('error')

    const result = await cropFigureFromBuffer(bufferInput())
    expect(result).toEqual({ outcome: 'error' })
    expect(state.insertedAssets).toHaveLength(0)
    expect(state.insertedDerivations).toHaveLength(0)
  })
})
