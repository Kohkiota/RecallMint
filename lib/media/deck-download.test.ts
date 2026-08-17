// downloadDeckImages test (画像フェーズ A Task 12 / spec §6)。
//
// getClientDb() は fake-indexeddb 経由の実 Dexie (vitest.setup.ts が auto shim)。
// Cache API は Map-backed stub (cache.test.ts と同型) を global.caches に注入して
// put/match/delete を round-trip 検証する (blob 本体は実 Cache stub に置く)。
// resolveAssetUrls / fetch / navigator.storage.persist は mock。
//
// 観点:
// - miss-only: 既に Cache 済みの key は skip、 miss 分のみ DL (差分 DL)。
// - happy path: job 作成 → added_asset_ids へ記録 → 全 fetch+put → status 'done' /
//   {ok:true}。
// - all-or-nothing: mid-batch fetch 失敗 → added_asset_ids 全 blob 削除 + job row
//   削除 + 既存 pre-cached blob は不変 + {ok:false}。
// - record-before-put 順序: put が失敗しても added_asset_ids は当該 id を含む (superset)。
// - persist() best-effort: reject でも DL は続行。
// - lock-busy: 他タブ DL 中 → no-op ({ok:false})。
// - 非配列 card.images はガード (crash しない)。
// - DL success gate (spec §4.2・r3/r4): cleanup (後続 sprint) との交差を模し、 hasAssetBlob
//   の返り値だけを選択的に差し替えて「gate 直前に blob が消えた」を決定的に再現する
//   (matchAssetBlob は実 cache を見るため preflight の hit/miss 判定はそのまま)。 早期出口
//   ①(全件 hit)/ DL 本体経路の hit 分②・added 分③ を個別に検証する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ClientCardImage } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// Map-backed Cache / CacheStorage stub (cache.test.ts と同型)
// ---------------------------------------------------------------------------

// blob bytes を保持し match ごとに fresh Response を返す (実 Cache API 同様、 body は
// 1 回しか読めないため clone せずに毎回新しい Response を生成する)。
class FakeCache {
  store = new Map<string, Blob>()
  async put(key: string, response: Response): Promise<void> {
    this.store.set(key, await response.blob())
  }
  async match(key: string): Promise<Response | undefined> {
    const blob = this.store.get(key)
    return blob ? new Response(blob) : undefined
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>()
  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name)
    if (!cache) {
      cache = new FakeCache()
      this.caches.set(name, cache)
    }
    return cache
  }
}

// cache module は実装 (real Cache stub round-trip) を使いつつ、 put/delete を spy 可能に
// する。 importOriginal で実 put/match/delete を保持し、 spy でラップ (record-order test で
// putAssetBlob を一時的に失敗させるため)。
type PutFn = (userId: string, assetId: string, blob: Blob) => Promise<void>
type DelFn = (userId: string, assetId: string) => Promise<void>
type HasFn = (userId: string, assetId: string) => Promise<boolean>

const { spies } = vi.hoisted(() => ({
  spies: {
    put: vi.fn<PutFn>(),
    del: vi.fn<DelFn>(),
    has: vi.fn<HasFn>(),
  },
}))

vi.mock('@/lib/media/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/cache')>()
  spies.put.mockImplementation(actual.putAssetBlob)
  spies.del.mockImplementation(actual.deleteAssetBlob)
  spies.has.mockImplementation(actual.hasAssetBlob)
  return {
    ...actual,
    putAssetBlob: (u: string, a: string, b: Blob) => spies.put(u, a, b),
    deleteAssetBlob: (u: string, a: string) => spies.del(u, a),
    hasAssetBlob: (u: string, a: string) => spies.has(u, a),
  }
})

import { downloadDeckImages } from '@/lib/media/deck-download'
import { getClientDb } from '@/lib/client-db'
import { putAssetBlob, matchAssetBlob } from '@/lib/media/cache'

const USER_ID = 'user-1'
const EXAM_ID = 'exam-1'

