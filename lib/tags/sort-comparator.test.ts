// lib/tags/sort-comparator.ts の数値比較版 sortByKeyThenCreated のユニットテスト。
// Tag-4c-2b T1.5 で旧 `card-tag-add-popover.test.tsx` の `describe('sortByKeyThenCreated', …)`
// を本 file に移転 (popover ローカル定義の共有 module 化に伴う引っ越し)。 引き続き既存ケース
// (sort_key 一方 null / 両 null tiebreak / 同 sort_key tiebreak) を pass させ、 数値比較化に
// 伴う新規ケース (0..12 数値順 / 非数値 NaN 末尾) を追加する。

import { describe, it, expect } from 'vitest'

import { sortByKeyThenCreated, compareTagEntry } from './sort-comparator'

// flicker 防止依存: drop 後 useLiveQuery 再ソート順が arrayMove 順と一致する不変条件は
// 本 comparator の数値比較に依存 (spec §4.6 末尾節)。 旧 string `<` 比較なら N≥10 で順序が
// 入れ替わる flicker が露出する。
describe('sortByKeyThenCreated', () => {
  type Item = { sort_key: string | null; created_at: string }
  const mk = (sort_key: string | null, created_at: string): Item => ({ sort_key, created_at })

  // 旧 popover test 移転分 (Fix C-3 既存ケース)
  it('両方 sort_key 非 null: sort_key 数値昇順で並ぶ', () => {
    // 旧テストは 'a' / 'b' で string 比較を pin していたが、 数値比較化により非数値同士は
    // NaN 末尾扱い → created_at tiebreak になる。 ここは数値文字列に置換して数値順を assert。
    const a = mk('2', '2026-01-01T00:00:00.000Z')
    const b = mk('1', '2026-01-01T00:00:00.000Z')
    expect(sortByKeyThenCreated(a, b)).toBeGreaterThan(0) // a(2) > b(1) → b first
    expect(sortByKeyThenCreated(b, a)).toBeLessThan(0) // b(1) < a(2)
  })

  it('sort_key null は末尾 (NULLS LAST): non-null が先', () => {
    const withKey = mk('1', '2026-01-01T00:00:00.000Z')
    const withoutKey = mk(null, '2025-01-01T00:00:00.000Z') // 古い created_at でも後
    expect(sortByKeyThenCreated(withKey, withoutKey)).toBeLessThan(0)
    expect(sortByKeyThenCreated(withoutKey, withKey)).toBeGreaterThan(0)
  })

  it('両方 sort_key null: created_at ASC でタイブレーク', () => {
    const older = mk(null, '2026-01-01T00:00:00.000Z')
    const newer = mk(null, '2026-12-31T00:00:00.000Z')
    expect(sortByKeyThenCreated(older, newer)).toBeLessThan(0)
    expect(sortByKeyThenCreated(newer, older)).toBeGreaterThan(0)
  })

  it('同 sort_key + 同 created_at → 0 (等価)', () => {
    const a = mk('1', '2026-06-01T00:00:00.000Z')
    const b = mk('1', '2026-06-01T00:00:00.000Z')
    expect(sortByKeyThenCreated(a, b)).toBe(0)
  })

  it('同 sort_key (両方 null): created_at 同一なら 0 (等価)', () => {
    const a = mk(null, '2026-06-01T00:00:00.000Z')
    const b = mk(null, '2026-06-01T00:00:00.000Z')
    expect(sortByKeyThenCreated(a, b)).toBe(0)
  })

  // Tag-4c-2b §4.6 新規必須: 13 件 ('0'..'12') 数値順 regression。
  // 旧 string `<` 比較なら ['0','1','10','11','12','2','3','4','5','6','7','8','9'] と並ぶ。
  // 数値比較化により ['0','1','2',…,'12'] の自然順になることを assert する。
  it('sort_key 0..12 の 13 件: 数値順 (0,1,2,…,12) で並ぶ (旧 string 比較 regression 検出)', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const inputKeys = ['12', '7', '0', '10', '3', '1', '11', '2', '8', '4', '5', '9', '6']
    const items = inputKeys.map((k) => mk(k, createdAt))
    const sortedKeys = [...items].sort(sortByKeyThenCreated).map((x) => x.sort_key)
    expect(sortedKeys).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    // 旧 string `<` 比較の失敗形 (regression 検出用に明示):
    const oldStringSorted = ['0', '1', '10', '11', '12', '2', '3', '4', '5', '6', '7', '8', '9']
    expect(sortedKeys).not.toEqual(oldStringSorted)
  })

  // 非数値 (defensive): 'abc' などは NaN 末尾扱い、 有効数値より後ろ。
  it('非数値 sort_key (abc) は NaN 末尾扱い: 有効数値より後ろ', () => {
    const numeric = mk('5', '2026-01-01T00:00:00.000Z')
    const nonNumeric = mk('abc', '2025-01-01T00:00:00.000Z') // 古くても後ろ
    expect(sortByKeyThenCreated(numeric, nonNumeric)).toBeLessThan(0)
    expect(sortByKeyThenCreated(nonNumeric, numeric)).toBeGreaterThan(0)
  })

  it('両方 非数値 (abc + xyz): created_at ASC でタイブレーク', () => {
    const older = mk('abc', '2026-01-01T00:00:00.000Z')
    const newer = mk('xyz', '2026-12-31T00:00:00.000Z')
    expect(sortByKeyThenCreated(older, newer)).toBeLessThan(0)
    expect(sortByKeyThenCreated(newer, older)).toBeGreaterThan(0)
  })

  it('空文字列 sort_key は NaN 末尾扱い (Number("") === 0 を踏まない)', () => {
    const numericZero = mk('0', '2026-01-01T00:00:00.000Z')
    const emptyString = mk('', '2025-01-01T00:00:00.000Z')
    // '0' が先 (NaN 末尾)。 もし '' が NaN 化されず 0 として扱われると tiebreak で
    // 古い created_at の emptyString が先になってしまう → 順序が崩れる。
    expect(sortByKeyThenCreated(numericZero, emptyString)).toBeLessThan(0)
  })

  it('undefined sort_key も末尾扱い (Number(undefined) === NaN を経由)', () => {
    type ItemUndef = { sort_key?: string | null; created_at: string }
    const withKey: ItemUndef = { sort_key: '5', created_at: '2026-01-01T00:00:00.000Z' }
    const undef: ItemUndef = { created_at: '2025-01-01T00:00:00.000Z' } // sort_key omitted
    expect(sortByKeyThenCreated(withKey, undef)).toBeLessThan(0)
    expect(sortByKeyThenCreated(undef, withKey)).toBeGreaterThan(0)
  })
})

