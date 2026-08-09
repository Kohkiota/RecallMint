import { describe, it, expect } from 'vitest'

import { selectSweepTargets, SWEEP_CUTOFF_MS, ALERT_AGE_MS } from './src-sweep'
import type { R2ObjectMeta } from './r2'

// 選定 pure 関数の test(②-4b spec §3.2/§3.3/§3.6・完了条件 ①〜④)。
// I/O なし(mock 不要) — entries を直接組み立てて渡すだけ。

const NOW_MS = Date.UTC(2026, 7, 9, 12, 0, 0) // 2026-08-09T12:00:00Z(固定 now)

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_A = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
const FILE_A = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
const KEY_A = `src/${USER_A}/${SESSION_A}/${FILE_A}.pdf`

const USER_B = 'dddddddd-dddd-4ddd-bddd-dddddddddddd'
const SESSION_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const FILE_B = 'ffffffff-ffff-4fff-9fff-ffffffffffff'
const KEY_B = `src/${USER_B}/${SESSION_B}/${FILE_B}.pdf`

function meta(key: string, lastModifiedMs: number): R2ObjectMeta {
  return { key, lastModifiedMs }
}

describe('selectSweepTargets — cutoff boundary (① age > cutoff, `>` 比較)', () => {
  it('age === cutoffMs ちょうどは候補外(patternMismatch にも入らない)', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([])
    expect(result.patternMismatch).toEqual([])
  })

  it('age === cutoffMs + 1ms は候補になる', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([
      { userId: USER_A, keys: [KEY_A], oldestMs: NOW_MS - SWEEP_CUTOFF_MS - 1 },
    ])
  })

  it('age === cutoffMs - 1ms(まだ新しい)は候補外', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS + 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([])
  })
})

