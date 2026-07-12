// upload saga client test (画像フェーズ A Task 8 / spec §3.1・§3.4)。
//
// compressForAttach / attachImageToCard / abandonUpload の 3 関数を、 spec §3.4 の
// 失敗 end-state 表どおりに検証する。
// - browser-image-compression (default export) / asset-actions (reserve/finalize) /
//   @/lib/media/cache / runGuardedEntityMutationFlush は mock。
// - getClientDb() は fake-indexeddb 経由の実 Dexie (vitest.setup.ts が auto shim)。
// - crypto.subtle は node global を使用、 createImageBitmap は node に無いため stub。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClientCardImage } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// mock 定義 (vi.hoisted で mock fn を巻き上げ、 factory から参照する)
// ---------------------------------------------------------------------------

const {
  mockCompress,
  mockReserveAsset,
  mockFinalizeAsset,
  mockPutAssetBlob,
  mockDeleteAssetBlob,
  mockFlush,
} = vi.hoisted(() => ({
  mockCompress: vi.fn(),
  mockReserveAsset: vi.fn(),
  mockFinalizeAsset: vi.fn(),
  mockPutAssetBlob: vi.fn(),
  mockDeleteAssetBlob: vi.fn(),
  mockFlush: vi.fn(),
}))

vi.mock('browser-image-compression', () => ({
  default: mockCompress,
}))

// reserveAsset / finalizeAsset は import されず deps として注入される (Block A 回避)。
// mock fn を deps オブジェクトにまとめて各呼び出しに渡す。

vi.mock('@/lib/media/cache', () => ({
  putAssetBlob: mockPutAssetBlob,
  deleteAssetBlob: mockDeleteAssetBlob,
}))

vi.mock('@/lib/sync/entity-mutation-flush', () => ({
  runGuardedEntityMutationFlush: mockFlush,
}))

import {
  compressForAttach,
  attachImageToCard,
  abandonUpload,
  removeImageFromCard,
} from '@/lib/media/upload'
import { getClientDb } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

// createImageBitmap は node に存在しない。 decode 結果 (width/height) を deterministic
// に返す stub を注入する (compressForAttach が呼ぶ唯一の decode 経路)。
const STUB_BITMAP_W = 1280
const STUB_BITMAP_H = 960
let bitmapClosed = false

function stubCreateImageBitmap(w = STUB_BITMAP_W, h = STUB_BITMAP_H) {
  bitmapClosed = false
  ;(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    vi.fn(async () => ({
      width: w,
      height: h,
      close: () => {
        bitmapClosed = true
      },
    }))
}

// File は node global に無い環境があるため Blob ベースで最小構築する
// (node 24 は File を提供するが、 型を明示して信頼する)。
function makeFile(
  name: string,
  type: string,
  bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]),
): File {
  return new File([bytes as BlobPart], name, { type })
}

// 圧縮出力 blob (実 MIME はデータ駆動 = blob.type)。
function makeBlob(type: string, size = 512): Blob {
  return new Blob([new Uint8Array(size)], { type })
}

const USER_ID = 'user-1'
const CARD_ID = 'card-1'
const TARGET = 'question_text'

// reserve 成功時の既定戻り値 (assetId + uploadUrl)。
const RESERVED_ASSET_ID = '11111111-1111-4111-8111-111111111111'
const UPLOAD_URL = 'https://r2.example/upload/presigned'

function okReserve(assetId = RESERVED_ASSET_ID) {
  return { ok: true as const, data: { assetId, uploadUrl: UPLOAD_URL } }
}

// 注入 deps (実 action の代わりに mock fn を渡す)。
const deps = {
  reserveAsset: mockReserveAsset,
  finalizeAsset: mockFinalizeAsset,
}

beforeEach(async () => {
  vi.clearAllMocks()
  stubCreateImageBitmap()

  // 既定: 圧縮は webp blob を返す。
  mockCompress.mockResolvedValue(makeBlob('image/webp'))
  mockReserveAsset.mockResolvedValue(okReserve())
  mockFinalizeAsset.mockResolvedValue({ ok: true })
  mockPutAssetBlob.mockResolvedValue(undefined)
  mockDeleteAssetBlob.mockResolvedValue(undefined)
  mockFlush.mockResolvedValue('done')

  // fetch (直 PUT) の既定 = 200 ok。
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 200 }),
  )

  const db = getClientDb()
  await Promise.all([db.cards.clear(), db.media_assets.clear(), db.entity_mutations.clear()])
})

afterEach(() => {
  vi.restoreAllMocks()
})