// UUIDv4 key (isAssetKey で通る)。 legacy 非 UUID key は DL 対象外の想定。
const KEY_A = '11111111-1111-4111-8111-111111111111'
const KEY_B = '22222222-2222-4222-8222-222222222222'
const KEY_C = '33333333-3333-4333-8333-333333333333'
const LEGACY_KEY = 'ocr-legacy-key-not-uuid'

let originalCaches: typeof globalThis.caches | undefined
let originalPersist: (() => Promise<boolean>) | undefined
let mockPersist: ReturnType<typeof vi.fn<() => Promise<boolean>>>
let mockFetch: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>
// gate test が「特定 key だけ hasAssetBlob を false に差し替え、 他 key は実装へ委譲する」
// 選択的 override を書くための実装参照 (beforeEach で再取得)。
let cacheActual: typeof import('@/lib/media/cache')

// navigator.storage.persist を差し替える (存在しない環境で define する)。
function installStoragePersist(fn: () => Promise<boolean>) {
  const nav = globalThis.navigator as unknown as {
    storage?: { persist?: () => Promise<boolean> }
  }
  if (!nav.storage) {
    Object.defineProperty(nav, 'storage', {
      value: { persist: fn },
      configurable: true,
      writable: true,
    })
  } else {
    nav.storage.persist = fn
  }
}

function seedCard(id: string, images: ClientCardImage[]): Promise<unknown> {
  return getClientDb().cards.put({
    id,
    user_id: USER_ID,
    exam_id: EXAM_ID,
    question_text: 'q',
    options: [],
    correct_answer_ids: [],
    images,
    answered: false,
    current_streak: 0,
    due: '0',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    created_at: '2026-07-12T00:00:00.000Z',
    updated_at: '2026-07-12T00:00:00.000Z',
    sync_status: 'synced',
  } as never)
}

function img(key: string): ClientCardImage {
  return { key, target: 'question_text', alt: '' }
}

beforeEach(async () => {
  vi.clearAllMocks()

  // clearAllMocks は cache spy の実装も消すため、 実 put/delete/has を再注入する
  // (round-trip test は実 Cache stub の書込/削除に依存する)。
  cacheActual =
    await vi.importActual<typeof import('@/lib/media/cache')>('@/lib/media/cache')
  spies.put.mockImplementation(cacheActual.putAssetBlob)
  spies.del.mockImplementation(cacheActual.deleteAssetBlob)
  spies.has.mockImplementation(cacheActual.hasAssetBlob)

  originalCaches = globalThis.caches
  globalThis.caches = new FakeCacheStorage() as unknown as CacheStorage

  const nav = globalThis.navigator as unknown as {
    storage?: { persist?: () => Promise<boolean> }
  }
  originalPersist = nav.storage?.persist
  mockPersist = vi.fn(async () => true)
  installStoragePersist(mockPersist)

  mockFetch = vi.fn(async (url: string) => {
    return new Response(new Blob([`bytes-for-${url}`], { type: 'image/webp' }), {
      status: 200,
    })
  })
  vi.stubGlobal('fetch', mockFetch)

  const db = getClientDb()
  await Promise.all([db.cards.clear(), db.media_download_jobs.clear()])
})

