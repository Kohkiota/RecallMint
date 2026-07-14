// reclaimLocalAssetBlobs の unit test(spec §4.7 / W3 brief)。
// ローカルの「消えうるキャッシュ」(Cache blob + Dexie media_assets 行)を best-effort で
// 掃除する共有 helper。 観点: 複数 assetId で deleteAssetBlob + media_assets.delete が
// 各々呼ばれる / 1 件が reject しても他が実行される(best-effort)/ 空配列 no-op。
//
// deleteAssetBlob(@/lib/media/cache)/ getClientDb().media_assets(@/lib/client-db)は
// spy mock(実 Cache API / Dexie は不要 — helper は薄い glue のため)。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDeleteAssetBlob, mockMediaAssetsDelete } = vi.hoisted(() => ({
  mockDeleteAssetBlob: vi.fn(async () => undefined),
  mockMediaAssetsDelete: vi.fn(async () => undefined),
}))

vi.mock('@/lib/media/cache', () => ({
  deleteAssetBlob: mockDeleteAssetBlob,
}))
vi.mock('@/lib/client-db', () => ({
  getClientDb: () => ({
    media_assets: { delete: mockMediaAssetsDelete },
  }),
}))

import { reclaimLocalAssetBlobs } from './reclaim-local-asset-blobs'

const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reclaimLocalAssetBlobs', () => {
  it('各 assetId につき deleteAssetBlob + media_assets.delete が呼ばれる', async () => {
    await reclaimLocalAssetBlobs(USER_ID, ['asset-1', 'asset-2'])

    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'asset-1')
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'asset-2')
    expect(mockMediaAssetsDelete).toHaveBeenCalledWith('asset-1')
    expect(mockMediaAssetsDelete).toHaveBeenCalledWith('asset-2')
  })

  it('1 件の deleteAssetBlob が reject しても他の assetId の掃除は実行される(best-effort)', async () => {
    mockDeleteAssetBlob.mockImplementationOnce(async () => {
      throw new Error('cache boom')
    })

    await expect(
      reclaimLocalAssetBlobs(USER_ID, ['asset-fail', 'asset-ok']),
    ).resolves.toBeUndefined()

    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'asset-fail')
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'asset-ok')
    // reject した asset-fail でも media_assets.delete は呼ばれる(独立 best-effort)。
    expect(mockMediaAssetsDelete).toHaveBeenCalledWith('asset-fail')
    expect(mockMediaAssetsDelete).toHaveBeenCalledWith('asset-ok')
  })

  it('1 件の media_assets.delete が reject しても他の assetId の掃除は実行される(best-effort)', async () => {
    mockMediaAssetsDelete.mockImplementationOnce(async () => {
      throw new Error('dexie boom')
    })

    await expect(
      reclaimLocalAssetBlobs(USER_ID, ['asset-fail', 'asset-ok']),
    ).resolves.toBeUndefined()

    expect(mockMediaAssetsDelete).toHaveBeenCalledWith('asset-fail')
    expect(mockMediaAssetsDelete).toHaveBeenCalledWith('asset-ok')
  })

  it('空配列は no-op(deleteAssetBlob / media_assets.delete を呼ばない)', async () => {
    await reclaimLocalAssetBlobs(USER_ID, [])

    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
    expect(mockMediaAssetsDelete).not.toHaveBeenCalled()
  })
})
