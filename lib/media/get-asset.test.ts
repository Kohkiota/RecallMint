// getAssetObjectURL test (画像フェーズ A Task 9 / spec §6)。
//
// Cache API は vitest (node) に無いため Map-backed stub を global.caches に注入する
// (cache.test.ts と同 pattern)。 URL.createObjectURL / resolveAssetUrls (DI) は mock。
//
// objectUrlCache は module-level Map (asset は immutable ゆえ evict しない設計)。
// test 間で state を共有してしまうため、 各 test は distinct assetId を使って
// 独立性を保つ (module reset せず、 get-asset.ts の実装どおりの永続 Map を前提にする)。
//
// 観点: cache hit → resolve/fetch を叩かず objectURL / miss→resolve+fetch+put→objectURL /
// resolve !ok → null / fetch !ok / throw → null / objectURL 再利用 (2nd call は
// resolve を再度呼ばない) / userId 名前空間分離。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getAssetObjectURL } from './get-asset'
import { putAssetBlob } from './cache'

// ---------------------------------------------------------------------------
// Map-backed Cache / CacheStorage stub (cache.test.ts と同型)
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

const USER_ID = 'user-1'
const RESOLVED_URL = 'https://r2.example/get/presigned'

// 各 test が distinct assetId を使うための採番 (module-level objectUrlCache が
// test 間で永続するため、 id 共有による cross-test 汚染を避ける)。
let assetIdCounter = 0
function freshAssetId(): string {
  return `asset-${++assetIdCounter}`
}

function okResolve(
  assetId: string,
  overrides?: Partial<{ url: string; mime: string; width: number; height: number }>,
) {
  return {
    ok: true as const,
    data: [
      {
        assetId,
        url: RESOLVED_URL,
        mime: 'image/webp',
        width: 800,
        height: 600,
        ...overrides,
      },
    ],
  }
}

let mockObjectUrlCounter = 0

beforeEach(() => {
  originalCaches = globalThis.caches
  globalThis.caches = new FakeCacheStorage() as unknown as CacheStorage

  mockObjectUrlCounter = 0
  ;(globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(
    () => `blob:mock-${++mockObjectUrlCounter}`,
  )
})

afterEach(() => {
  globalThis.caches = originalCaches as CacheStorage
  vi.restoreAllMocks()
})

describe('getAssetObjectURL', () => {
  it('Cache hit → resolve/fetch を呼ばず objectURL を返す', async () => {
    const assetId = freshAssetId()
    const blob = new Blob(['bytes'], { type: 'image/webp' })
    await putAssetBlob(USER_ID, assetId, blob)

    const mockResolve = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBe('blob:mock-1')
    expect(mockResolve).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('miss → resolve → fetch → Cache put → objectURL', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue(okResolve(assetId))
    const responseBlob = new Blob(['fetched-bytes'], { type: 'image/webp' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(responseBlob, { status: 200 }),
    )

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBe('blob:mock-1')
    expect(mockResolve).toHaveBeenCalledWith([assetId])
    expect(globalThis.fetch).toHaveBeenCalledWith(
      RESOLVED_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    // Cache に put されている。
    const cache = await caches.open('recallmint-media')
    const cached = await cache.match(`/__media/${USER_ID}/${assetId}`)
    expect(cached).toBeDefined()
  })

  it('resolve ok:false → null', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue({ ok: false, error: 'unauth' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolve ok:true だが空配列 → null', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue({ ok: true, data: [] })

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBeNull()
  })

  it('fetch !ok → null', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue(okResolve(assetId))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    )

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBeNull()
  })

  it('fetch throw (network) → null', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue(okResolve(assetId))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBeNull()
  })

  it('resolve が reject (throw) → null (saga 外に throw を漏らさない)', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockRejectedValue(new Error('transport failed'))

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBeNull()
  })

  it('初回 Cache read が reject (storage 不能) → null (throw を漏らさない)', async () => {
    const assetId = freshAssetId()
    // caches.open を reject させ、 初回 matchAssetBlob (cache read) を throw させる。
    globalThis.caches = {
      open: () => Promise.reject(new Error('cache storage unavailable')),
    } as unknown as CacheStorage
    const mockResolve = vi.fn()

    const url = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(url).toBeNull()
    // 初回 cache read で落ちるため resolve には進まない。
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('objectURL 再利用: 2 回目呼び出しは同一 URL を返し resolve を再度呼ばない', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue(okResolve(assetId))
    const responseBlob = new Blob(['fetched-bytes'], { type: 'image/webp' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(responseBlob, { status: 200 }),
    )

    const first = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })
    const second = await getAssetObjectURL(USER_ID, assetId, {
      resolveAssetUrls: mockResolve,
    })

    expect(first).toBe(second)
    expect(mockResolve).toHaveBeenCalledTimes(1)
    // createObjectURL も 1 回のみ (module Map から再利用)。
    expect(
      (globalThis.URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(1)
  })

  it('userId 名前空間: user-1 の objectURL cache は user-2 の同一 assetId に再利用されない (別 fetch が走る)', async () => {
    const assetId = freshAssetId()
    const mockResolve = vi.fn().mockResolvedValue(okResolve(assetId))
    const responseBlob = new Blob(['fetched-bytes'], { type: 'image/webp' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(responseBlob, { status: 200 }),
    )

    await getAssetObjectURL(USER_ID, assetId, { resolveAssetUrls: mockResolve })
    await getAssetObjectURL('user-2', assetId, { resolveAssetUrls: mockResolve })

    // 別 user は別 cache key ゆえ resolve が 2 回呼ばれる (module Map が user 名前空間分離)。
    expect(mockResolve).toHaveBeenCalledTimes(2)
  })
})