afterEach(async () => {
  globalThis.caches = originalCaches as CacheStorage
  const nav = globalThis.navigator as unknown as {
    storage?: { persist?: () => Promise<boolean> }
  }
  if (nav.storage) nav.storage.persist = originalPersist
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// url は assetId をそのまま埋め込む単純 mapping (mockFetch で bytes を区別できる)。
function makeResolve(ids: string[]) {
  return vi.fn(async (assetIds: string[]) => ({
    ok: true as const,
    data: assetIds
      .filter((id) => ids.includes(id))
      .map((id) => ({
        assetId: id,
        url: `https://r2.example/${id}`,
        mime: 'image/webp',
        width: 10,
        height: 10,
      })),
  }))
}

describe('downloadDeckImages — miss-only 差分 DL', () => {
  it('既に Cache 済みの key は skip し miss 分のみ DL する', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    // KEY_A は事前に Cache 済み → resolve/fetch されない。
    await putAssetBlob(USER_ID, KEY_A, new Blob(['cached'], { type: 'image/webp' }))

    const resolveAssetUrls = makeResolve([KEY_B])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result).toEqual({ ok: true, total: 2, downloaded: 1 })
    // resolve は miss (KEY_B) のみ渡される。
    expect(resolveAssetUrls).toHaveBeenCalledTimes(1)
    expect(resolveAssetUrls.mock.calls[0][0]).toEqual([KEY_B])
    // KEY_A の cached blob は保全され、 KEY_B が新規に put される。
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeDefined()
    expect(await matchAssetBlob(USER_ID, KEY_B)).toBeDefined()
  })

  it('全 key が Cache 済みなら resolve せず {ok:true, downloaded:0} (job row も作らない)', async () => {
    await seedCard('c1', [img(KEY_A)])
    await putAssetBlob(USER_ID, KEY_A, new Blob(['cached'], { type: 'image/webp' }))

    const resolveAssetUrls = makeResolve([])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result).toEqual({ ok: true, total: 1, downloaded: 0 })
    expect(resolveAssetUrls).not.toHaveBeenCalled()
    // job row は作られない。
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('legacy 非 UUID key は DL 対象から除外する', async () => {
    await seedCard('c1', [img(LEGACY_KEY), img(KEY_A)])

    const resolveAssetUrls = makeResolve([KEY_A])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    // LEGACY_KEY は total にも含めない (UUID key のみ集計)。
    expect(result).toEqual({ ok: true, total: 1, downloaded: 1 })
    expect(resolveAssetUrls.mock.calls[0][0]).toEqual([KEY_A])
  })

  it('複数 card 間で重複する key は dedupe する', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    await seedCard('c2', [img(KEY_A)]) // KEY_A が重複

    const resolveAssetUrls = makeResolve([KEY_A, KEY_B])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.total).toBe(2)
    expect(result.downloaded).toBe(2)
    const requested = resolveAssetUrls.mock.calls[0][0]
    expect(new Set(requested)).toEqual(new Set([KEY_A, KEY_B]))
    expect(requested.length).toBe(2)
  })
})

describe('downloadDeckImages — happy path', () => {
  it('job 作成 → 全 fetch+put → status done / {ok:true}', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B), img(KEY_C)])

    const resolveAssetUrls = makeResolve([KEY_A, KEY_B, KEY_C])
    const progress: Array<[number, number]> = []
    const result = await downloadDeckImages(
      USER_ID,
      EXAM_ID,
      { resolveAssetUrls },
      { onProgress: (done, total) => progress.push([done, total]) },
    )

    expect(result).toEqual({ ok: true, total: 3, downloaded: 3 })

    const job = await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])
    expect(job).toBeDefined()
    expect(job?.status).toBe('done')
    expect(job?.total).toBe(3)
    expect(job?.done_count).toBe(3)
    expect(new Set(job?.added_asset_ids)).toEqual(new Set([KEY_A, KEY_B, KEY_C]))

    // 全 blob が Cache に入る。
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeDefined()
    expect(await matchAssetBlob(USER_ID, KEY_B)).toBeDefined()
    expect(await matchAssetBlob(USER_ID, KEY_C)).toBeDefined()

    // onProgress が (n, total) で done ごとに呼ばれる。
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it('DL 開始時に navigator.storage.persist() を呼ぶ', async () => {
    await seedCard('c1', [img(KEY_A)])
    const resolveAssetUrls = makeResolve([KEY_A])

    await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(mockPersist).toHaveBeenCalledTimes(1)
  })

  it('persist() が reject しても DL は続行する (best-effort)', async () => {
    mockPersist.mockRejectedValueOnce(new Error('denied'))
    await seedCard('c1', [img(KEY_A)])
    const resolveAssetUrls = makeResolve([KEY_A])

    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result).toEqual({ ok: true, total: 1, downloaded: 1 })
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeDefined()
  })
})

