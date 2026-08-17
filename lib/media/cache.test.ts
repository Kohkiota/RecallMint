// Cache API blob helper test (画像フェーズ A Task 6)。
// vitest (node environment) には Cache API が無いため、 Map-backed な最小 stub を
// global.caches に注入して unit する (spec §2.4 / brief 制約)。
// 観点: put→match round-trip(同一 bytes) / delete 後 match が undefined /
// userId 名前空間分離(user-1 で put した asset を user-2 で match しても undefined)/
// hasAssetBlob の存在確認(round-trip・未 put・delete 後・namespace 分離・body 非読取)。
// hygiene sprint Task 4: 列挙 / key parse helper(parseMediaCacheKey /
// listMediaCacheRequests / deleteMediaCacheRequest)の観点を追加。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  putAssetBlob,
  matchAssetBlob,
  deleteAssetBlob,
  hasAssetBlob,
  parseMediaCacheKey,
  listMediaCacheRequests,
  deleteMediaCacheRequest,
} from './cache'

// ---------------------------------------------------------------------------
// Map-backed Cache / CacheStorage stub
// ---------------------------------------------------------------------------

// 実 Cache API は相対 key を document base URL で解決し、 keys() は絶対 URL を持つ
// Request を返す。 stub もその挙動に揃える (parseMediaCacheKey は絶対 URL を前提)。
const STUB_ORIGIN = 'https://app.test'

function normalizeKey(key: string | Request): string {
  return typeof key === 'string' ? new URL(key, STUB_ORIGIN).toString() : key.url
}

class FakeCache {
  private store = new Map<string, Response>()

  async put(key: string | Request, response: Response): Promise<void> {
    this.store.set(normalizeKey(key), response)
  }

  async match(key: string | Request): Promise<Response | undefined> {
    return this.store.get(normalizeKey(key))
  }

  async delete(key: string | Request): Promise<boolean> {
    return this.store.delete(normalizeKey(key))
  }

  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => new Request(url))
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

  async has(name: string): Promise<boolean> {
    return this.caches.has(name)
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

  // -------------------------------------------------------------------------
  // hygiene sprint Task 4: 列挙 / key parse helper
  // -------------------------------------------------------------------------

  describe('parseMediaCacheKey', () => {
    it('putAssetBlob が書いた key を listMediaCacheRequests 経由で parse すると owner / asset に戻る (cacheKey との round-trip)', async () => {
      await putAssetBlob('user-1', 'asset-1', new Blob(['x'], { type: 'image/webp' }))

      const requests = await listMediaCacheRequests()

      expect(requests).toHaveLength(1)
      expect(parseMediaCacheKey(requests[0].url)).toEqual({
        userId: 'user-1',
        assetId: 'asset-1',
      })
    })

    it('query 付き key は null (厳密規則: query なし)', () => {
      expect(
        parseMediaCacheKey('https://app.test/__media/user-1/asset-1?v=2'),
      ).toBeNull()
    })

    it('segment 数が 3 でない key は null (2 segment / 4 segment)', () => {
      expect(parseMediaCacheKey('https://app.test/__media/user-1')).toBeNull()
      expect(
        parseMediaCacheKey('https://app.test/__media/user-1/asset-1/extra'),
      ).toBeNull()
    })

    it('prefix が __media でない key は null', () => {
      expect(
        parseMediaCacheKey('https://app.test/other/user-1/asset-1'),
      ).toBeNull()
    })

    it('空 segment を含む key は null', () => {
      expect(parseMediaCacheKey('https://app.test/__media//asset-1')).toBeNull()
      expect(parseMediaCacheKey('https://app.test/__media/user-1/')).toBeNull()
    })

    it('URL として parse できない文字列は null', () => {
      expect(parseMediaCacheKey('not-a-url')).toBeNull()
      expect(parseMediaCacheKey('')).toBeNull()
    })
  })

  describe('listMediaCacheRequests', () => {
    it('cache 内の全 key を Request として返す', async () => {
      await putAssetBlob('user-1', 'asset-1', new Blob(['a']))
      await putAssetBlob('user-2', 'asset-2', new Blob(['b']))

      const urls = (await listMediaCacheRequests()).map((r) => r.url).sort()

      expect(urls).toEqual([
        'https://app.test/__media/user-1/asset-1',
        'https://app.test/__media/user-2/asset-2',
      ])
    })

    it('cache 不在なら [] を返し、 cache を新規作成しない', async () => {
      const openSpy = vi.spyOn(globalThis.caches, 'open')

      const requests = await listMediaCacheRequests()

      expect(requests).toEqual([])
      expect(openSpy).not.toHaveBeenCalled()
      expect(await globalThis.caches.has('recallmint-media')).toBe(false)
      openSpy.mockRestore()
    })

    it('caches 自体が無い環境では [] を返す', async () => {
      globalThis.caches = undefined as unknown as CacheStorage

      expect(await listMediaCacheRequests()).toEqual([])
    })
  })

  describe('deleteMediaCacheRequest', () => {
    it('列挙した Request をそのまま渡すと該当 entry が消える', async () => {
      await putAssetBlob('user-1', 'asset-1', new Blob(['a']))
      await putAssetBlob('user-1', 'asset-2', new Blob(['b']))

      const requests = await listMediaCacheRequests()
      const target = requests.find((r) => r.url.endsWith('asset-1'))
      await deleteMediaCacheRequest(target as Request)

      expect(await hasAssetBlob('user-1', 'asset-1')).toBe(false)
      expect(await hasAssetBlob('user-1', 'asset-2')).toBe(true)
    })
  })
})