// mirror card row を seed する (currentImages の反映先)。
async function seedCard(images: ClientCardImage[] = []): Promise<void> {
  const db = getClientDb()
  await db.cards.put({
    id: CARD_ID,
    user_id: USER_ID,
    exam_id: 'exam-1',
    question_text: 'q',
    options: [],
    correct_answer_ids: [],
    explanation: null,
    images,
    order_index: 0,
    created_at: '2026-07-12T00:00:00.000Z',
    updated_at: '2026-07-12T00:00:00.000Z',
    sync_status: 'synced',
  } as never)
}

async function getCardImages(): Promise<ClientCardImage[]> {
  const db = getClientDb()
  const card = await db.cards.get(CARD_ID)
  return (card?.images ?? []) as ClientCardImage[]
}

// ===========================================================================
// compressForAttach
// ===========================================================================

describe('compressForAttach', () => {
  it('valid webp → blob/mime(blob.type)/width/height/hash を返す', async () => {
    mockCompress.mockResolvedValue(makeBlob('image/webp', 777))

    const r = await compressForAttach(makeFile('a.webp', 'image/webp'))

    expect(r.mime).toBe('image/webp')
    expect(r.blob.size).toBe(777)
    expect(r.width).toBe(STUB_BITMAP_W)
    expect(r.height).toBe(STUB_BITMAP_H)
    // SHA-256 hex = 64 文字。
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('圧縮 options が verbatim + self-host libURL で渡る', async () => {
    await compressForAttach(makeFile('a.jpg', 'image/jpeg'))

    // COMPRESSION_OPTIONS 値は不変、 self-host libURL を追加 (spec §4)。 node env は
    // window 不在ゆえ相対 path が渡る (browser では絶対 URL 化される)。
    expect(mockCompress).toHaveBeenCalledWith(expect.any(File), {
      maxWidthOrHeight: 1600,
      fileType: 'image/webp',
      initialQuality: 0.8,
      maxSizeMB: 1,
      useWebWorker: true,
      libURL: '/vendor/browser-image-compression.js',
    })
  })

  it('Safari PNG fallback: 出力 blob.type=image/png → mime=image/png (webp を仮定しない)', async () => {
    mockCompress.mockResolvedValue(makeBlob('image/png'))

    const r = await compressForAttach(makeFile('a.jpg', 'image/jpeg'))

    expect(r.mime).toBe('image/png')
  })

  it('decode 後に bitmap を close する', async () => {
    await compressForAttach(makeFile('a.png', 'image/png'))
    expect(bitmapClosed).toBe(true)
  })

  it.each([
    ['image/gif', 'a.gif'],
    ['application/pdf', 'a.pdf'],
    ['', 'a.png'], // 空 MIME (前提: file.type==='' は reject)
    ['image/jpeg', 'a.txt'], // MIME 合致でも拡張子不一致は reject
    ['image/png', 'noext'], // 拡張子なし
  ])('invalid (%s / %s) → throw', async (type, name) => {
    await expect(compressForAttach(makeFile(name, type))).rejects.toThrow()
    // 入口 gate で弾くため圧縮は呼ばれない。
    expect(mockCompress).not.toHaveBeenCalled()
  })

  it('lib が非 Error (Event 様) で reject → 正規化して throw (Error instance)', async () => {
    mockCompress.mockRejectedValue({ type: 'error', isTrusted: true }) // 非 Error

    await expect(
      compressForAttach(makeFile('a.jpg', 'image/jpeg')),
    ).rejects.toBeInstanceOf(Error)
  })

  it('createImageBitmap 失敗 (decode 不能) → throw', async () => {
    ;(
      globalThis as unknown as { createImageBitmap: unknown }
    ).createImageBitmap = vi.fn(async () => {
      throw new Error('decode failed')
    })

    await expect(
      compressForAttach(makeFile('a.jpg', 'image/jpeg')),
    ).rejects.toThrow()
  })
})

// ===========================================================================
// attachImageToCard (saga)
// ===========================================================================

describe('attachImageToCard — happy path', () => {
  it('reserve→楽観層→PUT→finalize→ready→flush、 {ok:true,assetId} を返す', async () => {
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: true, assetId: RESERVED_ASSET_ID })

    // reserve は圧縮結果メタで呼ばれる。
    expect(mockReserveAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        mime: 'image/webp',
        width: STUB_BITMAP_W,
        height: STUB_BITMAP_H,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )

    // Cache put (userId, assetId, blob)。
    expect(mockPutAssetBlob).toHaveBeenCalledWith(
      USER_ID,
      RESERVED_ASSET_ID,
      expect.any(Blob),
    )

    // media_assets に 'uploading' で put 後 → 'ready' に更新。
    const db = getClientDb()
    const asset = await db.media_assets.get(RESERVED_ASSET_ID)
    expect(asset?.status).toBe('ready')
    expect(asset?.user_id).toBe(USER_ID)
    expect(asset?.mime).toBe('image/webp')

    // mirror images に url なしの entry (key=assetId) が append される。
    const images = await getCardImages()
    expect(images).toEqual([
      { key: RESERVED_ASSET_ID, target: TARGET, alt: '' },
    ])
    expect(images[0]).not.toHaveProperty('url')

    // PUT は 圧縮 blob body + Content-Type + timeout signal + CORS hardening で uploadUrl に。
    expect(globalThis.fetch).toHaveBeenCalledWith(
      UPLOAD_URL,
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body: expect.any(Blob),
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    )

    expect(mockFinalizeAsset).toHaveBeenCalledWith(RESERVED_ASSET_ID)
    // 成功時 flush は saga の明示 trigger 1 回のみ (commitImages は skipInternalFlush)。
    expect(mockFlush).toHaveBeenCalledTimes(1)
  })

  it('outbox mutation の patch value に url なしの新 entry が入る', async () => {
    await seedCard([])

    await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    const db = getClientDb()
    const muts = await db.entity_mutations.toArray()
    const imagesMut = muts.find(
      (m) => m.op === 'update_field' && (m.patch as { field?: string }).field === 'images',
    )
    expect(imagesMut).toBeDefined()
    const value = (imagesMut!.patch as { value: ClientCardImage[] }).value
    expect(value).toEqual([{ key: RESERVED_ASSET_ID, target: TARGET, alt: '' }])
    expect(value[0]).not.toHaveProperty('url')
  })

  it('既存 images に append する (全置換 value = 旧 + 新)', async () => {
    const existing: ClientCardImage = {
      key: 'ocr-legacy-1',
      target: TARGET,
      alt: '',
    }
    await seedCard([existing])

    await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [existing],
    }, deps)

    const images = await getCardImages()
    expect(images).toEqual([
      existing,
      { key: RESERVED_ASSET_ID, target: TARGET, alt: '' },
    ])
  })
})