describe('compareTagEntry', () => {
  type Cat = { sort_key: string | null; created_at: string }
  type Opt = { sort_key: string | null; created_at: string }
  const mkEntry = (
    catKey: string | null,
    catCreated: string,
    optKey: string | null,
    optCreated: string,
  ): { category: Cat; option: Opt } => ({
    category: { sort_key: catKey, created_at: catCreated },
    option: { sort_key: optKey, created_at: optCreated },
  })

  it('category sort_key が異なる → category 順が勝つ (option 無関係)', () => {
    // category '1' vs '2' → a(cat=1) が先 (result < 0)
    const a = mkEntry('1', '2026-01-01T00:00:00.000Z', '9', '2026-01-01T00:00:00.000Z')
    const b = mkEntry('2', '2026-01-01T00:00:00.000Z', '1', '2026-01-01T00:00:00.000Z')
    expect(compareTagEntry(a, b)).toBeLessThan(0)
    expect(compareTagEntry(b, a)).toBeGreaterThan(0)
  })

  it('category sort_key が等しい → option sort_key でタイブレーク', () => {
    const a = mkEntry('1', '2026-01-01T00:00:00.000Z', '1', '2026-01-01T00:00:00.000Z')
    const b = mkEntry('1', '2026-01-01T00:00:00.000Z', '2', '2026-01-01T00:00:00.000Z')
    expect(compareTagEntry(a, b)).toBeLessThan(0)
    expect(compareTagEntry(b, a)).toBeGreaterThan(0)
  })

  it('category・option sort_key 両方等しい → option created_at ASC でタイブレーク', () => {
    const a = mkEntry('1', '2026-01-01T00:00:00.000Z', '1', '2026-01-01T00:00:00.000Z')
    const b = mkEntry('1', '2026-01-01T00:00:00.000Z', '1', '2026-12-31T00:00:00.000Z')
    // a.option.created_at < b.option.created_at → a が先
    expect(compareTagEntry(a, b)).toBeLessThan(0)
    expect(compareTagEntry(b, a)).toBeGreaterThan(0)
  })

  it('完全等価 (両 sort_key 同 + 両 created_at 同) → 0', () => {
    const a = mkEntry('1', '2026-06-01T00:00:00.000Z', '1', '2026-06-01T00:00:00.000Z')
    const b = mkEntry('1', '2026-06-01T00:00:00.000Z', '1', '2026-06-01T00:00:00.000Z')
    expect(compareTagEntry(a, b)).toBe(0)
  })
})
