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
  mockIsWebKit,
  mockCompressImageSafe,
  mockValidateOutput,
  mockValidateStructure,
  mockLoggerInfo,
} = vi.hoisted(() => ({
  mockCompress: vi.fn(),
  mockReserveAsset: vi.fn(),
  mockFinalizeAsset: vi.fn(),
  mockPutAssetBlob: vi.fn(),
  mockDeleteAssetBlob: vi.fn(),
  mockFlush: vi.fn(),
  mockIsWebKit: vi.fn(),
  mockCompressImageSafe: vi.fn(),
  mockValidateOutput: vi.fn(),
  mockValidateStructure: vi.fn(),
  mockLoggerInfo: vi.fn(),
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

// WebKit 分岐 / 自前 pipeline / 出力検証は browser decode を要し node env で動かないため
// mock する (T1/T2/T3 の unit が本体挙動を担保。 本 file は saga の配線を検証する)。
// 既定は「非 WebKit + 検証 pass」= 既存 Blink 経路を素通りさせ回帰を維持する。
vi.mock('@/lib/media/webkit-detect', () => ({
  isWebKitImagePipeline: mockIsWebKit,
}))
vi.mock('@/lib/media/compress-image-safe', () => ({
  compressImageSafe: mockCompressImageSafe,
}))
vi.mock('@/lib/media/image-validation', () => ({
  validateCompressionOutput: mockValidateOutput,
  validateImageStructure: mockValidateStructure,
}))

// telemetry (Task 6): logger.info を spy し、 saga 終端で 1 添付 = 1 image_attach を assert する。
vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), warnFromError: vi.fn() },
}))

