// sweepStaleMedia test (画像フェーズ A Task 9 / spec §3.4・§6)。
//
// getClientDb() は fake-indexeddb 経由の実 Dexie (vitest.setup.ts が auto shim)。
// Cache API は Map-backed stub (cache.test.ts と同型) を global.caches に注入。
// abandonUpload / deleteAssetBlob は mock (upload saga 内部の直列化・mirror 書換
// ロジックは Task 8 側で検証済み、 本 test は sweep の分岐・end-state のみ検証)。
//
// 観点: stale 'uploading'(card 参照あり)→ abandonUpload 経路 / stale 'uploading'
// (card 参照なし)→ 直接削除 / fresh 'uploading'(<1h)は不変 / 'downloading' job →
// added blob 削除 + job row 削除 / lock-busy → run skip / per-item 失敗が他を止めない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClientCardImage } from '@/lib/client-db'

const { mockAbandonUpload, mockDeleteAssetBlob } = vi.hoisted(() => ({
  mockAbandonUpload: vi.fn(),
  mockDeleteAssetBlob: vi.fn(),
}))

vi.mock('@/lib/media/upload', () => ({
  abandonUpload: mockAbandonUpload,
}))

vi.mock('@/lib/media/cache', () => ({
  deleteAssetBlob: mockDeleteAssetBlob,
}))

import { sweepStaleMedia } from '@/lib/media/sweep'
import { getClientDb } from '@/lib/client-db'

const USER_ID = 'user-1'
const CARD_ID = 'card-1'

// fake-indexeddb は内部で real timer (setTimeout) を使う transaction 完了検知に
// 依存するため vi.useFakeTimers() と組み合わせると hang する。 sweep の「1h 超」
// 判定は `Date.now()` 基準の相対値のみで足りるため、 実時刻を 1 回だけ捕捉して
// そこからの相対オフセットで created_at を作る (fake timer 不要)。
const NOW = Date.now()

