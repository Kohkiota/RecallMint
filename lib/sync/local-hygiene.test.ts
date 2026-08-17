// local-hygiene の test(tag mirror hygiene sprint Task 4 = sign-out purge / spec §4、
// Task 5 = sign-in 異 owner sweep / spec §5)。
//
// getClientDb() は fake-indexeddb 経由の実 Dexie(vitest.setup.ts が auto shim)。
// Cache API は Map-backed stub(cache.test.ts と同型)を global.caches に注入し、
// lib/media/cache.ts の実 helper 経由で purge / sweep の Cache 部を実走させる(parse /
// 列挙 / 削除の配線ごと検証するため mock しない)。
//
// 観点(purge):
// - 分類表 HYGIENE_STORE_RULES の中身(陽形の削除条件)と ClientDb 全 store の網羅
// - 実走: mirror / sync_meta 全消・synced outbox 削除・不可侵集合(pending/syncing/
//   failed outbox・非 'ready' assets・'downloading' jobs)の生存(自 + 異 owner)
// - tx 原子性: tx 内 1 操作を test 側 spy で throw させると全 store が変更前のまま
// - Cache: 保護 blob 生存 / malformed 含む非保護 key 削除 / per-key 失敗続行 /
//   cache 不在時に新規作成しない / Dexie 部 skip でも Cache 部は実行
// - in-flight guard: 並走は 1 実行 / settle 後(成功・失敗の双方)は次回が新規実行
//
// 観点(sweep):
// - sync_meta 分類(pure): allowlist リテラル 7 本・分類強制・bare 削除・scoped の
//   self 温存 / other 削除・malformed suffix 削除・未知 key / prefix 類似の温存
// - 実走: 異 owner の synced / 'ready' / 'done' のみ削除、 不可侵集合(自 + 異 owner)と
//   自 owner の全行は生存、 sync_meta は分類どおり
// - 空 userId: Dexie / Cache とも一切触らない(fail-closed)
// - tx 原子性(sweep は purge と別 query 群のため独立に必要)
// - Cache: 自 namespace 温存 / 異 owner 削除 / malformed 削除 / 保護 blob は owner 不問で
//   生存 / per-key 失敗後も残りの削除が続行

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Dexie from 'dexie'

const { mockLoggerInfo } = vi.hoisted(() => ({ mockLoggerInfo: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}))

import {
  ClientDb,
  getClientDb,
  type ClientCard,
  type SyncStatus,
} from '@/lib/client-db'
import { putAssetBlob } from '@/lib/media/cache'
import { SYNC_META_KEYS } from './sync-meta'
import {
  HYGIENE_STORE_RULES,
  SWEEP_EXEMPT_BASES,
  SWEEP_SYNC_META_BASES,
  classifySyncMetaKeyForSweep,
  purgeAllLocalData,
  sweepForeignLocalData,
} from './local-hygiene'

const SELF = 'user-self'
const OTHER = 'user-other'

// ---------------------------------------------------------------------------
// Map-backed Cache / CacheStorage stub(cache.test.ts と同型 + 失敗注入)
// ---------------------------------------------------------------------------

const STUB_ORIGIN = 'https://app.test'

function normalizeKey(key: string | Request): string {
  return typeof key === 'string' ? new URL(key, STUB_ORIGIN).toString() : key.url
}

class FakeCache {
  private store = new Map<string, Response>()
  // delete がこの URL に対してだけ throw する(per-key 失敗の注入)。
  failDeleteFor: string | null = null

  async put(key: string | Request, response: Response): Promise<void> {
    this.store.set(normalizeKey(key), response)
  }

  async match(key: string | Request): Promise<Response | undefined> {
    return this.store.get(normalizeKey(key))
  }

