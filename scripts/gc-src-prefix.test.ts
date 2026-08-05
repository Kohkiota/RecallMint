import { describe, it, expect, vi, beforeEach } from 'vitest'

// ②-4a S-5a: DI core (`runGcSrcPrefix`) の unit test。この script は
// gc-image-assets.ts / gc-abandoned-operations.ts の DI-deps-object 形式とは違い、
// r2 module(listObjects/deleteObject)を直接 import して使う(brief 指定: 唯一の
// 動作が「listing → 削除 → readback」で DI 抽象化の価値が薄い one-shot script)。
// テストは r2 module を vi.mock して呼び出しを検証する(実 R2 を叩かない)。

const { mockListObjects, mockDeleteObject } = vi.hoisted(() => ({
  mockListObjects: vi.fn(),
  mockDeleteObject: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => ({
  listObjects: mockListObjects,
  deleteObject: mockDeleteObject,
}))

import { runGcSrcPrefix, listingPrefix, parseUserFlag, SRC_KEY_PATTERN } from './gc-src-prefix'

const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SRC_KEY_1 = `users/${USER_ID}/src/doc1.pdf`
const SRC_KEY_2 = `users/${USER_ID}/src/doc2.pdf`
// 非一致 key の例(brief §③): crop/添付 asset(users/{uid}/{assetId}.webp)と、
// `src` を含むが `src/` セグメント境界ではない紛らわしい key。
const CROP_KEY = `users/${USER_ID}/11111111-1111-4111-8111-111111111111.webp`
const SRCFOO_KEY = `users/${USER_ID}/srcfoo/x`

beforeEach(() => {
  mockListObjects.mockReset()
  mockDeleteObject.mockReset()
})

describe('runGcSrcPrefix', () => {
  it('dry-run (execute:false, default) never calls deleteObject even when matching keys exist', async () => {
    mockListObjects.mockResolvedValueOnce([SRC_KEY_1, SRC_KEY_2])

    const summary = await runGcSrcPrefix({ execute: false })

    expect(summary).toEqual({ listed: 2, matched: 2, skipped: 0, deleted: 0, failed: 0 })
    expect(mockDeleteObject).not.toHaveBeenCalled()
    // dry-run は readback を行わない(削除していないので確認不要)= listing 1 回のみ。
    expect(mockListObjects).toHaveBeenCalledTimes(1)
  })

  it('non-matching keys mixed into the listing are not treated as delete candidates', async () => {
    mockListObjects
      .mockResolvedValueOnce([SRC_KEY_1, CROP_KEY, SRCFOO_KEY]) // initial listing
      .mockResolvedValueOnce([]) // readback after delete
    mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })

    const summary = await runGcSrcPrefix({ execute: true })

    expect(mockDeleteObject).toHaveBeenCalledTimes(1)
    expect(mockDeleteObject).toHaveBeenCalledWith(SRC_KEY_1)
    expect(summary).toEqual({ listed: 3, matched: 1, skipped: 2, deleted: 1, failed: 0 })
  })

  it('--execute deletes only the matching keys; empty readback resolves normally (maps to exit 0)', async () => {
    mockListObjects
      .mockResolvedValueOnce([SRC_KEY_1, SRC_KEY_2])
      .mockResolvedValueOnce([]) // readback: 0 remaining
    mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })

    await expect(runGcSrcPrefix({ execute: true })).resolves.toEqual({
      listed: 2,
      matched: 2,
      skipped: 0,
      deleted: 2,
      failed: 0,
    })
    expect(mockDeleteObject).toHaveBeenCalledTimes(2)
    expect(mockListObjects).toHaveBeenCalledTimes(2)
  })

  it('a readback that still finds a matching key rejects (maps to non-zero exit)', async () => {
    mockListObjects
      .mockResolvedValueOnce([SRC_KEY_1])
      .mockResolvedValueOnce([SRC_KEY_1]) // readback: still present (simulated stuck delete)
    mockDeleteObject.mockResolvedValue({ ok: true, status: 204 })

    await expect(runGcSrcPrefix({ execute: true })).rejects.toThrow(/remaining/)
  })

  it('a failed delete is counted and does not stop the run, but still causes rejection', async () => {
    mockListObjects
      .mockResolvedValueOnce([SRC_KEY_1, SRC_KEY_2])
      .mockResolvedValueOnce([SRC_KEY_2]) // readback: the failed one is still there
    mockDeleteObject
      .mockResolvedValueOnce({ ok: true, status: 204 }) // SRC_KEY_1 succeeds
      .mockResolvedValueOnce({ ok: false, status: 500 }) // SRC_KEY_2 fails

    await expect(runGcSrcPrefix({ execute: true })).rejects.toThrow()
    // both deletes were attempted (failure did not short-circuit the loop)
    expect(mockDeleteObject).toHaveBeenCalledTimes(2)
  })

  it('--user scopes the listing prefix to that user only', async () => {
    mockListObjects.mockResolvedValueOnce([])

    await runGcSrcPrefix({ execute: false, userId: USER_ID })

    expect(mockListObjects).toHaveBeenCalledWith(`users/${USER_ID}/src/`)
  })

  it('no --user lists the bucket-wide users/ prefix', async () => {
    mockListObjects.mockResolvedValueOnce([])

    await runGcSrcPrefix({ execute: false })

    expect(mockListObjects).toHaveBeenCalledWith('users/')
  })
})

describe('listingPrefix', () => {
  it('scopes to the user src/ prefix when userId is given', () => {
    expect(listingPrefix(USER_ID)).toBe(`users/${USER_ID}/src/`)
  })

  it('falls back to the bucket-wide users/ prefix when no userId is given', () => {
    expect(listingPrefix(undefined)).toBe('users/')
  })
})

describe('SRC_KEY_PATTERN', () => {
  it('matches source keys (users/{uuid}/src/...)', () => {
    expect(SRC_KEY_PATTERN.test(SRC_KEY_1)).toBe(true)
  })

  it('does not match crop/attachment asset keys (users/{uuid}/{assetId}.webp)', () => {
    expect(SRC_KEY_PATTERN.test(CROP_KEY)).toBe(false)
  })

  it('does not match a look-alike key that merely starts with "src" (no /src/ segment boundary)', () => {
    expect(SRC_KEY_PATTERN.test(SRCFOO_KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseUserFlag — gc-image-assets.ts / gc-abandoned-operations.ts と同一契約
// (意図的な重複・既存 script 群と同じ test 形)。
// ---------------------------------------------------------------------------
describe('parseUserFlag', () => {
  it('returns undefined when --user is absent (all-users run)', () => {
    expect(parseUserFlag(['--execute'])).toBeUndefined()
  })

  it('returns the value following --user', () => {
    expect(parseUserFlag(['--user', USER_ID])).toBe(USER_ID)
  })

  it('throws when --user has no following value', () => {
    expect(() => parseUserFlag(['--user'])).toThrow(/requires a userId value/)
  })

  it('throws when --user is immediately followed by another flag (missing value footgun)', () => {
    expect(() => parseUserFlag(['--user', '--execute'])).toThrow(/requires a userId value/)
  })
})
