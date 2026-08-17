// Cache API blob helper test (画像フェーズ A Task 6)。
// vitest (node environment) には Cache API が無いため、 Map-backed な最小 stub を
// global.caches に注入して unit する (spec §2.4 / brief 制約)。
// 観点: put→match round-trip(同一 bytes) / delete 後 match が undefined /
// userId 名前空間分離(user-1 で put した asset を user-2 で match しても undefined)/
// hasAssetBlob の存在確認(round-trip・未 put・delete 後・namespace 分離・body 非読取)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { putAssetBlob, matchAssetBlob, deleteAssetBlob, hasAssetBlob } from './cache'

// ---------------------------------------------------------------------------
// Map-backed Cache / CacheStorage stub
// ---------------------------------------------------------------------------

class FakeCache {
  private store = new Map<string, Response>()

  async put(key: string, response: Response): Promise<void> {
    this.store.set(key, response)
  }

  async match(key: string): Promise<Response | undefined> {
    return this.store.get(key)
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }
}

class FakeCacheStorage {
  private caches = new Map<string, FakeCache>()

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name)
    if (!cache) {
      cache = new FakeCache()
      this.caches.set(name, cache)
    }
    return cache
  }
}

let originalCaches: typeof globalThis.caches | undefined

beforeEach(() => {
  originalCaches = globalThis.caches
  // Cache API 型は package 全体で 1 個の CacheStorage を要求するが unit stub は
  // 最小実装のみ供給するため as unknown 経由でキャストする。
  globalThis.caches = new FakeCacheStorage() as unknown as CacheStorage
})

afterEach(() => {
  globalThis.caches = originalCaches as CacheStorage
})

describe('media/cache', () => {
  it('putAssetBlob → matchAssetBlob が同一 bytes を round-trip する', async () => {
    const blob = new Blob(['hello world'], { type: 'image/webp' })

    await putAssetBlob('user-1', 'asset-1', blob)
    const matched = await matchAssetBlob('user-1', 'asset-1')

    expect(matched).toBeDefined()
    expect(await matched?.text()).toBe('hello world')
    expect(matched?.type).toBe('image/webp')
  })

  it('matchAssetBlob は未 put の asset に対し undefined を返す', async () => {
    const matched = await matchAssetBlob('user-1', 'unknown-asset')
    expect(matched).toBeUndefined()
  })

  it('deleteAssetBlob 後は matchAssetBlob が undefined を返す', async () => {
    const blob = new Blob(['bytes'], { type: 'image/png' })
    await putAssetBlob('user-1', 'asset-2', blob)

    await deleteAssetBlob('user-1', 'asset-2')
    const matched = await matchAssetBlob('user-1', 'asset-2')

    expect(matched).toBeUndefined()
  })

  it('userId 名前空間: user-1 で put した asset を user-2 で match すると undefined (key 衝突なし)', async () => {
    const blob = new Blob(['secret'], { type: 'image/webp' })
    await putAssetBlob('user-1', 'asset-shared-id', blob)

    const matchedByOtherUser = await matchAssetBlob(
      'user-2',
      'asset-shared-id',
    )

    expect(matchedByOtherUser).toBeUndefined()
  })

  describe('hasAssetBlob', () => {
    it('put 済みの asset に対し true を返す', async () => {
      await putAssetBlob('user-1', 'asset-4', new Blob(['x'], { type: 'image/webp' }))

      expect(await hasAssetBlob('user-1', 'asset-4')).toBe(true)
    })

    it('未 put の asset に対し false を返す', async () => {
      expect(await hasAssetBlob('user-1', 'unknown-asset')).toBe(false)
    })

    it('deleteAssetBlob 後は false を返す', async () => {
      await putAssetBlob('user-1', 'asset-5', new Blob(['y'], { type: 'image/png' }))
      await deleteAssetBlob('user-1', 'asset-5')

      expect(await hasAssetBlob('user-1', 'asset-5')).toBe(false)
    })

    it('userId 名前空間: user-1 で put した asset は user-2 から false', async () => {
      await putAssetBlob('user-1', 'asset-shared-id-2', new Blob(['z'], { type: 'image/webp' }))

      expect(await hasAssetBlob('user-2', 'asset-shared-id-2')).toBe(false)
    })

    it('blob 本体を読まない (後続 matchAssetBlob が body を読める — FakeCache は同一 Response instance を返すため body 消費があれば検出できる)', async () => {
      await putAssetBlob('user-1', 'asset-6', new Blob(['body-untouched'], { type: 'image/webp' }))

      const exists = await hasAssetBlob('user-1', 'asset-6')
      expect(exists).toBe(true)

      const matched = await matchAssetBlob('user-1', 'asset-6')
      expect(await matched?.text()).toBe('body-untouched')
    })
  })
})
