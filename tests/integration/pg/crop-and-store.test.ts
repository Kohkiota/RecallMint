// ②-4a Task 10: cropFigureAndStore の実 PG 検証。
//
// R2(getObject/putObject)を mock し(実 R2 を叩かない・CLAUDE.md AI 絶対
// ルール 2 と同根拠)、実 PG 上で以下を検証する: ① operation status='prepared'
// 確認済みの guard read(実 RLS 下での owner scope) ② assets +
// asset_derivations の実際の INSERT 内容(列レベルで一致)③ tenancy(RLS 有効
// 下で他 user の operation/source_asset を owner scope が正しく弾く)。
//
// 412 分岐の意思決定ロジック自体(hash 一致/不一致・deleting 禁止)は
// lib/media/crop-and-store.test.ts(unit・fake tx)で網羅済み — 本 file は
// 「実 DB に実際に何が書かれるか」と「RLS tenancy」に焦点を絞る(brief の
// unit/iso 分担どおり)。sharp は mock しない(tiny real buffer 方針)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

import { closeDb } from '@/lib/db'
import {
  assetDerivations,
  assets,
  exams,
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  users,
} from '@/lib/db/schema'
import { toCropRect, type Box2d } from '@/lib/media/domain/crop-geometry'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockGetObject, mockPutObject } = vi.hoisted(() => ({
  mockGetObject: vi.fn(),
  mockPutObject: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => ({
  getObject: mockGetObject,
  putObject: mockPutObject,
}))

// crop-and-store.ts は directive 無し module(server action ではない)なので
// top-level import で問題ない(vi.mock は import より前に hoist される)。
import { cropFigureAndStore, CROP_PIPELINE_VERSION } from '@/lib/media/crop-and-store'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// 裏取り(unit test と同じ入力): pad±60 -> [40,40,860,860](clamp 無効)->
// px 化(100x100) -> floor/ceil -> left=4,top=4,cropW=82,cropH=82。
const VALID_BOX2D: Box2d = [100, 100, 800, 800]
const SOURCE_WIDTH = 100
const SOURCE_HEIGHT = 100

describe('cropFigureAndStore (T10) — 実 PG', () => {
  let userAId: string
  let userBId: string
  let examAId: string
  let sourceDocAId: string
  let sourcePngBytes: Buffer
  // 簡易 in-memory R2 store(source-asset-finalize.test.ts と同方針): key →
  // bytes。 putObject の ifNoneMatch 意味論を再現する。
  let r2Store: Map<string, Buffer>

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetObject.mockReset()
    mockPutObject.mockReset()

    r2Store = new Map()
    mockGetObject.mockImplementation(async (key: string) => {
      const stored = r2Store.get(key)
      return stored ? { bytes: stored } : null
    })
    mockPutObject.mockImplementation(
      async (key: string, bytes: Buffer, _mime: string, options?: { ifNoneMatch?: boolean }) => {
        if (options?.ifNoneMatch && r2Store.has(key)) {
          return 'precondition_failed'
        }
        r2Store.set(key, Buffer.from(bytes))
        return 'success'
      },
    )

    sourcePngBytes = await sharp({
      create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: { r: 20, g: 120, b: 220 } },
    })
      .png()
      .toBuffer()

    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
    examAId = randomUUID()
    await owner.insert(exams).values({ id: examAId, userId: userAId, name: 'exam A' })
    sourceDocAId = randomUUID()
    await owner.insert(sourceDocuments).values({
      id: sourceDocAId,
      userId: userAId,
      examId: examAId,
      mode: 'new',
      fileType: 'image',
      filename: 'a.png',
      fileSizeBytes: 1000,
      pagesTotal: 1,
    })
  })

  async function seedPreparedOperation(
    userId: string,
    sourceDocumentId: string,
    overrides: Partial<{ status: 'awaiting_sources' | 'claimed' | 'prepared' | 'completed' | 'terminal_failed' }> = {},
  ): Promise<string> {
    const owner = getFixtureOwnerDb()
    const operationId = randomUUID()
    await owner.insert(uploadOperations).values({
      id: operationId,
      userId,
      idempotencyKey: `idem-${operationId}`,
      examId: examAId,
      sourceDocumentId,
      status: overrides.status ?? 'prepared',
      leaseVersion: 1,
      expectedSourceCount: 1,
    })
    return operationId
  }

  async function seedReadySourceAsset(
    userId: string,
    sourceDocumentId: string,
    sourceId: string,
    objectKey: string,
  ): Promise<string> {
    const owner = getFixtureOwnerDb()
    const assetId = randomUUID()
    await owner.insert(sourceAssets).values({
      id: assetId,
      userId,
      sourceDocumentId,
      sourceId,
      objectKey,
      mime: 'image/png',
      contentHash: `hash-${assetId}`,
      byteSize: sourcePngBytes.length,
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      status: 'ready',
      originalFilename: 'a.png',
      readyAt: new Date(),
    })
    return assetId
  }

  it('happy path: writes assets(status=ready) + asset_derivations rows scoped to the caller, values equal to a direct toCropRect(...) call', async () => {
    const sourceObjectKey = `users/${userAId}/src/s1.png`
    r2Store.set(sourceObjectKey, sourcePngBytes)
    const sourceAssetId = await seedReadySourceAsset(userAId, sourceDocAId, 's1', sourceObjectKey)
    const operationId = await seedPreparedOperation(userAId, sourceDocAId)
    const figureAssetId = randomUUID()

    const result = await cropFigureAndStore({
      userId: userAId,
      operationId,
      sourceId: 's1',
      figureAssetId,
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
    })
    expect(result).toEqual({ outcome: 'stored' })

    const owner = getFixtureOwnerDb()
    const assetRows = await owner.select().from(assets).where(eq(assets.id, figureAssetId))
    expect(assetRows).toHaveLength(1)
    const assetRow = assetRows[0]!
    expect(assetRow.userId).toBe(userAId)
    expect(assetRow.status).toBe('ready')
    expect(assetRow.mime).toBe('image/webp')
    expect(assetRow.objectKey).toBe(`users/${userAId}/${figureAssetId}.webp`)
    expect(assetRow.readyAt).not.toBeNull()

    const expectedRect = toCropRect(VALID_BOX2D, SOURCE_WIDTH, SOURCE_HEIGHT)
    expect(expectedRect).not.toBeNull()
    expect(assetRow.width).toBe(expectedRect!.cropW)
    expect(assetRow.height).toBe(expectedRect!.cropH)

    const derivationRows = await owner
      .select()
      .from(assetDerivations)
      .where(eq(assetDerivations.assetId, figureAssetId))
    expect(derivationRows).toHaveLength(1)
    const derivationRow = derivationRows[0]!
    expect(derivationRow.userId).toBe(userAId)
    expect(derivationRow.sourceAssetId).toBe(sourceAssetId)
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

  it('retry with the same figureAssetId is idempotent: second call hits 412+hash-match+ready -> reused, row count unchanged (deterministic id/object-key reproduction)', async () => {
    const sourceObjectKey = `users/${userAId}/src/s1.png`
    r2Store.set(sourceObjectKey, sourcePngBytes)
    await seedReadySourceAsset(userAId, sourceDocAId, 's1', sourceObjectKey)
    const operationId = await seedPreparedOperation(userAId, sourceDocAId)
    const figureAssetId = randomUUID()
    const input = {
      userId: userAId,
      operationId,
      sourceId: 's1',
      figureAssetId,
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
    }

    const first = await cropFigureAndStore(input)
    expect(first).toEqual({ outcome: 'stored' })

    const owner = getFixtureOwnerDb()
    const afterFirst = await owner.select().from(assets).where(eq(assets.id, figureAssetId))
    expect(afterFirst).toHaveLength(1)

    const second = await cropFigureAndStore(input)
    expect(second).toEqual({ outcome: 'reused' })

    const afterSecond = await owner.select().from(assets).where(eq(assets.id, figureAssetId))
    expect(afterSecond).toHaveLength(1) // no duplicate row
    expect(afterSecond[0]!.hash).toBe(afterFirst[0]!.hash)
    const derivationRows = await owner
      .select()
      .from(assetDerivations)
      .where(eq(assetDerivations.assetId, figureAssetId))
    expect(derivationRows).toHaveLength(1) // no duplicate derivation row
  })

  it('tenancy: operation owned by another tenant (userB) is not croppable by userA (owner scope) -> not_prepared, no rows written', async () => {
    const sourceObjectKey = `users/${userBId}/src/s1.png`
    r2Store.set(sourceObjectKey, sourcePngBytes)
    const sourceDocBId = randomUUID()
    const owner = getFixtureOwnerDb()
    await owner.insert(exams).values({ id: randomUUID(), userId: userBId, name: 'exam B' })
    await owner.insert(sourceDocuments).values({
      id: sourceDocBId,
      userId: userBId,
      examId: (await owner.select().from(exams).where(eq(exams.userId, userBId)))[0]!.id,
      mode: 'new',
      fileType: 'image',
      filename: 'b.png',
      fileSizeBytes: 1000,
      pagesTotal: 1,
    })
    await seedReadySourceAsset(userBId, sourceDocBId, 's1', sourceObjectKey)
    const operationBId = await seedPreparedOperation(userBId, sourceDocBId)
    const figureAssetId = randomUUID()

    // userA が userB の operationId を騙って呼ぶ(cross-tenant)。
    const result = await cropFigureAndStore({
      userId: userAId,
      operationId: operationBId,
      sourceId: 's1',
      figureAssetId,
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
    })
    expect(result).toEqual({ outcome: 'not_prepared' })

    const assetRows = await owner.select().from(assets).where(eq(assets.id, figureAssetId))
    expect(assetRows).toHaveLength(0)
    // userB 自身の operation/source は無傷。
    const bOpRows = await owner
      .select()
      .from(uploadOperations)
      .where(eq(uploadOperations.id, operationBId))
    expect(bOpRows[0]?.status).toBe('prepared')
  })

  it("operation status !== 'prepared' (still 'claimed') -> not_prepared, no rows written (RLS-scoped read confirms real DB state, not a stale local guess)", async () => {
    const sourceObjectKey = `users/${userAId}/src/s1.png`
    r2Store.set(sourceObjectKey, sourcePngBytes)
    await seedReadySourceAsset(userAId, sourceDocAId, 's1', sourceObjectKey)
    const operationId = await seedPreparedOperation(userAId, sourceDocAId, { status: 'claimed' })
    const figureAssetId = randomUUID()

    const result = await cropFigureAndStore({
      userId: userAId,
      operationId,
      sourceId: 's1',
      figureAssetId,
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
    })
    expect(result).toEqual({ outcome: 'not_prepared' })

    const owner = getFixtureOwnerDb()
    const assetRows = await owner.select().from(assets).where(eq(assets.id, figureAssetId))
    expect(assetRows).toHaveLength(0)
  })
})