describe('attachImageToCard — 失敗 end-state (spec §3.4)', () => {
  it('INVALID_TYPE: 受付外 MIME → {ok:false,INVALID_TYPE}、 何も書かれない', async () => {
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.gif', 'image/gif'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'INVALID_TYPE' })
    expect(mockReserveAsset).not.toHaveBeenCalled()
    expect(mockPutAssetBlob).not.toHaveBeenCalled()
    expect(await getCardImages()).toEqual([])
  })

  it('COMPRESS_FAILED: 受付 OK だが圧縮/decode 失敗 → {ok:false,COMPRESS_FAILED}、 何も書かれない', async () => {
    mockCompress.mockRejectedValue({ type: 'error' }) // 非 Error reject
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    expect(mockReserveAsset).not.toHaveBeenCalled()
    expect(await getCardImages()).toEqual([])
  })

  it('RESERVE_FAILED: reserve ok:false → {ok:false,RESERVE_FAILED}、 cache/media_assets/mirror 未書込', async () => {
    mockReserveAsset.mockResolvedValue({ ok: false, error: 'offline' })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'RESERVE_FAILED' })
    expect(mockPutAssetBlob).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    const db = getClientDb()
    expect(await db.media_assets.count()).toBe(0)
    expect(await getCardImages()).toEqual([])
  })

  it('UPLOAD_FAILED: PUT !ok → abandon (mirror entry 除去 + cache/media_assets 削除) + {ok:false,UPLOAD_FAILED}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    )
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    // finalize は呼ばれない。
    expect(mockFinalizeAsset).not.toHaveBeenCalled()
    // abandon: cache + media_assets delete。
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    const db = getClientDb()
    expect(await db.media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
    // mirror から entry 除去 (空に戻る)。
    expect(await getCardImages()).toEqual([])
  })

  it('UPLOAD_FAILED: fetch throw (network) → abandon + {ok:false,UPLOAD_FAILED}', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    expect(await getCardImages()).toEqual([])
  })

  it('FINALIZE_FAILED: finalize ok:false → abandon + {ok:false,FINALIZE_FAILED}', async () => {
    mockFinalizeAsset.mockResolvedValue({ ok: false, error: 'verify failed' })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'FINALIZE_FAILED' })
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    const db = getClientDb()
    expect(await db.media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
    expect(await getCardImages()).toEqual([])
    // finalize 失敗 → abandon 経路: ready 化 flush は叩かず、 abandon の除去後 flush が
    // 1 回 (最終 images 値を server へ反映するため)。 ready 更新は行われない。
    expect(mockFlush).toHaveBeenCalledTimes(1)
    const db2 = getClientDb()
    expect(await db2.media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
  })

  // --- 注入 action / Dexie の reject (throw) も必ず AttachResult に落とす (契約: throw を漏らさない) ---

  it('RESERVE_FAILED: reserve が reject (transport 失敗) → {ok:false,RESERVE_FAILED}、 何も書かれず throw も漏れない', async () => {
    mockReserveAsset.mockRejectedValue(new Error('server action transport failed'))
    await seedCard([])
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    expect(r).toEqual({ ok: false, code: 'RESERVE_FAILED' })
    expect(mockPutAssetBlob).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(await getClientDb().media_assets.count()).toBe(0)
    expect(await getCardImages()).toEqual([])
  })

  it('UPLOAD_FAILED: 楽観層書込 (putAssetBlob) が throw → abandon + {ok:false,UPLOAD_FAILED}、 orphan を残さず throw も漏れない', async () => {
    mockPutAssetBlob.mockRejectedValueOnce(new Error('cache write failed'))
    await seedCard([])
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    expect(r).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    // PUT / finalize には進まない。
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockFinalizeAsset).not.toHaveBeenCalled()
    // abandon で cleanup (idempotent)。
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    expect(await getClientDb().media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
    expect(await getCardImages()).toEqual([])
  })

  it('UPLOAD_FAILED: PUT が timeout (AbortError) で reject → abandon + {ok:false,UPLOAD_FAILED}', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    )
    await seedCard([])
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    expect(r).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    expect(await getCardImages()).toEqual([])
  })

  it('FINALIZE_FAILED: finalize が reject (transport 失敗) → abandon + {ok:false,FINALIZE_FAILED}、 card を gate 裏に stuck させない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    mockFinalizeAsset.mockRejectedValue(new Error('server action transport failed'))
    await seedCard([])
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    expect(r).toEqual({ ok: false, code: 'FINALIZE_FAILED' })
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    // media_assets 'uploading' orphan を残さない (= 次 flush で held mutation が解放される)。
    expect(await getClientDb().media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
    expect(await getCardImages()).toEqual([])
  })

  it('TOO_MANY_IMAGES: 既に 10 件 → reserve/圧縮せず {ok:false,TOO_MANY_IMAGES} (server cap 超過の orphan を防ぐ)', async () => {
    const ten: ClientCardImage[] = Array.from({ length: 10 }, (_, i) => ({
      key: `existing-${i}`,
      target: TARGET,
      alt: '',
    }))
    await seedCard(ten)
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: ten,
    }, deps)
    expect(r).toEqual({ ok: false, code: 'TOO_MANY_IMAGES' })
    expect(mockReserveAsset).not.toHaveBeenCalled()
    expect(mockPutAssetBlob).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('ready update が reject → media_assets row を削除して gate を release し {ok:true} (card を stuck させない)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    await seedCard([])
    const db = getClientDb()
    // 最終 ready-update だけ reject (step3 の 'uploading' put は本物)。
    const updateSpy = vi
      .spyOn(db.media_assets, 'update')
      .mockRejectedValueOnce(new Error('idb update failed'))
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    // finalize は成功しているので upload は成功扱い。
    expect(r).toEqual({ ok: true, assetId: RESERVED_ASSET_ID })
    expect(updateSpy).toHaveBeenCalled()
    // gate release: 'uploading' のまま残さず row を削除する。
    expect(await getClientDb().media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
    expect(mockFlush).toHaveBeenCalled()
  })
})