function isoMinusMs(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

const ONE_HOUR_MS = 60 * 60 * 1000

async function seedCard(images: ClientCardImage[]): Promise<void> {
  const db = getClientDb()
  await db.cards.put({
    id: CARD_ID,
    user_id: USER_ID,
    exam_id: 'exam-1',
    question_text: 'q',
    options: [],
    correct_answer_ids: [],
    images,
    answered: false,
    current_streak: 0,
    due: NOW.toString(),
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

beforeEach(async () => {
  vi.clearAllMocks()

  mockAbandonUpload.mockResolvedValue(undefined)
  mockDeleteAssetBlob.mockResolvedValue(undefined)

  const db = getClientDb()
  await Promise.all([
    db.cards.clear(),
    db.media_assets.clear(),
    db.media_download_jobs.clear(),
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sweepStaleMedia — stale uploading (card 参照あり)', () => {
  it('1h 超の uploading asset が card から参照されている → abandonUpload 経路', async () => {
    const db = getClientDb()
    await db.media_assets.put({
      id: 'asset-stale',
      user_id: USER_ID,
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 100,
      width: 10,
      height: 10,
      hash: 'h',
      created_at: isoMinusMs(ONE_HOUR_MS + 1000),
    })
    const images: ClientCardImage[] = [
      { key: 'asset-stale', target: 'question_text', alt: '' },
    ]
    await seedCard(images)

    await sweepStaleMedia(USER_ID)

    expect(mockAbandonUpload).toHaveBeenCalledWith({
      userId: USER_ID,
      cardId: CARD_ID,
      assetId: 'asset-stale',
      currentImages: images,
    })
    // 直接削除経路は呼ばれない (abandonUpload が担当)。
    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
  })
})

describe('sweepStaleMedia — stale uploading (card 参照なし)', () => {
  it('1h 超の uploading asset がどの card からも参照されていない → 直接削除 (cache + media_assets)', async () => {
    const db = getClientDb()
    await db.media_assets.put({
      id: 'asset-orphan',
      user_id: USER_ID,
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 100,
      width: 10,
      height: 10,
      hash: 'h',
      created_at: isoMinusMs(ONE_HOUR_MS + 1000),
    })
    // card はあるが参照なし。
    await seedCard([])

    await sweepStaleMedia(USER_ID)

    expect(mockAbandonUpload).not.toHaveBeenCalled()
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'asset-orphan')
    expect(await db.media_assets.get('asset-orphan')).toBeUndefined()
  })

  it('mirror 参照なし but outbox の pending images mutation が参照 → outbox から cardId を得て abandonUpload (stuck mutation を防ぐ)', async () => {
    const db = getClientDb()
    await db.media_assets.put({
      id: 'asset-outbox-only',
      user_id: USER_ID,
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 100,
      width: 10,
      height: 10,
      hash: 'h',
      created_at: isoMinusMs(ONE_HOUR_MS + 1000),
    })
    // pull が mirror を reset した想定: card はあるが images は空 (asset 参照なし)。
    await seedCard([])
    // outbox には asset を参照する pending images mutation が残っている。
    await db.entity_mutations.add({
      entity_type: 'card',
      entity_id: CARD_ID,
      op: 'update_field',
      patch: {
        field: 'images',
        value: [{ key: 'asset-outbox-only', target: 'question_text', alt: '' }],
      },
      mutation_id: 'mut-outbox-1',
      edited_at: new Date().toISOString(),
      sync_status: 'pending',
    } as never)

    await sweepStaleMedia(USER_ID)

    // 直接削除でなく、 outbox から得た cardId で abandonUpload が呼ばれる
    // (abandonUpload が pending mutation を coalesce 矯正 + cache/media_assets 削除)。
    expect(mockAbandonUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        cardId: CARD_ID,
        assetId: 'asset-outbox-only',
      }),
    )
    // abandonUpload (mock) が cache 削除を担うため、 sweep の直接 deleteAssetBlob は呼ばれない。
    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
  })
})

describe('sweepStaleMedia — fresh uploading', () => {
  it('1h 未満の uploading asset は不変 (abandon も削除もされない)', async () => {
    const db = getClientDb()
    await db.media_assets.put({
      id: 'asset-fresh',
      user_id: USER_ID,
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 100,
      width: 10,
      height: 10,
      hash: 'h',
      created_at: isoMinusMs(1000), // 1 秒前
    })
    await seedCard([])

    await sweepStaleMedia(USER_ID)

    expect(mockAbandonUpload).not.toHaveBeenCalled()
    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
    expect(await db.media_assets.get('asset-fresh')).toBeDefined()
  })

  it('別 user の 1h 超 uploading asset は触らない (共有ブラウザの cross-user 汚染防止)', async () => {
    const db = getClientDb()
    await db.media_assets.put({
      id: 'asset-other-user',
      user_id: 'user-2', // 現 session (USER_ID='user-1') とは別 user
      status: 'uploading',
      mime: 'image/webp',
      byte_size: 100,
      width: 10,
      height: 10,
      hash: 'h',
      created_at: isoMinusMs(2 * 60 * 60 * 1000), // 2h 前 (十分 stale)
    })

    // 現 user (user-1) で sweep しても user-2 の row は残す。
    await sweepStaleMedia(USER_ID)

    expect(mockAbandonUpload).not.toHaveBeenCalled()
    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
    expect(await db.media_assets.get('asset-other-user')).toBeDefined()
  })
})

describe('sweepStaleMedia — downloading job 残骸', () => {
  it('downloading job の added_asset_ids を全て cache 削除 + job row 削除', async () => {
    const db = getClientDb()
    await db.media_download_jobs.put({
      exam_id: 'exam-1',
      user_id: USER_ID,
      status: 'downloading',
      total: 3,
      done_count: 2,
      added_asset_ids: ['a1', 'a2'],
      started_at: isoMinusMs(5000),
    })

    await sweepStaleMedia(USER_ID)

    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'a1')
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'a2')
    expect(
      await db.media_download_jobs.get([USER_ID, 'exam-1']),
    ).toBeUndefined()
  })

  it('done job には触れない', async () => {
    const db = getClientDb()
    await db.media_download_jobs.put({
      exam_id: 'exam-done',
      user_id: USER_ID,
      status: 'done',
      total: 2,
      done_count: 2,
      added_asset_ids: ['a1'],
      started_at: isoMinusMs(5000),
    })

    await sweepStaleMedia(USER_ID)

    expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
    expect(
      await db.media_download_jobs.get([USER_ID, 'exam-done']),
    ).toBeDefined()
  })
})

describe('sweepStaleMedia — lock busy', () => {
  it('他タブが sweep 中 (lock busy) → run が skip される', async () => {
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    const requestSpy = vi.fn(
      (_name: string, _options: unknown, cb: (lock: unknown) => Promise<void>) =>
        cb(null),
    )
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: { request: requestSpy } },
      configurable: true,
      writable: true,
    })

    try {
      const db = getClientDb()
      await db.media_assets.put({
        id: 'asset-stale',
        user_id: USER_ID,
        status: 'uploading',
        mime: 'image/webp',
        byte_size: 100,
        width: 10,
        height: 10,
        hash: 'h',
        created_at: isoMinusMs(ONE_HOUR_MS + 1000),
      })

      await sweepStaleMedia(USER_ID)

      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(mockAbandonUpload).not.toHaveBeenCalled()
      expect(mockDeleteAssetBlob).not.toHaveBeenCalled()
      // run が skip された = 変更なし。
      expect(await db.media_assets.get('asset-stale')).toBeDefined()
    } finally {
      if (originalNavigator === undefined) {
        delete (globalThis as { navigator?: unknown }).navigator
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
          writable: true,
        })
      }
    }
  })
})

