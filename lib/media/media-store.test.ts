// Dexie version(8) test (画像フェーズ A Task 6)。
// fake-indexeddb 経由で実 ClientDb を version 8 で open し、 media_assets /
// media_download_jobs の読み書きと [user_id+hash] compound index を verify する。
// 既存 store (cards) が引き続き定義されていることも合わせて確認し、
// v8 が純粋 store 追加であること (既存 version への非破壊) を担保する。

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getClientDb,
  type ClientMediaAsset,
  type ClientMediaDownloadJob,
} from '@/lib/client-db'

function fakeMediaAsset(
  overrides?: Partial<ClientMediaAsset>,
): ClientMediaAsset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    status: 'uploading',
    mime: 'image/webp',
    byte_size: 1234,
    width: 800,
    height: 600,
    hash: 'hash-abc',
    created_at: '2026-07-12T00:00:00.000Z',
    ...overrides,
  }
}

function fakeMediaDownloadJob(
  overrides?: Partial<ClientMediaDownloadJob>,
): ClientMediaDownloadJob {
  return {
    exam_id: 'exam-1',
    user_id: 'user-1',
    status: 'downloading',
    total: 10,
    done_count: 0,
    added_asset_ids: [],
    started_at: '2026-07-12T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  const db = getClientDb()
  await Promise.all([
    db.media_assets.clear(),
    db.media_download_jobs.clear(),
  ])
})

describe('ClientDb version(8)', () => {
  it('db が version 8 で open する', async () => {
    const db = getClientDb()
    await db.open()
    expect(db.verno).toBe(8)
  })

  it('既存 store (cards) が引き続き定義されている(回帰なし)', () => {
    const db = getClientDb()
    expect(db.cards).toBeDefined()
  })

  it('media_assets.put → .get(id) が round-trip する', async () => {
    const db = getClientDb()
    const asset = fakeMediaAsset()

    await db.media_assets.put(asset)
    const fetched = await db.media_assets.get(asset.id)

    expect(fetched).toEqual(asset)
  })

  it('[user_id+hash] compound index で query できる', async () => {
    const db = getClientDb()
    await db.media_assets.bulkPut([
      fakeMediaAsset({ id: 'asset-1', user_id: 'user-1', hash: 'hash-a' }),
      fakeMediaAsset({ id: 'asset-2', user_id: 'user-1', hash: 'hash-b' }),
      fakeMediaAsset({ id: 'asset-3', user_id: 'user-2', hash: 'hash-a' }),
    ])

    const matched = await db.media_assets
      .where('[user_id+hash]')
      .equals(['user-1', 'hash-a'])
      .toArray()

    expect(matched.map((row) => row.id)).toEqual(['asset-1'])
  })

  it('media_download_jobs.put → .get([user_id, exam_id]) が round-trip する', async () => {
    const db = getClientDb()
    const job = fakeMediaDownloadJob()

    await db.media_download_jobs.put(job)
    const fetched = await db.media_download_jobs.get([
      job.user_id,
      job.exam_id,
    ])

    expect(fetched).toEqual(job)
  })
})
