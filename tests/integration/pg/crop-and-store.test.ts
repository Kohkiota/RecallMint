// ②-4a Task 10 / S-5: cropFigureFromBuffer の実 PG 検証。
//
// R2(getObject/putObject)を mock し(実 R2 を叩かない・CLAUDE.md AI 絶対
// ルール 2 と同根拠)、実 PG 上で **assets + asset_derivations に実際に何が
// 書かれるか**(列レベルで toCropRect の戻り値と一致)と、**同一 figureAssetId の
// 再試行が idempotent**(412 + hash 一致 + ready → reused・行が増えない)ことを
// 検証する。
//
// S-5(旧経路撤去)で削除したもの: operation status='prepared' の guard read と
// 旧 source 台帳の解決に依存していた tenancy / not_prepared の 2 test。どちらも旧
// entry `cropFigureAndStore` 固有の分岐で、対象そのものが消えた(cross-tenant の
// RLS 検証は rls-* iso 群と upload-pipeline.test.ts が引き続き担う)。
//
// 412 分岐の意思決定ロジック自体(hash 一致/不一致・deleting 禁止)は
// lib/media/crop-and-store.test.ts(unit・fake tx)で網羅済み — 本 file は
// 「実 DB に実際に何が書かれるか」に焦点を絞る。sharp は mock しない
// (tiny real buffer 方針)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

import { closeDb } from '@/lib/db'
import { assetDerivations, assets, users } from '@/lib/db/schema'
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
import { cropFigureFromBuffer, CROP_PIPELINE_VERSION } from '@/lib/media/crop-and-store'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// 裏取り(unit test と同じ入力): pad±60 -> [40,40,860,860](clamp 無効)->
// px 化(100x100) -> floor/ceil -> left=4,top=4,cropW=82,cropH=82。
const VALID_BOX2D: Box2d = [100, 100, 800, 800]
const SOURCE_WIDTH = 100
const SOURCE_HEIGHT = 100

describe('cropFigureFromBuffer (T10 / S-5) — 実 PG', () => {
  let userAId: string
  let sourcePngBytes: Buffer
  // 簡易 in-memory R2 store: key → bytes。 putObject の ifNoneMatch 意味論を再現する。
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
    await owner.insert(users).values({ id: userAId, clerkId: `clerk_A_${userAId}` })
  })

  it('happy path: writes assets(status=ready) + asset_derivations rows scoped to the caller, values equal to a direct toCropRect(...) call', async () => {
    const figureAssetId = randomUUID()

    const result = await cropFigureFromBuffer({
      userId: userAId,
      sourceBytes: sourcePngBytes,
      sourceWidth: SOURCE_WIDTH,
      sourceHeight: SOURCE_HEIGHT,
      sourceId: 's1',
      figureAssetId,
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
    })
    expect(result).toEqual({ outcome: 'stored' })
    // 新経路は source を R2 に置かない = GET も `src/` key の PUT も起きない。
    expect(mockGetObject).not.toHaveBeenCalled()

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
    const figureAssetId = randomUUID()
    const input = {
      userId: userAId,
      sourceBytes: sourcePngBytes,
      sourceWidth: SOURCE_WIDTH,
      sourceHeight: SOURCE_HEIGHT,
      sourceId: 's1',
      figureAssetId,
      box2d: VALID_BOX2D,
      detectTarget: 'question_text',
    }

    const first = await cropFigureFromBuffer(input)
    expect(first).toEqual({ outcome: 'stored' })

    const owner = getFixtureOwnerDb()
    const afterFirst = await owner.select().from(assets).where(eq(assets.id, figureAssetId))
    expect(afterFirst).toHaveLength(1)

    const second = await cropFigureFromBuffer(input)
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
})