describe('selectSweepTargets — pattern 不一致の分離(②)', () => {
  const oldMs = NOW_MS - SWEEP_CUTOFF_MS - 1 // 全 case で「age は十分古い」を固定し、判定差は key 形のみにする

  it('大文字 uuid は一致する(A6・正例)', () => {
    const upperUserId = USER_A.toUpperCase()
    const upperKey = `src/${upperUserId}/${SESSION_A.toUpperCase()}/${FILE_A.toUpperCase()}.pdf`
    const result = selectSweepTargets([meta(upperKey, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([])
    expect(result.candidates).toEqual([{ userId: upperUserId, keys: [upperKey], oldestMs: oldMs }])
  })

  it('.PDF(大文字拡張子)は不一致', () => {
    const key = `src/${USER_A}/${SESSION_A}/${FILE_A}.PDF`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
    expect(result.candidates).toEqual([])
  })

  it('セグメント欠落(2 個)は不一致', () => {
    const key = `src/${USER_A}/${FILE_A}.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('セグメント過多(4 個)は不一致', () => {
    const key = `src/${USER_A}/${SESSION_A}/${FILE_A}/extra.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('旧経路 users/{uuid}/src/... は不一致', () => {
    const key = `users/${USER_A}/src/${SESSION_A}/${FILE_A}.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('uuid 非形式(桁数違い)は不一致', () => {
    const key = `src/${USER_A}/${SESSION_A}/not-a-uuid.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })

  it('prefix が src/ でない場合は不一致', () => {
    const key = `other/${USER_A}/${SESSION_A}/${FILE_A}.pdf`
    const result = selectSweepTargets([meta(key, oldMs)], NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.patternMismatch).toEqual([key])
  })
})

describe('selectSweepTargets — user 別グルーピング + oldest 昇順(③)', () => {
  it('同一 user 内は keys にまとめ、oldestMs = 最古の lastModifiedMs', () => {
    const session2 = '12121212-1212-4121-8121-121212121212'
    const file2 = '13131313-1313-4131-8131-131313131313'
    const key2 = `src/${USER_A}/${session2}/${file2}.pdf`
    const oldestMs = NOW_MS - SWEEP_CUTOFF_MS - 5000
    const entries = [
      meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1), // 新しい方
      meta(key2, oldestMs), // 古い方
    ]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates).toEqual([
      { userId: USER_A, keys: [KEY_A, key2], oldestMs },
    ])
  })

  it('複数 user は oldestMs 昇順(最古候補を持つ user が先)', () => {
    const entries = [
      meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1_000), // user A: cutoff+1000ms 前 = 新しめ
      meta(KEY_B, NOW_MS - SWEEP_CUTOFF_MS - 9_000), // user B: cutoff+9000ms 前 = より古い
    ]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.candidates.map((c) => c.userId)).toEqual([USER_B, USER_A])
  })
})

describe('selectSweepTargets — overdue(④)', () => {
  it('age === ALERT_AGE_MS ちょうどは overdue でない', () => {
    const entries = [meta(KEY_A, NOW_MS - ALERT_AGE_MS)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toBeNull()
  })

  it('age === ALERT_AGE_MS + 1ms は overdue', () => {
    const entries = [meta(KEY_A, NOW_MS - ALERT_AGE_MS - 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).not.toBeNull()
    expect(result.overdue?.count).toBe(1)
    expect(result.overdue?.oldestKey).toBe(KEY_A)
  })

  it('0 件で null', () => {
    const entries = [meta(KEY_A, NOW_MS - SWEEP_CUTOFF_MS - 1)] // candidate だが overdue ではない
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toBeNull()
  })

  it('複数 overdue object から oldest を選定(count・oldestKey・oldestAgeHours)', () => {
    const olderMs = NOW_MS - ALERT_AGE_MS - 60 * 60 * 1000 // 73h 前
    const newerOverdueMs = NOW_MS - ALERT_AGE_MS - 1_000 // 72h ちょっと前
    const entries = [meta(KEY_A, newerOverdueMs), meta(KEY_B, olderMs)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toEqual({
      count: 2,
      oldestKey: KEY_B,
      oldestAgeHours: 73,
    })
  })

  it('pattern 不一致 key も overdue 判定の対象(listing snapshot 全体を見る)', () => {
    const mismatchKey = `other/${USER_A}/${SESSION_A}/${FILE_A}.pdf`
    const entries = [meta(mismatchKey, NOW_MS - ALERT_AGE_MS - 1)]
    const result = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    expect(result.overdue).toEqual({ count: 1, oldestKey: mismatchKey, oldestAgeHours: 72 })
  })

  it('cutoffMs を 15min に縮めても overdue 判定は不変(ALERT_AGE_MS 固定)', () => {
    const entries = [meta(KEY_A, NOW_MS - ALERT_AGE_MS - 1)]
    const defaultCutoffResult = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    const overrideCutoffResult = selectSweepTargets(entries, NOW_MS, 15 * 60 * 1000)
    expect(overrideCutoffResult.overdue).toEqual(defaultCutoffResult.overdue)
  })

  it('15min override 下でも 72h 未満の object は overdue にならない(閾値が cutoffMs へ横滑りしていないことの pin)', () => {
    // age = 2h: 既定 cutoff(6h)未満・15min override 超 — もし overdue 閾値が
    // ALERT_AGE_MS でなく cutoffMs 由来に化けていたら、override 側だけ
    // overdue が立ってしまう(non-null)。ALERT_AGE_MS(72h)には遠く及ばないため
    // 両方とも null が正しい。
    const entries = [meta(KEY_A, NOW_MS - 2 * 60 * 60 * 1000)]
    const defaultCutoffResult = selectSweepTargets(entries, NOW_MS, SWEEP_CUTOFF_MS)
    const overrideCutoffResult = selectSweepTargets(entries, NOW_MS, 15 * 60 * 1000)
    expect(defaultCutoffResult.overdue).toBeNull()
    expect(overrideCutoffResult.overdue).toBeNull()
  })
})