// ===========================================================================
// 並行 attach / fresh-read (lost-update 防止)
// ===========================================================================

describe('attachImageToCard — fresh-read (並行 attach で lost-update しない)', () => {
  it('caller の currentImages が stale ([]) でも mirror の最新 images に append する (先行追加を上書きしない)', async () => {
    const existing: ClientCardImage = {
      key: 'existing-asset',
      target: TARGET,
      alt: '',
    }
    await seedCard([existing]) // mirror には既に 1 件ある
    // caller は stale な [] を渡すが、 inner は fresh ([existing]) を読んで append する。
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    expect(r).toEqual({ ok: true, assetId: RESERVED_ASSET_ID })
    // 既存 + 新規の両方が残る (stale [] で上書きされていない)。
    const images = await getCardImages()
    expect(images.map((i) => i.key)).toEqual(['existing-asset', RESERVED_ASSET_ID])
  })

  it('fresh 値が cap 到達なら caller snapshot が空でも TOO_MANY_IMAGES (並行での 11 件目を防ぐ)', async () => {
    const ten: ClientCardImage[] = Array.from({ length: 10 }, (_, i) => ({
      key: `existing-${i}`,
      target: TARGET,
      alt: '',
    }))
    await seedCard(ten) // mirror には既に 10 件
    // caller は stale な [] (step-0 を通り抜ける) を渡すが、 fresh read で 10 を見て弾く。
    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    expect(r).toEqual({ ok: false, code: 'TOO_MANY_IMAGES' })
    expect(mockReserveAsset).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// abandonUpload
// ===========================================================================

describe('abandonUpload', () => {
  it('mirror entry 除去 + cache delete + media_assets delete', async () => {
    const other: ClientCardImage = { key: 'keep-1', target: TARGET, alt: '' }
    const target: ClientCardImage = {
      key: RESERVED_ASSET_ID,
      target: TARGET,
      alt: '',
    }
    await seedCard([other, target])
    const db = getClientDb()
    await db.media_assets.put({
      id: RESERVED_ASSET_ID,
      user_id: USER_ID,
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 512,
      width: 100,
      height: 100,
      hash: 'h',
      created_at: '2026-07-12T00:00:00.000Z',
    })

    await abandonUpload({
      userId: USER_ID,
      cardId: CARD_ID,
      assetId: RESERVED_ASSET_ID,
      currentImages: [other, target],
    })

    // other は残り target のみ除去。
    expect(await getCardImages()).toEqual([other])
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
    expect(await db.media_assets.get(RESERVED_ASSET_ID)).toBeUndefined()
  })

  it('entry が既に無くても idempotent (throw しない・他 entry 不変)', async () => {
    const other: ClientCardImage = { key: 'keep-1', target: TARGET, alt: '' }
    await seedCard([other])

    await expect(
      abandonUpload({
        userId: USER_ID,
        cardId: CARD_ID,
        assetId: RESERVED_ASSET_ID, // 既に不在
        currentImages: [other],
      }),
    ).resolves.toBeUndefined()

    expect(await getCardImages()).toEqual([other])
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID)
  })
})

// ===========================================================================
// removeImageFromCard (編集面の削除: entry 除去のみ・asset 残す)
// ===========================================================================

describe('removeImageFromCard', () => {
  it('該当 key のみ除去し legacy / 他 target entry は保持 (fresh read + key 一致のみ)、 flush trigger', async () => {
    const legacy: ClientCardImage = { key: 'legacy-img-1', target: 'question_text', alt: '' }
    const other: ClientCardImage = {
      key: '22222222-2222-4222-8222-222222222222',
      target: 'option:a',
      alt: '',
    }
    const toRemove: ClientCardImage = { key: RESERVED_ASSET_ID, target: 'question_text', alt: '' }
    await seedCard([legacy, toRemove, other])

    await removeImageFromCard({ cardId: CARD_ID, assetId: RESERVED_ASSET_ID })

    // RESERVED_ASSET_ID のみ消え、 legacy / 他 target は残る (canonical Minor1)。
    expect(await getCardImages()).toEqual([legacy, other])
    // asset は残す (cache/media_assets を削除しない = abandonUpload と別経路)。
    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
    // 除去後の最終値を server へ反映するため flush trigger。
    expect(mockFlush).toHaveBeenCalled()
  })

  it('caller snapshot でなく mirror の最新値から除去する (並行 attach の追加を巻き込まない)', async () => {
    const a: ClientCardImage = { key: RESERVED_ASSET_ID, target: 'question_text', alt: '' }
    const b: ClientCardImage = {
      key: '33333333-3333-4333-8333-333333333333',
      target: 'question_text',
      alt: '',
    }
    // mirror には既に 2 件 (先行 attach が追加済みの想定)。
    await seedCard([a, b])

    await removeImageFromCard({
      cardId: CARD_ID,
      assetId: '33333333-3333-4333-8333-333333333333',
    })

    // fresh read で [a,b] を読み b のみ除去 → a は保持 (snapshot 非依存)。
    expect(await getCardImages()).toEqual([a])
  })

  it('mirror row の images が非配列 (stale) でも throw せず [] に正規化して commit する', async () => {
    const db = getClientDb()
    await seedCard([])
    // stale / 旧 schema を模して images を非配列に上書き。
    await db.cards.update(CARD_ID, {
      images: 'not-an-array' as unknown as ClientCardImage[],
    })

    await expect(
      removeImageFromCard({ cardId: CARD_ID, assetId: RESERVED_ASSET_ID }),
    ).resolves.toBeUndefined()

    // 非配列 → [] に正規化されるため後続 filter/commit が throw しない。
    expect(await getCardImages()).toEqual([])
  })
})