import {
  compressForAttach,
  attachImageToCard,
  abandonUpload,
  removeImageFromCard,
  runExclusiveImageWork,
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

// 条件成立まで待つ (逐次化 test 用。 saga は圧縮前に Dexie read 等の非同期前段があり
// 固定 tick 数では圧縮開始を観測できないため、 predicate で待つ)。
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// validateCompressionOutput が返す metrics の最小 stub (saga は ok のみ参照)。
const EMPTY_SAMPLE = { opaqueRatio: 0, meanLuma: 0, lumaVar: 0, edgeEnergy: 0 }
const VALIDATION_METRICS = { input: EMPTY_SAMPLE, output: EMPTY_SAMPLE, mae: 0 }

// WebKit 経路 (compressImageSafe) の canned 戻り値。 寸法は STUB_BITMAP と別値にして
// 「lib 経路 (bitmap 寸法) でなく safe pipeline 寸法が使われた」ことを assert できる。
const WEBKIT_W = 640
const WEBKIT_H = 480
function makeWebkitResult() {
  return {
    blob: makeBlob('image/webp', 333),
    mime: 'image/webp',
    width: WEBKIT_W,
    height: WEBKIT_H,
    hash: 'a'.repeat(64),
  }
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

  // 既定: 非 WebKit (既存 lib 経路を素通り) + 出力検証 pass。 これで Blink 系の既存 test が
  // 無変化のまま通る (検証は追加されるが正常出力は ok)。
  mockIsWebKit.mockReturnValue(false)
  mockValidateOutput.mockResolvedValue({ ok: true, metrics: VALIDATION_METRICS })
  mockCompressImageSafe.mockResolvedValue(makeWebkitResult())
  // 既定: fallback (T5) が呼ぶ構造検証は pass (元 blob の decode/寸法)。
  mockValidateStructure.mockResolvedValue({ ok: true, width: 800, height: 600 })

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

  // --- WebKit 分岐 + 全経路共通検証 (Task 4) ---

  it('非 WebKit: 既存 lib 経路 (imageCompression) を呼び、 検証は expected なしで通す', async () => {
    mockIsWebKit.mockReturnValue(false)

    const r = await compressForAttach(makeFile('a.jpg', 'image/jpeg'))

    // lib 経路 = imageCompression 呼出 + createImageBitmap 寸法。
    expect(mockCompress).toHaveBeenCalledTimes(1)
    expect(mockCompressImageSafe).not.toHaveBeenCalled()
    expect(r.width).toBe(STUB_BITMAP_W)
    expect(r.height).toBe(STUB_BITMAP_H)
    // 検証は全経路共通で呼ぶ。 lib 経路は寸法非制御ゆえ expected を渡さない。
    expect(mockValidateOutput).toHaveBeenCalledTimes(1)
    const [input, output, expected] = mockValidateOutput.mock.calls[0]
    expect(input).toBeInstanceOf(File)
    expect(output).toBeInstanceOf(Blob)
    expect(expected).toBeUndefined()
  })

  it('WebKit: 自前 pipeline (compressImageSafe) を呼び、 検証に expected (safe pipeline 寸法) を渡す', async () => {
    mockIsWebKit.mockReturnValue(true)

    const r = await compressForAttach(makeFile('a.jpg', 'image/jpeg'))

    // WebKit 経路 = compressImageSafe 呼出 (imageCompression は使わない)。
    expect(mockCompressImageSafe).toHaveBeenCalledTimes(1)
    expect(mockCompress).not.toHaveBeenCalled()
    // 戻り値は safe pipeline のもの (bitmap stub 寸法でない)。
    expect(r.width).toBe(WEBKIT_W)
    expect(r.height).toBe(WEBKIT_H)
    // 検証に safe pipeline の確定寸法を expected として渡す。
    expect(mockValidateOutput).toHaveBeenCalledTimes(1)
    const [, , expected] = mockValidateOutput.mock.calls[0]
    expect(expected).toEqual({ width: WEBKIT_W, height: WEBKIT_H })
  })

  it('検証 reject ({ok:false}) → ValidationFailedError を throw (name で判別可能)', async () => {
    mockValidateOutput.mockResolvedValue({
      ok: false,
      reason: 'opaque_collapse',
      metrics: VALIDATION_METRICS,
    })

    await expect(
      compressForAttach(makeFile('a.jpg', 'image/jpeg')),
    ).rejects.toMatchObject({ name: 'ValidationFailedError' })
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

  it('COMPRESS_FAILED: 受付 OK だが圧縮/decode 失敗 かつ fallback 非対象 (webp) → {ok:false,COMPRESS_FAILED}、 何も書かれない', async () => {
    mockCompress.mockRejectedValue({ type: 'error' }) // 非 Error reject
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.webp', 'image/webp'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    expect(mockReserveAsset).not.toHaveBeenCalled()
    expect(await getCardImages()).toEqual([])
  })

  it('COMPRESS_FAILED: 出力検証 reject (ValidationFailedError) かつ fallback 構造検証も失敗 → {ok:false,COMPRESS_FAILED}', async () => {
    mockValidateOutput.mockResolvedValue({
      ok: false,
      reason: 'flat_collapse',
      metrics: VALIDATION_METRICS,
    })
    mockValidateStructure.mockResolvedValue({ ok: false, reason: 'decode_failed', width: 0, height: 0 })
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
// fallback: 圧縮/検証失敗時に元画像を direct PUT する (Task 5)
// ===========================================================================

describe('attachImageToCard — fallback (元画像 direct PUT)', () => {
  it('圧縮 throw (非対象でない jpeg ≤5MiB) + 構造検証 ok → 元 file を reserve+PUT して成功する', async () => {
    mockCompress.mockRejectedValue({ type: 'error' }) // 非 Error reject → 圧縮 crash
    mockValidateStructure.mockResolvedValue({ ok: true, width: 800, height: 600 })
    await seedCard([])
    const file = makeFile('a.jpg', 'image/jpeg', new Uint8Array(2048))

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file,
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: true, assetId: RESERVED_ASSET_ID })
    // reserve は元 file の mime/byteSize/構造検証の寸法で呼ばれる (圧縮結果でなく元画像)。
    expect(mockReserveAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        mime: 'image/jpeg',
        byteSize: file.size,
        width: 800,
        height: 600,
      }),
    )
    // PUT body は元 blob (compressed でなく file そのもの)。
    expect(globalThis.fetch).toHaveBeenCalledWith(
      UPLOAD_URL,
      expect.objectContaining({ body: file }),
    )
    expect(mockPutAssetBlob).toHaveBeenCalledWith(USER_ID, RESERVED_ASSET_ID, file)
  })

  it('出力検証 reject (ValidationFailedError) + 構造検証 ok → 元 file を PUT して成功する', async () => {
    mockValidateOutput.mockResolvedValue({
      ok: false,
      reason: 'flat_collapse',
      metrics: VALIDATION_METRICS,
    })
    mockValidateStructure.mockResolvedValue({ ok: true, width: 800, height: 600 })
    await seedCard([])
    const file = makeFile('a.png', 'image/png', new Uint8Array(2048))

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file,
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: true, assetId: RESERVED_ASSET_ID })
    expect(mockReserveAsset).toHaveBeenCalledWith(
      expect.objectContaining({ mime: 'image/png', byteSize: file.size }),
    )
  })

  it('構造検証 {ok:false} (decode 不能 / 偽装拡張子等) → fallback せず COMPRESS_FAILED', async () => {
    mockCompress.mockRejectedValue({ type: 'error' })
    mockValidateStructure.mockResolvedValue({
      ok: false,
      reason: 'magic_mismatch',
      width: 0,
      height: 0,
    })
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

  it('file.size > 5MiB → fallback を試みず COMPRESS_FAILED (構造検証は呼ばれない)', async () => {
    mockCompress.mockRejectedValue({ type: 'error' })
    await seedCard([])
    const bigFile = makeFile('a.jpg', 'image/jpeg', new Uint8Array(5 * 1024 * 1024 + 1))

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: bigFile,
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    expect(mockValidateStructure).not.toHaveBeenCalled()
    expect(mockReserveAsset).not.toHaveBeenCalled()
  })

  it('file.type が webp (jpg/png 以外) → fallback を試みず COMPRESS_FAILED', async () => {
    mockCompress.mockRejectedValue({ type: 'error' })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.webp', 'image/webp'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    expect(mockValidateStructure).not.toHaveBeenCalled()
    expect(mockReserveAsset).not.toHaveBeenCalled()
  })

  it('InvalidImageTypeError (入口 gate) → fallback を試みず INVALID_TYPE のまま', async () => {
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.gif', 'image/gif'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'INVALID_TYPE' })
    expect(mockValidateStructure).not.toHaveBeenCalled()
    expect(mockReserveAsset).not.toHaveBeenCalled()
  })

  it('fallback 成功時、 楽観層 (commitImages / media_assets put) は 1 回だけ実行される (二重更新なし)', async () => {
    mockCompress.mockRejectedValue({ type: 'error' })
    mockValidateStructure.mockResolvedValue({ ok: true, width: 800, height: 600 })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: true, assetId: RESERVED_ASSET_ID })
    expect(mockPutAssetBlob).toHaveBeenCalledTimes(1)
    // mirror images に fallback 経由の entry が 1 件だけ append される (二重更新なら 2 件以上になる)。
    const images = await getCardImages()
    expect(images).toEqual([{ key: RESERVED_ASSET_ID, target: TARGET, alt: '' }])
    // 成功時 flush trigger も 1 回のみ。
    expect(mockFlush).toHaveBeenCalledTimes(1)
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
// runExclusiveImageWork (single-flight) + WebKit saga 逐次化
// ===========================================================================

describe('runExclusiveImageWork', () => {
  it('2 つの並行 work が overlap せず投入順に逐次実行される', async () => {
    const events: string[] = []
    // work A は work B より後に resolve する deferred。 逐次なら B は A 完了まで開始しない。
    let releaseA: () => void = () => {}
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const pA = runExclusiveImageWork(async () => {
      events.push('A:start')
      await aGate
      events.push('A:end')
      return 'a'
    })
    const pB = runExclusiveImageWork(async () => {
      events.push('B:start')
      events.push('B:end')
      return 'b'
    })

    // A が gate で待っている間、 B はまだ開始していない (逐次化の証拠)。
    await Promise.resolve()
    expect(events).toEqual(['A:start'])

    releaseA()
    const [ra, rb] = await Promise.all([pA, pB])

    expect(ra).toBe('a')
    expect(rb).toBe('b')
    // B の start は A の end より後 (区間が overlap しない)。
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('先行 work の reject は後続に伝播しない (chain を壊さない)', async () => {
    const pFail = runExclusiveImageWork(async () => {
      throw new Error('boom')
    })
    const pOk = runExclusiveImageWork(async () => 'ok')

    await expect(pFail).rejects.toThrow('boom')
    await expect(pOk).resolves.toBe('ok')
  })
})

describe('attachImageToCard — WebKit のみ圧縮区間を逐次化する', () => {
  it('WebKit: 2 card 同時 attach の圧縮区間が overlap しない (別 card でも global chain で逐次)', async () => {
    mockIsWebKit.mockReturnValue(true)
    await seedCard([])
    // 2 枚目の card も seed する。
    const db = getClientDb()
    await db.cards.put({
      id: 'card-2',
      user_id: USER_ID,
      exam_id: 'exam-1',
      question_text: 'q2',
      options: [],
      correct_answer_ids: [],
      explanation: null,
      images: [],
      order_index: 1,
      created_at: '2026-07-12T00:00:00.000Z',
      updated_at: '2026-07-12T00:00:00.000Z',
      sync_status: 'synced',
    } as never)

    // compressImageSafe の実行区間を観測する。 1 枚目は gate で待たせ、 逐次なら 2 枚目の
    // 圧縮は 1 枚目完了まで始まらない (別 card = per-card 直列化では防げない → global chain)。
    const events: string[] = []
    let release1: () => void = () => {}
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve
    })
    mockCompressImageSafe
      .mockImplementationOnce(async () => {
        events.push('c1:start')
        await gate1
        events.push('c1:end')
        return makeWebkitResult()
      })
      .mockImplementationOnce(async () => {
        events.push('c2:start')
        events.push('c2:end')
        return makeWebkitResult()
      })

    const p1 = attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    const p2 = attachImageToCard({
      userId: USER_ID,
      cardId: 'card-2',
      target: TARGET,
      file: makeFile('b.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    // 1 枚目の圧縮開始まで待つ (saga は圧縮前に Dexie read 等の前段がある)。
    await waitUntil(() => events.includes('c1:start'))
    // gate で待つ間、 2 枚目の圧縮はまだ開始していない (別 card でも global chain で逐次)。
    expect(events).toEqual(['c1:start'])

    release1()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    // 逐次: c2 は c1 完了後に開始 (区間が overlap しない)。
    expect(events).toEqual(['c1:start', 'c1:end', 'c2:start', 'c2:end'])
  })

  it('非 WebKit: 圧縮区間は single-flight で包まれず並列に走る (Blink は従来どおり)', async () => {
    mockIsWebKit.mockReturnValue(false)
    await seedCard([])
    const db = getClientDb()
    await db.cards.put({
      id: 'card-2',
      user_id: USER_ID,
      exam_id: 'exam-1',
      question_text: 'q2',
      options: [],
      correct_answer_ids: [],
      explanation: null,
      images: [],
      order_index: 1,
      created_at: '2026-07-12T00:00:00.000Z',
      updated_at: '2026-07-12T00:00:00.000Z',
      sync_status: 'synced',
    } as never)

    const events: string[] = []
    let release1: () => void = () => {}
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve
    })
    // lib 経路 (imageCompression) の区間を観測。 別 card ゆえ per-card 直列化に掛からず、
    // WebKit wrap もないため 2 枚目の圧縮は 1 枚目の gate 待ち中でも開始できる (並列)。
    mockCompress
      .mockImplementationOnce(async () => {
        events.push('c1:start')
        await gate1
        events.push('c1:end')
        return makeBlob('image/webp')
      })
      .mockImplementationOnce(async () => {
        events.push('c2:start')
        events.push('c2:end')
        return makeBlob('image/webp')
      })

    const p1 = attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)
    const p2 = attachImageToCard({
      userId: USER_ID,
      cardId: 'card-2',
      target: TARGET,
      file: makeFile('b.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    // 1 枚目が gate で待つ間でも 2 枚目の圧縮は開始する (並列 = single-flight で包まれない)。
    await waitUntil(() => events.includes('c2:start'))
    expect(events).toContain('c2:start')
    expect(events).not.toContain('c1:end') // c1 はまだ gate 待ち = 両区間が overlap している

    release1()
    await Promise.all([p1, p2])
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

    await removeImageFromCard({ userId: USER_ID, cardId: CARD_ID, assetId: RESERVED_ASSET_ID })

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
      userId: USER_ID,
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
      removeImageFromCard({ userId: USER_ID, cardId: CARD_ID, assetId: RESERVED_ASSET_ID }),
    ).resolves.toBeUndefined()

    // 非配列 → [] に正規化されるため後続 filter/commit が throw しない。
    expect(await getCardImages()).toEqual([])
  })
})

// ===========================================================================
// telemetry (Task 6): 1 添付 = 1 logger.info({ event:'image_attach', ... })
// ===========================================================================

// image_attach レコードのみを抽出する (logger.info は本 saga 以外からも呼ばれうる前提で
// 将来の混入に強くする。 現状は本 saga のみが info を叩く)。
function imageAttachCalls(): Record<string, unknown>[] {
  return mockLoggerInfo.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((p) => p.event === 'image_attach')
}

describe('attachImageToCard — telemetry (image_attach)', () => {
  it('成功 (lib 経路): 1 レコード・outcome=success・compressionPath=lib・PII 不記録', async () => {
    mockIsWebKit.mockReturnValue(false)
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('secret-name.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r.ok).toBe(true)
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'image_attach',
      outcome: 'success',
      compressionPath: 'lib',
    })
    expect(records[0]).not.toHaveProperty('reason')
    // output.requestedType は lib 経路では省略。
    expect((records[0].output as Record<string, unknown> | undefined)?.requestedType).toBeUndefined()

    // PII: file 名 / hash / bytes 本体を含まない。
    const json = JSON.stringify(records[0])
    expect(json).not.toContain('secret-name')
    expect(json).not.toContain('hash')
  })

  it('成功 (WebKit 経路): 1 レコード・outcome=success・compressionPath=webkit-safe・output.requestedType=image/webp', async () => {
    mockIsWebKit.mockReturnValue(true)
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r.ok).toBe(true)
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      outcome: 'success',
      compressionPath: 'webkit-safe',
    })
    expect(records[0].output).toMatchObject({ requestedType: 'image/webp' })
  })

  it('fallback 成功: 1 レコード・outcome=fallback_used・reason=validation_failed・compressionPath=fallback', async () => {
    mockValidateOutput.mockResolvedValue({
      ok: false,
      reason: 'flat_collapse',
      metrics: VALIDATION_METRICS,
    })
    mockValidateStructure.mockResolvedValue({ ok: true, width: 800, height: 600 })
    await seedCard([])
    const file = makeFile('a.png', 'image/png', new Uint8Array(2048))

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file,
      currentImages: [],
    }, deps)

    expect(r.ok).toBe(true)
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      outcome: 'fallback_used',
      reason: 'validation_failed',
      compressionPath: 'fallback',
    })
    // fallback 成功時は出力検証の validationMetrics を保持している。
    expect(records[0].validationMetrics).toEqual(VALIDATION_METRICS)
    // output.requestedType は fallback 経路では省略。
    expect((records[0].output as Record<string, unknown>).requestedType).toBeUndefined()
  })

  it('ハード失敗 (RESERVE_FAILED): 1 レコード・outcome=error・reason=reserve_failed', async () => {
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
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'reserve_failed' })
  })

  it('INVALID_TYPE: 1 レコード・outcome=error・reason=invalid_type', async () => {
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.gif', 'image/gif'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'INVALID_TYPE' })
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'invalid_type' })
    // 入口 gate 早期失敗でも source (type/bytes) は記録される (PII でない数値/MIME のみ)。
    expect(records[0].source).toMatchObject({ type: 'image/gif' })
  })

  it('TOO_MANY_IMAGES: 1 レコード・outcome=error・reason=too_many_images', async () => {
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
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'too_many_images' })
  })

  it('COMPRESS_FAILED (fallback 非対象 webp): 1 レコード・outcome=error・reason=fallback_not_allowed (fallback 非対象という最終理由を記録)', async () => {
    mockCompress.mockRejectedValue({ type: 'error' })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.webp', 'image/webp'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'fallback_not_allowed' })
  })

  it('COMPRESS_FAILED (圧縮 crash かつ fallback 構造検証が内容 reject〔magic 不一致〕): trigger reason=compress_failed を保持', async () => {
    mockCompress.mockRejectedValue({ type: 'error' })
    // 内容系の構造 reject (magic 不一致) は validation_failed に集約 → trigger と同語彙ゆえ
    // 上書きせず compress_failed を保持する。
    mockValidateStructure.mockResolvedValue({ ok: false, reason: 'magic_mismatch', width: 0, height: 0 })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'compress_failed' })
  })

  it('COMPRESS_FAILED (圧縮 crash かつ fallback 元画像が decode 不能): reason=decode_failed を surface', async () => {
    // 元画像が真に decode 不能 = decode_failed は validation_failed と区別し、 trigger の
    // compress_failed より診断的ゆえ最終 reason に surface する (brief schema・Codex 指摘)。
    mockCompress.mockRejectedValue({ type: 'error' })
    mockValidateStructure.mockResolvedValue({ ok: false, reason: 'decode_failed', width: 0, height: 0 })
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'COMPRESS_FAILED' })
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'decode_failed' })
  })

  it('fallback 成功後に PUT 失敗 → reason は終端の upload_failed(fallback trigger を残さない)', async () => {
    // 検証 reject → fallback 成功 → その後 PUT が 500 → 終端は upload_failed。 fallback を
    // 誘発した validation_failed でなく終端 code の reason を記録する(Codex 指摘)。
    mockValidateOutput.mockResolvedValue({
      ok: false,
      reason: 'flat_collapse',
      metrics: VALIDATION_METRICS,
    })
    mockValidateStructure.mockResolvedValue({ ok: true, width: 800, height: 600 })
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
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      outcome: 'error',
      reason: 'upload_failed',
      compressionPath: 'fallback',
    })
  })

  it('UPLOAD_FAILED: 1 レコード・outcome=error・reason=upload_failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))
    await seedCard([])

    const r = await attachImageToCard({
      userId: USER_ID,
      cardId: CARD_ID,
      target: TARGET,
      file: makeFile('a.jpg', 'image/jpeg'),
      currentImages: [],
    }, deps)

    expect(r).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'upload_failed' })
  })

  it('FINALIZE_FAILED: 1 レコード・outcome=error・reason=finalize_failed', async () => {
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
    const records = imageAttachCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'finalize_failed' })
  })
})