describe('downloadDeckImages — all-or-nothing rollback', () => {
  it('mid-batch fetch 失敗 → added blob 全削除 + job row 削除 + pre-cached blob 不変 + {ok:false}', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B), img(KEY_C)])
    // KEY_C は事前 Cache 済み (miss ではない = added_asset_ids に入らない、 rollback で消えない)。
    await putAssetBlob(USER_ID, KEY_C, new Blob(['pre-cached'], { type: 'image/webp' }))

    const resolveAssetUrls = makeResolve([KEY_A, KEY_B])
    // KEY_A は成功、 KEY_B の fetch で失敗させる。
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes(KEY_B)) return new Response(null, { status: 500 })
      return new Response(new Blob([`ok-${url}`], { type: 'image/webp' }), {
        status: 200,
      })
    })

    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    expect(result.total).toBe(3) // total = デッキ全体 (KEY_A/B/C)
    expect(result.downloaded).toBe(1) // KEY_A まで成功していた (miss 2 件中 1 件)

    // rollback: added 分 (KEY_A) は Cache から消える。
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeUndefined()
    // pre-cached (KEY_C) は added_asset_ids に無いので保全される。
    expect(await matchAssetBlob(USER_ID, KEY_C)).toBeDefined()
    // job row は削除される (再開なし)。
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('resolve が {ok:false} → 何も put せず {ok:false} + job row 削除', async () => {
    await seedCard('c1', [img(KEY_A)])
    const resolveAssetUrls = vi.fn(async () => ({ ok: false as const, error: 'boom' }))

    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeUndefined()
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('resolve が一部 id を省いた (欠損) → 失敗扱いで rollback', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    // KEY_B を省いて返す resolve。
    const resolveAssetUrls = makeResolve([KEY_A])

    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    // KEY_A は put されていたかもしれないが rollback で消える。
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeUndefined()
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('pre-flight (cache 読取) が throw → 例外を漏らさず {ok:false} に正規化 (never-throw 契約)', async () => {
    await seedCard('c1', [img(KEY_A)])
    // matchAssetBlob 内の caches.open を reject させ、 job 作成前の pre-flight で throw させる。
    globalThis.caches = {
      open: () => Promise.reject(new Error('cache unavailable')),
    } as unknown as CacheStorage

    const resolveAssetUrls = makeResolve([KEY_A])
    // throw せず {ok:false} を返す (呼出側に例外を漏らさない)。
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    // pre-flight で失敗 → resolve も put もされず、 job row も作られない。
    expect(resolveAssetUrls).not.toHaveBeenCalled()
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('最終 done 化 update が失敗 → rollback (added blob 全削除 + job row 削除 + {ok:false})', async () => {
    // 全 blob が cache 済みの状態で最終 status:done update だけが失敗するケース。 この
    // update が try 外だと throw が escape し job が downloading のまま残り、 後続 sweep が
    // cache 済みデッキを消しかねない (Codex 指摘)。 try 内へ移し rollback で正規化する。
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    const resolveAssetUrls = makeResolve([KEY_A, KEY_B])

    const db = getClientDb()
    const originalUpdate = db.media_download_jobs.update.bind(db.media_download_jobs)
    const updateSpy = vi
      .spyOn(db.media_download_jobs, 'update')
      .mockImplementation((key: unknown, changes: unknown) => {
        // status:'done' への最終 update だけ失敗させる (それ以前の記録系 update は通す)。
        if ((changes as { status?: string }).status === 'done') {
          return Promise.reject(new Error('done update failed')) as never
        }
        return originalUpdate(key as never, changes as never)
      })

    try {
      const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

      expect(result.ok).toBe(false)
      // 一度は全 blob が cache されたが、 done 化失敗 → rollback で added 分を全削除。
      expect(await matchAssetBlob(USER_ID, KEY_A)).toBeUndefined()
      expect(await matchAssetBlob(USER_ID, KEY_B)).toBeUndefined()
      // job row も消える (downloading のまま残さない = sweep 誤削除の起点を作らない)。
      expect(await db.media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
    } finally {
      updateSpy.mockRestore()
    }
  })
})

describe('downloadDeckImages — record-before-put 順序 (crash superset)', () => {
  it('put が失敗しても added_asset_ids は当該 id を含む (added ⊇ cached)', async () => {
    await seedCard('c1', [img(KEY_A)])
    const resolveAssetUrls = makeResolve([KEY_A])

    // put をこの test の間だけ失敗させる。 rollback で job row は消えるため、
    // 「added に記録された」ことは rollback 前に deleteAssetBlob が KEY_A を対象に
    // 呼ばれる (= added に居た) ことで確認する。 記録が put より前に行われるため、
    // put が失敗しても KEY_A は added_asset_ids に載っており rollback の掃除対象になる。
    spies.put.mockRejectedValueOnce(new Error('put failed'))

    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    // added_asset_ids ⊇ 実 cache の crash-consistency 保証: put 失敗でも rollback が掃除する。
    expect(spies.del).toHaveBeenCalledWith(USER_ID, KEY_A)
  })
})

describe('downloadDeckImages — lock busy', () => {
  it('他タブが同 exam の DL 中 (lock busy) → no-op ({ok:false})', async () => {
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    // ifAvailable=true で null lock を返す = busy。
    const requestSpy = vi.fn(
      (_name: string, _options: unknown, cb: (lock: unknown) => Promise<unknown>) =>
        cb(null),
    )
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        locks: { request: requestSpy },
        storage: { persist: mockPersist },
      },
      configurable: true,
      writable: true,
    })

    try {
      await seedCard('c1', [img(KEY_A)])
      const resolveAssetUrls = makeResolve([KEY_A])

      const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

      expect(result).toEqual({ ok: false, total: 0, downloaded: 0, reason: 'busy' })
      expect(resolveAssetUrls).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      })
    }
  })
})

