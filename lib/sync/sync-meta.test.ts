// sync_meta accessor test (S-local-2 Task 1 / Grid-1)。 fake-indexeddb 経由で実 Dexie
// を動かし、 key 定数 + string helper + JSON helper の挙動を verify する。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb } from '@/lib/client-db'
import {
  SYNC_META_KEYS,
  getSyncMeta,
  setSyncMeta,
  getJsonSyncMeta,
  setJsonSyncMeta,
  examViewPrefsV1Schema,
} from './sync-meta'

beforeEach(async () => {
  await getClientDb().sync_meta.clear()
})

describe('SYNC_META_KEYS', () => {
  it('cardsCursor / examsCursor / tombstoneCursor の定数を持つ', () => {
    expect(SYNC_META_KEYS.cardsCursor).toBe('cards_cursor')
    expect(SYNC_META_KEYS.examsCursor).toBe('exams_cursor')
    expect(SYNC_META_KEYS.tombstoneCursor).toBe('tombstone_cursor')
  })

  it('examViewPrefs の定数を持つ', () => {
    expect(SYNC_META_KEYS.examViewPrefs).toBe('exam_view_prefs')
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

// ---------------------------------------------------------------------------
// getJsonSyncMeta / setJsonSyncMeta (Grid-1)
// ---------------------------------------------------------------------------

describe('getJsonSyncMeta / setJsonSyncMeta — ExamViewPrefsV1', () => {
  // case 1: 正常 set→get で同値復元
  it('正常 set→get で同値復元', async () => {
    await setJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      { version: 1, view: 'table' },
      examViewPrefsV1Schema,
    )
    const result = await getJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      examViewPrefsV1Schema,
    )
    expect(result).toEqual({ version: 1, view: 'table' })
  })

  // case 2: 不正 JSON (壊れた string) → undefined
  it('不正 JSON は undefined を返す', async () => {
    await getClientDb().sync_meta.put({
      key: SYNC_META_KEYS.examViewPrefs,
      value: 'not-a-json-{{{',
    })
    const result = await getJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      examViewPrefsV1Schema,
    )
    expect(result).toBeUndefined()
  })

  // case 3: schema mismatch → undefined (3a: version mismatch / 3b: view mismatch)
  it('schema mismatch (version: 2) は undefined を返す', async () => {
    await getClientDb().sync_meta.put({
      key: SYNC_META_KEYS.examViewPrefs,
      value: JSON.stringify({ version: 2, view: 'table' }),
    })
    const result = await getJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      examViewPrefsV1Schema,
    )
    expect(result).toBeUndefined()
  })

  it('schema mismatch (view: kanban) は undefined を返す', async () => {
    await getClientDb().sync_meta.put({
      key: SYNC_META_KEYS.examViewPrefs,
      value: JSON.stringify({ version: 1, view: 'kanban' }),
    })
    const result = await getJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      examViewPrefsV1Schema,
    )
    expect(result).toBeUndefined()
  })

  // case 4: key 欠損 (table empty) → undefined
  it('key 欠損は undefined を返す', async () => {
    // beforeEach で clear 済のため table は空
    const result = await getJsonSyncMeta(
      SYNC_META_KEYS.examViewPrefs,
      examViewPrefsV1Schema,
    )
    expect(result).toBeUndefined()
  })

  // 追加: setJsonSyncMeta に invalid value を渡すと throw する
  it('setJsonSyncMeta に invalid value を渡すと throw する', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invalidValue = { version: 2, view: 'kanban' } as any
    await expect(
      setJsonSyncMeta(
        SYNC_META_KEYS.examViewPrefs,
        invalidValue,
        examViewPrefsV1Schema,
      ),
    ).rejects.toThrow()
  })
})