describe('sweepStaleMedia — per-item 失敗の隔離', () => {
  it('1 件の abandonUpload 失敗が他 asset / job の sweep を止めない', async () => {
    const db = getClientDb()
    await db.media_assets.bulkPut([
      {
        id: 'asset-fail',
        user_id: USER_ID,
        status: 'uploading',
        mime: 'image/webp',
        byte_size: 100,
        width: 10,
        height: 10,
        hash: 'h1',
        created_at: isoMinusMs(ONE_HOUR_MS + 1000),
      },
      {
        id: 'asset-orphan-ok',
        user_id: USER_ID,
        status: 'uploading',
        mime: 'image/webp',
        byte_size: 100,
        width: 10,
        height: 10,
        hash: 'h2',
        created_at: isoMinusMs(ONE_HOUR_MS + 1000),
      },
    ])
    const images: ClientCardImage[] = [
      { key: 'asset-fail', target: 'question_text', alt: '' },
    ]
    await seedCard(images)

    mockAbandonUpload.mockRejectedValueOnce(new Error('storage failure'))

    await db.media_download_jobs.put({
      exam_id: 'exam-1',
      user_id: USER_ID,
      status: 'downloading',
      total: 1,
      done_count: 0,
      added_asset_ids: ['a1'],
      started_at: isoMinusMs(5000),
    })

    await expect(sweepStaleMedia(USER_ID)).resolves.toBeUndefined()

    // asset-fail の abandon は失敗したが、 asset-orphan-ok の直接削除と job の掃除は完遂。
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'asset-orphan-ok')
    expect(await db.media_assets.get('asset-orphan-ok')).toBeUndefined()
    expect(mockDeleteAssetBlob).toHaveBeenCalledWith(USER_ID, 'a1')
    expect(
      await db.media_download_jobs.get([USER_ID, 'exam-1']),
    ).toBeUndefined()
  })
})