describe('downloadDeckImages — 非配列 images ガード', () => {
  it('card.images が非配列でも crash しない (Array.isArray guard)', async () => {
    await seedCard('c1', undefined as unknown as ClientCardImage[])
    await seedCard('c2', [img(KEY_A)])

    const resolveAssetUrls = makeResolve([KEY_A])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    // 非配列 card は skip し、 正常 card の KEY_A のみ DL。
    expect(result).toEqual({ ok: true, total: 1, downloaded: 1 })
  })
})

describe('downloadDeckImages — DL success gate (cleanup 交差 / spec §4.2)', () => {
  it('① 全件 preflight hit → 検証前に blob 1 件削除 → {ok:false}・job row 未生成', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    await putAssetBlob(USER_ID, KEY_A, new Blob(['a'], { type: 'image/webp' }))
    await putAssetBlob(USER_ID, KEY_B, new Blob(['b'], { type: 'image/webp' }))

    // gate (hasAssetBlob) だけ KEY_B を「欠け」として観測させる (cleanup が検証直前に
    // 削除したことを模す)。 preflight (matchAssetBlob) は実 cache を見るため hit のまま
    // (misses.length === 0 = 早期出口を通る)。
    spies.has.mockImplementation(async (userId: string, assetId: string) => {
      if (assetId === KEY_B) return false
      return cacheActual.hasAssetBlob(userId, assetId)
    })

    const resolveAssetUrls = makeResolve([])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result).toEqual({ ok: false, total: 2, downloaded: 0 })
    // 早期出口 gate は job 未生成のため rollback を呼ばない — resolve も呼ばれない。
    expect(resolveAssetUrls).not.toHaveBeenCalled()
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('② mixed hit/miss → hit 分 blob 1 件削除 → rollback (added blob + job row 消滅) + {ok:false}', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    // KEY_A は事前 Cache 済み (hit 分、 本 DL では触らない)。 KEY_B は miss (DL 対象)。
    await putAssetBlob(USER_ID, KEY_A, new Blob(['a'], { type: 'image/webp' }))

    // gate だけ KEY_A (hit 分) を「欠け」として観測させる。
    spies.has.mockImplementation(async (userId: string, assetId: string) => {
      if (assetId === KEY_A) return false
      return cacheActual.hasAssetBlob(userId, assetId)
    })

    const resolveAssetUrls = makeResolve([KEY_B])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    // DL 本体経路を通った証拠 (早期出口ではない)。
    expect(resolveAssetUrls).toHaveBeenCalledTimes(1)
    // rollback: added 分 (KEY_B) は Cache から削除される。
    expect(await matchAssetBlob(USER_ID, KEY_B)).toBeUndefined()
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
  })

  it('③ mixed hit/miss → added 分 blob 1 件削除 → rollback (added blob + job row 消滅) + {ok:false}', async () => {
    await seedCard('c1', [img(KEY_A), img(KEY_B)])
    await putAssetBlob(USER_ID, KEY_A, new Blob(['a'], { type: 'image/webp' })) // hit 分

    // gate だけ KEY_B (added 分・本 DL で新規 put) を「欠け」として観測させる。
    spies.has.mockImplementation(async (userId: string, assetId: string) => {
      if (assetId === KEY_B) return false
      return cacheActual.hasAssetBlob(userId, assetId)
    })

    const resolveAssetUrls = makeResolve([KEY_B])
    const result = await downloadDeckImages(USER_ID, EXAM_ID, { resolveAssetUrls })

    expect(result.ok).toBe(false)
    // rollback: added 分 (KEY_B) の削除が best-effort で試みられる。
    expect(spies.del).toHaveBeenCalledWith(USER_ID, KEY_B)
    expect(await getClientDb().media_download_jobs.get([USER_ID, EXAM_ID])).toBeUndefined()
    // hit 分 (KEY_A) は rollback の対象外で保全される。
    expect(await matchAssetBlob(USER_ID, KEY_A)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// success gate — 出口数の source-text pin(spec §4.2「両成功出口を支配する」の完全性主張)
// ---------------------------------------------------------------------------
// header comment (deck-download.ts:18-25) は「ok:true を返す出口は 2 つあり、両方とも
// verifyDeckBlobs で支配される」と主張する。 現状 2 出口 (:172 / :249) はどちらも実際に
// gate を通るが、 将来 3 つ目の早期 ok:true が足されても gate 呼出漏れは他の pin では
// 検出できない (それぞれの出口 pin は「既存の出口が gate を通る」ことしか見ない)。
// 出口の**個数**を pin することで、 新しい出口が足された時点で機械的に落ちる
// (= 追加者に「この出口も gate を通すべきか」の確認を強制する)。
//
// **これは source-text マッチによる pin**(sign-out-purge.test.tsx の mount pin と同型)。
// 検出するもの: 「return { ok: true,」の出現数が増減した(= ok:true を返す出口が増減した)
// こと。
// 検出しないもの: ① 出口数が変わらないまま gate 呼出だけが外された regression(表記だけを
// 見るため。 これは既存の DL success gate describe の変異 pin が個別に担う)② 表記変更
// (改行位置 / スペース有無 / `ok:true` のような詰め表記への変更)には弱い — 変更時は
// 本 pin もあわせて更新すること。
describe('downloadDeckImages — success gate 出口数の source-text pin(修正 1)', () => {
  it('ok:true を返す return 文は 2 個である(早期出口 + DL 本体経路)', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, 'deck-download.ts'),
      'utf8',
    )
    const matches = source.match(/return \{ ok: true,/g) ?? []
    expect(matches.length).toBe(2)
  })
})
