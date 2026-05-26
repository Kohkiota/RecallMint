// sync_meta accessor test (S-local-2 Task 1)。 fake-indexeddb 経由で実 Dexie
// を動かし、 key 定数 + get/set helper の挙動を verify する。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta, setSyncMeta } from './sync-meta'

beforeEach(async () => {
  await getClientDb().sync_meta.clear()
})

describe('SYNC_META_KEYS', () => {
  it('lastCardPullAt / lastExamPullAt の定数を持つ', () => {
    expect(SYNC_META_KEYS.lastCardPullAt).toBe('last_card_pull_at')
    expect(SYNC_META_KEYS.lastExamPullAt).toBe('last_exam_pull_at')
  })
})

describe('getSyncMeta', () => {
  it('未 set の key は undefined', async () => {
    const v = await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)
    expect(v).toBeUndefined()
  })

  it('set した value を取得できる', async () => {
    await setSyncMeta(SYNC_META_KEYS.lastCardPullAt, '2026-05-26T01:23:45.000Z')
    const v = await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)
    expect(v).toBe('2026-05-26T01:23:45.000Z')
  })

  it('別 key は干渉しない', async () => {
    await setSyncMeta(SYNC_META_KEYS.lastCardPullAt, 'card-iso')
    await setSyncMeta(SYNC_META_KEYS.lastExamPullAt, 'exam-iso')
    expect(await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)).toBe('card-iso')
    expect(await getSyncMeta(SYNC_META_KEYS.lastExamPullAt)).toBe('exam-iso')
  })
})

describe('setSyncMeta', () => {
  it('上書き update で値が更新される', async () => {
    await setSyncMeta(SYNC_META_KEYS.lastCardPullAt, 'v1')
    await setSyncMeta(SYNC_META_KEYS.lastCardPullAt, 'v2')
    expect(await getSyncMeta(SYNC_META_KEYS.lastCardPullAt)).toBe('v2')
  })
})