  async delete(key: string | Request): Promise<boolean> {
    const url = normalizeKey(key)
    if (this.failDeleteFor === url) throw new Error('cache delete failed')
    return this.store.delete(url)
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

const CACHE_NAME = 'recallmint-media'

let originalCaches: typeof globalThis.caches | undefined

async function mediaCache(): Promise<FakeCache> {
  return (await globalThis.caches.open(CACHE_NAME)) as unknown as FakeCache
}

async function cachedUrls(): Promise<string[]> {
  const cache = await mediaCache()
  return (await cache.keys()).map((r) => r.url).sort()
}

function blobUrl(userId: string, assetId: string): string {
  return `${STUB_ORIGIN}/__media/${userId}/${assetId}`
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeCard(id: string, userId: string): ClientCard {
  return {
    id,
    user_id: userId,
    exam_id: 'exam-1',
    title: 't',
    base_order: 1,
    question_text: 'q',
    options: [],
    correct_answer_ids: [],
    images: [],
    answered: false,
    current_streak: 0,
    due: '2026-01-01T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learning_steps: 0,
    content_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    sync_status: 'synced',
  }
}

const OUTBOX_STATUSES: SyncStatus[] = ['pending', 'syncing', 'synced', 'failed']

async function seedAll(): Promise<void> {
  const db = getClientDb()

  // mirror 6(自 + 異 owner)
  for (const userId of [SELF, OTHER]) {
    await db.exams.put({
      id: `exam-${userId}`,
      user_id: userId,
      name: 'e',
      content_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await db.cards.put(makeCard(`card-${userId}`, userId))
    await db.study_days.put({
      user_id: userId,
      day: '2026-01-01',
      review_count: 1,
      correct_count: 1,
      distinct_card_count: 1,
    })
    await db.tag_categories.put({
      id: `cat-${userId}`,
      user_id: userId,
      name: 'c',
      select_type: 'single',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await db.tag_options.put({
      id: `opt-${userId}`,
      user_id: userId,
      category_id: `cat-${userId}`,
      name: 'o',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await db.card_tags.put({
      card_id: `card-${userId}`,
      option_id: `opt-${userId}`,
      user_id: userId,
      created_at: '2026-01-01T00:00:00.000Z',
    })

    // outbox 2 × 4 status
    for (const status of OUTBOX_STATUSES) {
      await db.answer_events.add({
        event_id: `ev-${userId}-${status}`,
        user_id: userId,
        session_id: 's',
        card_id: `card-${userId}`,
        selected_answer_ids: [],
        is_correct: true,
        rating: 3,
        answered_at: '2026-01-01T00:00:00.000Z',
        sync_status: status,
      })
      await db.entity_mutations.add({
        user_id: userId,
        mutation_id: `mut-${userId}-${status}`,
        entity_type: 'card',
        entity_id: `card-${userId}`,
        op: 'update_field',
        patch: { field: 'title', value: 't' },
        edited_at: '2026-01-01T00:00:00.000Z',
        sync_status: status,
      })
    }
  }

  // media_assets: 'ready'(自 + 異)/ 非 'ready'(自 uploading / 異 failed)
  await db.media_assets.bulkPut([
    {
      id: 'asset-self-ready',
      user_id: SELF,
      status: 'ready',
      mime: 'image/webp',
      byte_size: 1,
      width: 1,
      height: 1,
      hash: 'h',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'asset-other-ready',
      user_id: OTHER,
      status: 'ready',
      mime: 'image/webp',
      byte_size: 1,
      width: 1,
      height: 1,
      hash: 'h',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'asset-self-uploading',
      user_id: SELF,
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 1,
      width: 1,
      height: 1,
      hash: 'h',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'asset-other-failed',
      user_id: OTHER,
      status: 'failed',
      mime: 'image/webp',
      byte_size: 1,
      width: 1,
      height: 1,
      hash: 'h',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ])

  // media_download_jobs: 'downloading'(自 + 異)/ 'done'(自)
  await db.media_download_jobs.bulkPut([
    {
      exam_id: 'exam-dl-self',
      user_id: SELF,
      status: 'downloading',
      total: 1,
      done_count: 0,
      added_asset_ids: ['dl-self-added'],
      started_at: '2026-01-01T00:00:00.000Z',
    },
    {
      exam_id: 'exam-dl-other',
      user_id: OTHER,
      status: 'downloading',
      total: 1,
      done_count: 0,
      added_asset_ids: ['dl-other-added'],
      started_at: '2026-01-01T00:00:00.000Z',
    },
    {
      exam_id: 'exam-dl-done',
      user_id: SELF,
      status: 'done',
      total: 1,
      done_count: 1,
      added_asset_ids: ['dl-done-added'],
      started_at: '2026-01-01T00:00:00.000Z',
    },
  ])

  // sync_meta: scoped(自 / 異)+ bare legacy + 未知 key
  await db.sync_meta.bulkPut([
    { key: `cards_cursor:${SELF}`, value: '2026-01-01T00:00:00.000Z' },
    { key: `cards_cursor:${OTHER}`, value: '2026-01-01T00:00:00.000Z' },
    { key: 'cards_cursor', value: '2026-01-01T00:00:00.000Z' },
    { key: 'future_key', value: 'x' },
  ])

  // Cache blobs
  await putAssetBlob(SELF, 'asset-self-ready', new Blob(['a']))
  await putAssetBlob(OTHER, 'asset-other-ready', new Blob(['b']))
  await putAssetBlob(SELF, 'asset-self-uploading', new Blob(['c']))
  await putAssetBlob(OTHER, 'asset-other-failed', new Blob(['d']))
  await putAssetBlob(SELF, 'dl-self-added', new Blob(['e']))
  await putAssetBlob(OTHER, 'dl-other-added', new Blob(['f']))
  await putAssetBlob(SELF, 'dl-done-added', new Blob(['g']))
  await putAssetBlob(SELF, 'orphan-asset', new Blob(['h']))
  // 規約外 key(malformed)— purge は削除側に倒す
  const cache = await mediaCache()
  await cache.put(`${STUB_ORIGIN}/garbage-key`, new Response('i'))
}

// purge 後に生存すべき blob(不可侵集合に対応する 4 本)。
const PROTECTED_URLS = [
  blobUrl(SELF, 'asset-self-uploading'),
  blobUrl(OTHER, 'asset-other-failed'),
  blobUrl(SELF, 'dl-self-added'),
  blobUrl(OTHER, 'dl-other-added'),
].sort()

async function clearAllTables(): Promise<void> {
  const db = getClientDb()
  await Promise.all(db.tables.map((t) => t.clear()))
}

beforeEach(async () => {
  mockLoggerInfo.mockClear()
  originalCaches = globalThis.caches
  globalThis.caches = new FakeCacheStorage() as unknown as CacheStorage
  await clearAllTables()
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.caches = originalCaches as CacheStorage
})

// ---------------------------------------------------------------------------
// 分類表
// ---------------------------------------------------------------------------

describe('HYGIENE_STORE_RULES(分類表)', () => {
  const MIRROR_STORES = [
    'exams',
    'cards',
    'study_days',
    'tag_categories',
    'tag_options',
    'card_tags',
  ] as const

  it('mirror 6 store は purge=clear / sweep=異 owner 削除', () => {
    for (const name of MIRROR_STORES) {
      expect(HYGIENE_STORE_RULES[name].purge).toEqual({ kind: 'clear' })
      expect(HYGIENE_STORE_RULES[name].sweep).toEqual({ kind: 'foreign-owner' })
    }
  })

  it("media_assets は purge / sweep とも 'ready' のみ(陽形)", () => {
    expect(HYGIENE_STORE_RULES.media_assets.purge).toEqual({
      kind: 'delete-status',
      field: 'status',
      value: 'ready',
    })
    expect(HYGIENE_STORE_RULES.media_assets.sweep).toEqual({
      kind: 'foreign-owner-and-status',
      field: 'status',
      value: 'ready',
    })
  })

  it("media_download_jobs は purge / sweep とも 'done' のみ(陽形)", () => {
    expect(HYGIENE_STORE_RULES.media_download_jobs.purge).toEqual({
      kind: 'delete-status',
      field: 'status',
      value: 'done',
    })
    expect(HYGIENE_STORE_RULES.media_download_jobs.sweep).toEqual({
      kind: 'foreign-owner-and-status',
      field: 'status',
      value: 'done',
    })
  })

  it("outbox 2 store は purge / sweep とも sync_status 'synced' のみ(陽形)", () => {
    for (const name of ['answer_events', 'entity_mutations'] as const) {
      expect(HYGIENE_STORE_RULES[name].purge).toEqual({
        kind: 'delete-status',
        field: 'sync_status',
        value: 'synced',
      })
      expect(HYGIENE_STORE_RULES[name].sweep).toEqual({
        kind: 'foreign-owner-and-status',
        field: 'sync_status',
        value: 'synced',
      })
    }
  })

  it('sync_meta は purge=全消し / sweep=key 分類(非対称)', () => {
    expect(HYGIENE_STORE_RULES.sync_meta.purge).toEqual({ kind: 'clear' })
    expect(HYGIENE_STORE_RULES.sync_meta.sweep).toEqual({
      kind: 'sync-meta-classify',
    })
  })

  it('網羅: ClientDb の全 store が purge / sweep 両規則つきで分類されている', () => {
    const declared = new ClientDb().tables.map((t) => t.name).sort()
    const purgeKinds = ['clear', 'delete-status']
    const sweepKinds = [
      'foreign-owner',
      'foreign-owner-and-status',
      'sync-meta-classify',
    ]

    const unclassified = declared.filter((name) => {
      const rule = (
        HYGIENE_STORE_RULES as Record<
          string,
          { purge: { kind: string }; sweep: { kind: string } } | undefined
        >
      )[name]
      return (
        !rule ||
        !purgeKinds.includes(rule.purge.kind) ||
        !sweepKinds.includes(rule.sweep.kind)
      )
    })

    expect(
      unclassified,
      `ClientDb に store を追加したら HYGIENE_STORE_RULES に purge / sweep 両規則を宣言すること: ${unclassified.join(', ')}`,
    ).toEqual([])
  })

  it('逆検査: 分類表の store 名は全て ClientDb に実在する(表の陳腐化検出)', () => {
    const declared = new ClientDb().tables.map((t) => t.name)
    const stale = Object.keys(HYGIENE_STORE_RULES).filter(
      (name) => !declared.includes(name),
    )

    expect(stale).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// purge: Dexie 部
// ---------------------------------------------------------------------------

describe('purgeAllLocalData — Dexie 部', () => {
  it('mirror 6 と sync_meta を全消しする(異 owner 行・未知 key 含む)', async () => {
    await seedAll()

    await purgeAllLocalData()

    const db = getClientDb()
    expect(await db.exams.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.study_days.count()).toBe(0)
    expect(await db.tag_categories.count()).toBe(0)
    expect(await db.tag_options.count()).toBe(0)
    expect(await db.card_tags.count()).toBe(0)
    expect(await db.sync_meta.count()).toBe(0)
  })

  it("outbox 2 store は 'synced' のみ消え pending / syncing / failed は自 + 異 owner とも生存する(不可侵)", async () => {
    await seedAll()

    await purgeAllLocalData()

    const db = getClientDb()
    const events = await db.answer_events.toArray()
    const mutations = await db.entity_mutations.toArray()

    expect(events.map((e) => e.event_id).sort()).toEqual(
      [
        `ev-${SELF}-pending`,
        `ev-${SELF}-syncing`,
        `ev-${SELF}-failed`,
        `ev-${OTHER}-pending`,
        `ev-${OTHER}-syncing`,
        `ev-${OTHER}-failed`,
      ].sort(),
    )
    expect(mutations.map((m) => m.mutation_id).sort()).toEqual(
      [
        `mut-${SELF}-pending`,
        `mut-${SELF}-syncing`,
        `mut-${SELF}-failed`,
        `mut-${OTHER}-pending`,
        `mut-${OTHER}-syncing`,
        `mut-${OTHER}-failed`,
      ].sort(),
    )
  })

  it("media_assets は 'ready' のみ消え、非 'ready' 行は自 + 異 owner とも生存する(flush gate の根拠を壊さない)", async () => {
    await seedAll()

    await purgeAllLocalData()

    const assets = await getClientDb().media_assets.toArray()
    expect(assets.map((a) => a.id).sort()).toEqual(
      ['asset-self-uploading', 'asset-other-failed'].sort(),
    )
  })

  it("media_download_jobs は 'done' のみ消え、'downloading' 行は自 + 異 owner とも生存する(all-or-nothing 維持)", async () => {
    await seedAll()

    await purgeAllLocalData()

    const jobs = await getClientDb().media_download_jobs.toArray()
    expect(jobs.map((j) => j.exam_id).sort()).toEqual(
      ['exam-dl-self', 'exam-dl-other'].sort(),
    )
  })

  it('tx 原子性: tx 内 1 操作が throw すると全 store が変更前のまま(部分実行が観測できない)', async () => {
    await seedAll()
    const db = getClientDb()

    // 先行 store の削除が済んだ後で落ちることを担保する(先頭で落ちると
    // 「完了済み作業の巻き戻し」を検証したことにならない)。
    const names = Object.keys(HYGIENE_STORE_RULES)
    expect(names.indexOf('sync_meta')).toBeGreaterThan(0)

    // production に failure hook を足さず、test 側の spy で throw を注入する。
    vi.spyOn(db.sync_meta, 'clear').mockImplementation(() => {
      throw new Error('injected tx failure')
    })

    await expect(purgeAllLocalData()).rejects.toThrow('injected tx failure')

    expect(await db.exams.count()).toBe(2)
    expect(await db.cards.count()).toBe(2)
    expect(await db.study_days.count()).toBe(2)
    expect(await db.tag_categories.count()).toBe(2)
    expect(await db.tag_options.count()).toBe(2)
    expect(await db.card_tags.count()).toBe(2)
    expect(await db.sync_meta.count()).toBe(4)
    expect(await db.answer_events.count()).toBe(8)
    expect(await db.entity_mutations.count()).toBe(8)
    expect(await db.media_assets.count()).toBe(4)
    expect(await db.media_download_jobs.count()).toBe(3)
    // Dexie 部が失敗した時点で保護集合が確定しないため Cache 部は走らない。
    expect(await cachedUrls()).toHaveLength(9)
  })
})

// ---------------------------------------------------------------------------
// purge: Cache 部
// ---------------------------------------------------------------------------

describe('purgeAllLocalData — Cache 部', () => {
  it('保護 blob(非 ready assets / downloading job の added)だけが残り、malformed key を含む他は消える', async () => {
    await seedAll()

    await purgeAllLocalData()

    expect(await cachedUrls()).toEqual(PROTECTED_URLS)
  })

  it('per-key の削除失敗は残りの削除を止めない', async () => {
    await seedAll()
    const cache = await mediaCache()
    cache.failDeleteFor = blobUrl(SELF, 'asset-self-ready')

    await purgeAllLocalData()

    // 失敗した 1 本だけが残り、他の非保護 key(malformed 含む)は消える。
    expect(await cachedUrls()).toEqual(
      [...PROTECTED_URLS, blobUrl(SELF, 'asset-self-ready')].sort(),
    )
  })

  it('cache が存在しない環境では cache を新規作成しない', async () => {
    const openSpy = vi.spyOn(globalThis.caches, 'open')

    await purgeAllLocalData()

    expect(openSpy).not.toHaveBeenCalled()
    expect(await globalThis.caches.has(CACHE_NAME)).toBe(false)
  })

  it('Dexie.exists が false なら Dexie 部を skip し、Cache 部だけを実行する', async () => {
    await seedAll()
    vi.spyOn(Dexie, 'exists').mockResolvedValue(false)

    await purgeAllLocalData()

    const db = getClientDb()
    // Dexie 部 skip: 全 store が seed のまま
    expect(await db.exams.count()).toBe(2)
    expect(await db.sync_meta.count()).toBe(4)
    expect(await db.media_assets.count()).toBe(4)
    // Cache 部は独立に実行される(DB を読まないので保護集合は空 = 全削除)
    expect(await cachedUrls()).toEqual([])
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ dexie_skipped: true }),
    )
  })
})

// ---------------------------------------------------------------------------
// log(smoke で発火を確定させるための 1 行)
// ---------------------------------------------------------------------------

describe('purgeAllLocalData — log', () => {
  it('完了時に event 名 + 件数のみを 1 行 log する(userId / key / row 内容を出さない)', async () => {
    await seedAll()

    await purgeAllLocalData()

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1)
    // toEqual の完全一致で「余計な field を足していない」ことまで pin する
    // (userId / cache key が payload に混ざれば落ちる)。
    expect(mockLoggerInfo.mock.calls[0][0]).toEqual({
      event: 'local_hygiene.purge',
      dexie_skipped: false,
      // seed は cache 9 件 = 保護 4 + 非保護 5(malformed 1 本を含む)。
      cache_deleted: 5,
      cache_kept: 4,
    })
  })

  it('失敗時は log しない(best-effort・失敗 silent の契約)', async () => {
    await seedAll()
    vi.spyOn(Dexie, 'exists').mockRejectedValueOnce(new Error('injected failure'))

    await expect(purgeAllLocalData()).rejects.toThrow('injected failure')

    expect(mockLoggerInfo).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// in-flight guard
// ---------------------------------------------------------------------------

describe('purgeAllLocalData — in-flight guard', () => {
  it('並走する 2 回の呼出は 1 実行に dedup される', async () => {
    await seedAll()
    // purge は冪等ゆえ end-state では 1 実行と 2 実行を区別できない。 削除本体である
    // rw tx の回数で観測する。
    const txSpy = vi.spyOn(getClientDb(), 'transaction')

    await Promise.all([purgeAllLocalData(), purgeAllLocalData()])

    expect(txSpy).toHaveBeenCalledTimes(1)
  })

  it('成功して settle した後の呼出は新規実行になる(guard が解除される)', async () => {
    await seedAll()
    await purgeAllLocalData()

    // 2 回目の purge が実際に働くことを end-state で観測する
    // (guard を解除し損ねると settled promise が返り、この行は消えない)。
    await getClientDb().exams.put({
      id: 'exam-after-purge',
      user_id: SELF,
      name: 'e',
      content_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    await purgeAllLocalData()

    expect(await getClientDb().exams.count()).toBe(0)
  })

  it('失敗して settle した後の呼出も新規実行になる(guard は失敗経路でも解除される)', async () => {
    await seedAll()
    vi.spyOn(Dexie, 'exists').mockRejectedValueOnce(new Error('injected failure'))

    await expect(purgeAllLocalData()).rejects.toThrow('injected failure')

    await purgeAllLocalData()

    // 2 回目が Dexie 部・Cache 部とも実走したことを、それぞれの削除対象で観測する。
    expect(await getClientDb().exams.count()).toBe(0)
    expect(await cachedUrls()).not.toContain(blobUrl(SELF, 'asset-self-ready'))
  })
})

// ===========================================================================
// Task 5: sign-in 異 owner sweep(spec §5)
// ===========================================================================

// ---------------------------------------------------------------------------
// sweep 専用 fixture
// ---------------------------------------------------------------------------
// seedAll(purge 側 pin の期待値の基準)は変更せず、 sweep 固有に必要な行だけを足す:
// - 異 owner の 'done' job + その added blob(異 owner かつ 'done' が消える対)
// - sync_meta の bare 7 本 + parser 境界 + prefix 類似 + 未知 scoped key
async function seedSweepExtras(): Promise<void> {
  const db = getClientDb()

  await db.media_download_jobs.put({
    exam_id: 'exam-dl-other-done',
    user_id: OTHER,
    status: 'done',
    total: 1,
    done_count: 1,
    added_asset_ids: ['dl-other-done-added'],
    started_at: '2026-01-01T00:00:00.000Z',
  })
  await putAssetBlob(OTHER, 'dl-other-done-added', new Blob(['j']))

  await db.sync_meta.bulkPut([
    // bare legacy key 7 本(cursor 6 + 旧 exam_view_prefs)。
    ...SWEEP_SYNC_META_BASES.map((base) => ({ key: base, value: 'legacy' })),
    { key: `exam_view_prefs:${SELF}`, value: '{}' },
    { key: `exam_view_prefs:${OTHER}`, value: '{}' },
    // 未知 base の scoped key(将来 key の silent 誤削除を防ぐ側)。
    { key: `future_key:${SELF}`, value: 'x' },
    // prefix 類似の未知 base。
    { key: 'cards_cursor_v2', value: 'x' },
    // 既知 base の malformed suffix。
    { key: 'cards_cursor:', value: 'x' },
    { key: 'cards_cursor:a:b', value: 'x' },
  ])
}

async function seedForSweep(): Promise<void> {
  await seedAll()
  await seedSweepExtras()
}

/** 全 store の件数 snapshot(不変を主張する pin で「どこか 1 つでも動いたら落ちる」形にする)。 */
async function tableCounts(): Promise<Record<string, number>> {
  const db = getClientDb()
  const entries = await Promise.all(
    db.tables.map(async (t) => [t.name, await t.count()] as const),
  )
  return Object.fromEntries(entries)
}

async function syncMetaKeys(): Promise<string[]> {
  return (await getClientDb().sync_meta.toArray()).map((r) => r.key).sort()
}

// sweep 後に生存すべき Cache key: 自 namespace 全部(Dexie 行の無い orphan も含む)+
// 異 owner でも保護集合(非 'ready' assets / 'downloading' job の added)に載るもの。
const SWEEP_SURVIVING_URLS = [
  blobUrl(SELF, 'asset-self-ready'),
  blobUrl(SELF, 'asset-self-uploading'),
  blobUrl(SELF, 'dl-self-added'),
  blobUrl(SELF, 'dl-done-added'),
  blobUrl(SELF, 'orphan-asset'),
  blobUrl(OTHER, 'asset-other-failed'),
  blobUrl(OTHER, 'dl-other-added'),
].sort()

// ---------------------------------------------------------------------------
// sync_meta 分類(pure)
// ---------------------------------------------------------------------------

describe('classifySyncMetaKeyForSweep(sync_meta 分類)', () => {
  it('allowlist は明示リテラル 7 本(cursor 6 + 旧 exam_view_prefs)', () => {
    expect([...SWEEP_SYNC_META_BASES].sort()).toEqual([
      'card_tags_cursor',
      'cards_cursor',
      'exam_view_prefs',
      'exams_cursor',
      'tag_categories_cursor',
      'tag_options_cursor',
      'tombstone_cursor',
    ])
  })

  it('分類強制: SYNC_META_KEYS の全値が allowlist ∪ 明示除外 list に現れる', () => {
    const classified = new Set<string>([
      ...SWEEP_SYNC_META_BASES,
      ...SWEEP_EXEMPT_BASES,
    ])
    const unclassified = Object.values(SYNC_META_KEYS).filter(
      (key) => !classified.has(key),
    )

    expect(
      unclassified,
      `sync_meta key を追加したら sweep 対象か否かを明示すること(SWEEP_SYNC_META_BASES または SWEEP_EXEMPT_BASES): ${unclassified.join(', ')}`,
    ).toEqual([])
  })

  it('bare key(旧 key 7 本)は削除', () => {
    for (const base of SWEEP_SYNC_META_BASES) {
      expect(classifySyncMetaKeyForSweep(base, SELF)).toBe('delete')
    }
  })

  it('base:<self> は温存 / base:<other> は削除', () => {
    for (const base of SWEEP_SYNC_META_BASES) {
      expect(classifySyncMetaKeyForSweep(`${base}:${SELF}`, SELF)).toBe('keep')
      expect(classifySyncMetaKeyForSweep(`${base}:${OTHER}`, SELF)).toBe(
        'delete',
      )
    }
  })

  it('未知 key は bare / scoped とも温存(将来 key の silent 誤削除を防ぐ)', () => {
    expect(classifySyncMetaKeyForSweep('future_key', SELF)).toBe('keep')
    expect(classifySyncMetaKeyForSweep(`future_key:${SELF}`, SELF)).toBe('keep')
    expect(classifySyncMetaKeyForSweep(`future_key:${OTHER}`, SELF)).toBe('keep')
  })

  it('既知 base の malformed suffix(空 / 複数 colon)は削除', () => {
    expect(classifySyncMetaKeyForSweep('cards_cursor:', SELF)).toBe('delete')
    expect(classifySyncMetaKeyForSweep('cards_cursor:a:b', SELF)).toBe('delete')
    expect(classifySyncMetaKeyForSweep(`cards_cursor:${SELF}:x`, SELF)).toBe(
      'delete',
    )
  })

  it('prefix 類似の未知 base は温存(cards_cursor_v2)', () => {
    expect(classifySyncMetaKeyForSweep('cards_cursor_v2', SELF)).toBe('keep')
    expect(classifySyncMetaKeyForSweep(`cards_cursor_v2:${SELF}`, SELF)).toBe(
      'keep',
    )
    expect(classifySyncMetaKeyForSweep(`cards_cursor_v2:${OTHER}`, SELF)).toBe(
      'keep',
    )
  })
})

// ---------------------------------------------------------------------------
// sweep: Dexie 部
// ---------------------------------------------------------------------------

describe('sweepForeignLocalData — Dexie 部', () => {
  it('mirror 6 store は異 owner 行のみ消え、自 owner 行は生存する', async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    const db = getClientDb()
    expect((await db.exams.toArray()).map((r) => r.user_id)).toEqual([SELF])
    expect((await db.cards.toArray()).map((r) => r.user_id)).toEqual([SELF])
    expect((await db.study_days.toArray()).map((r) => r.user_id)).toEqual([SELF])
    expect((await db.tag_categories.toArray()).map((r) => r.user_id)).toEqual([
      SELF,
    ])
    expect((await db.tag_options.toArray()).map((r) => r.user_id)).toEqual([
      SELF,
    ])
    expect((await db.card_tags.toArray()).map((r) => r.user_id)).toEqual([SELF])
  })

  it("outbox 2 store は異 owner の 'synced' のみ消え、異 owner の pending / syncing / failed と自 owner 全行は生存する(不可侵)", async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    const db = getClientDb()
    expect((await db.answer_events.toArray()).map((e) => e.event_id).sort()).toEqual(
      [
        `ev-${SELF}-pending`,
        `ev-${SELF}-syncing`,
        `ev-${SELF}-synced`,
        `ev-${SELF}-failed`,
        `ev-${OTHER}-pending`,
        `ev-${OTHER}-syncing`,
        `ev-${OTHER}-failed`,
      ].sort(),
    )
    expect(
      (await db.entity_mutations.toArray()).map((m) => m.mutation_id).sort(),
    ).toEqual(
      [
        `mut-${SELF}-pending`,
        `mut-${SELF}-syncing`,
        `mut-${SELF}-synced`,
        `mut-${SELF}-failed`,
        `mut-${OTHER}-pending`,
        `mut-${OTHER}-syncing`,
        `mut-${OTHER}-failed`,
      ].sort(),
    )
  })

  it("media_assets は異 owner の 'ready' のみ消え、異 owner の非 'ready' 行と自 owner 全行は生存する(flush gate の根拠を壊さない)", async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    const assets = await getClientDb().media_assets.toArray()
    expect(assets.map((a) => a.id).sort()).toEqual(
      ['asset-self-ready', 'asset-self-uploading', 'asset-other-failed'].sort(),
    )
  })

  it("media_download_jobs は異 owner の 'done' のみ消え、異 owner の 'downloading' と自 owner 全行は生存する(all-or-nothing 維持)", async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    const jobs = await getClientDb().media_download_jobs.toArray()
    expect(jobs.map((j) => j.exam_id).sort()).toEqual(
      ['exam-dl-self', 'exam-dl-other', 'exam-dl-done'].sort(),
    )
  })

  it('sync_meta は bare + base:<other> + malformed suffix のみ消え、base:<self> と未知 key は生存する', async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    expect(await syncMetaKeys()).toEqual(
      [
        `cards_cursor:${SELF}`,
        `exam_view_prefs:${SELF}`,
        'future_key',
        `future_key:${SELF}`,
        'cards_cursor_v2',
      ].sort(),
    )
  })

  it('空 userId では Dexie / Cache を一切触らない(fail-closed)', async () => {
    await seedForSweep()
    const before = await tableCounts()
    const beforeUrls = await cachedUrls()
    // 前提の非 vacuous 確認: 異 owner 行が実在する状態で呼ぶ。
    expect(before.exams).toBe(2)
    expect(beforeUrls.length).toBe(10)

    const txSpy = vi.spyOn(getClientDb(), 'transaction')
    const hasSpy = vi.spyOn(globalThis.caches, 'has')
    const openSpy = vi.spyOn(globalThis.caches, 'open')

    await sweepForeignLocalData('')

    expect(txSpy).not.toHaveBeenCalled()
    expect(hasSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(await tableCounts()).toEqual(before)
    expect(await cachedUrls()).toEqual(beforeUrls)
  })

  it('tx 原子性: tx 内 1 操作が throw すると全 store が変更前のまま(部分実行が観測できない)', async () => {
    await seedForSweep()
    const db = getClientDb()
    const before = await tableCounts()
    const beforeUrls = await cachedUrls()

    // 先行 store の削除が済んだ後で落ちることを担保する(先頭で落ちると
    // 「完了済み作業の巻き戻し」を検証したことにならない)。
    const names = Object.keys(HYGIENE_STORE_RULES)
    expect(names.indexOf('sync_meta')).toBeGreaterThan(0)

    // production に failure hook を足さず、test 側の spy で throw を注入する。
    vi.spyOn(db.sync_meta, 'filter').mockImplementation(() => {
      throw new Error('injected tx failure')
    })

    await expect(sweepForeignLocalData(SELF)).rejects.toThrow(
      'injected tx failure',
    )

    expect(await tableCounts()).toEqual(before)
    // Dexie 部が失敗した時点で保護集合が確定しないため Cache 部は走らない。
    expect(await cachedUrls()).toEqual(beforeUrls)
  })
})

// ---------------------------------------------------------------------------
// sweep: Cache 部
// ---------------------------------------------------------------------------

describe('sweepForeignLocalData — Cache 部', () => {
  it('自 namespace は温存 / 異 owner と malformed は削除 / 保護 blob は owner 不問で生存', async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    expect(await cachedUrls()).toEqual(SWEEP_SURVIVING_URLS)
  })

  it('per-key の削除失敗は残り(異 owner / malformed)の削除を止めない', async () => {
    await seedForSweep()
    const cache = await mediaCache()
    cache.failDeleteFor = blobUrl(OTHER, 'asset-other-ready')

    await sweepForeignLocalData(SELF)

    expect(await cachedUrls()).toEqual(
      [...SWEEP_SURVIVING_URLS, blobUrl(OTHER, 'asset-other-ready')].sort(),
    )
  })

  it('cache が存在しない環境では cache を新規作成しない', async () => {
    const openSpy = vi.spyOn(globalThis.caches, 'open')

    await sweepForeignLocalData(SELF)

    expect(openSpy).not.toHaveBeenCalled()
    expect(await globalThis.caches.has(CACHE_NAME)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sweep: log
// ---------------------------------------------------------------------------

describe('sweepForeignLocalData — log', () => {
  it('完了時に event 名 + 件数のみを 1 行 log する(userId / key / row 内容を出さない)', async () => {
    await seedForSweep()

    await sweepForeignLocalData(SELF)

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1)
    // toEqual の完全一致で「余計な field を足していない」ことまで pin する。
    expect(mockLoggerInfo.mock.calls[0][0]).toEqual({
      event: 'local_hygiene.sweep',
      // seed は cache 10 件 = 生存 7 + 削除 3(malformed 1 本を含む)。
      cache_deleted: 3,
      cache_kept: 7,
    })
  })
})
