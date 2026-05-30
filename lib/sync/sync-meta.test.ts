// sync_meta accessor test (S-local-2 Task 1)。 fake-indexeddb 経由で実 Dexie
// を動かし、 key 定数 + get/set helper の挙動を verify する。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import { SYNC_META_KEYS, getSyncMeta, setSyncMeta } from './sync-meta'

beforeEach(async () => {
  await getClientDb().sync_meta.clear()
})

describe('SYNC_META_KEYS', () => {
  it('lastStudyDayPullAt / cardsCursor / examsCursor / tombstoneCursor の定数を持つ', () => {
    expect(SYNC_META_KEYS.lastStudyDayPullAt).toBe('last_study_day_pull_at')
    expect(SYNC_META_KEYS.cardsCursor).toBe('cards_cursor')
    expect(SYNC_META_KEYS.examsCursor).toBe('exams_cursor')
    expect(SYNC_META_KEYS.tombstoneCursor).toBe('tombstone_cursor')
  })
})

describe('getSyncMeta', () => {
  it('未 set の key は undefined', async () => {
    const v = await getSyncMeta(SYNC_META_KEYS.cardsCursor)
    expect(v).toBeUndefined()
  })

  it('set した value を取得できる', async () => {
    await setSyncMeta(SYNC_META_KEYS.cardsCursor, '2026-05-26T01:23:45.000Z')
    const v = await getSyncMeta(SYNC_META_KEYS.cardsCursor)
    expect(v).toBe('2026-05-26T01:23:45.000Z')
  })

  it('別 key は干渉しない', async () => {
    await setSyncMeta(SYNC_META_KEYS.cardsCursor, 'cards-cursor-val')
    await setSyncMeta(SYNC_META_KEYS.examsCursor, 'exams-cursor-val')
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('cards-cursor-val')
    expect(await getSyncMeta(SYNC_META_KEYS.examsCursor)).toBe('exams-cursor-val')
  })
})

describe('setSyncMeta', () => {
  it('上書き update で値が更新される', async () => {
    await setSyncMeta(SYNC_META_KEYS.cardsCursor, 'v1')
    await setSyncMeta(SYNC_META_KEYS.cardsCursor, 'v2')
    expect(await getSyncMeta(SYNC_META_KEYS.cardsCursor)).toBe('v2')
  })
})
