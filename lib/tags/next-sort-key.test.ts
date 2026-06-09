import { describe, it, expect } from 'vitest'

import { nextSortKey } from './next-sort-key'

// Tag-4c-2b §4.7 / plan T2.7 完了条件:
// - 起点 '0' (0-based): reindex 値域 '0'..'N-1' および sort-comparator 不変条件と整合
// - 母数 = 有効数値のみ (null / undefined / '' / 非数値文字列は除外)
// - 有効数値があれば max(Number) + 1 を整数文字列で返す (string 比較 '10' < '2' を踏まない)
// - 戻り値は常に整数文字列 (TEXT 列契約)

describe('nextSortKey', () => {
  it('(a) 空集合 → "0"', () => {
    expect(nextSortKey([])).toBe('0')
  })

  it('(b) null + undefined のみ → "0" (有効数値ゼロ → 起点)', () => {
    expect(nextSortKey([null, undefined, null])).toBe('0')
  })

  it('(c) 既存数値列 ["0","1","2"] → "3" (max+1)', () => {
    expect(nextSortKey(['0', '1', '2'])).toBe('3')
  })

  it('(d) 非数値混在 ["1","abc","3"] → "4" (abc 無視、 数値 max+1)', () => {
    expect(nextSortKey(['1', 'abc', '3'])).toBe('4')
  })

  it('(e) 全非数値 ["abc",""] → "0" (有効数値ゼロ → 起点、 空文字も母数除外)', () => {
    expect(nextSortKey(['abc', ''])).toBe('0')
  })

  it('(f) 大値 ["10","2"] → "11" (数値比較で max、 string 比較 "2" > "10" を踏まない)', () => {
    expect(nextSortKey(['10', '2'])).toBe('11')
  })

  it('null / 数値 / 非数値 混在でも数値のみで max+1', () => {
    // 追加 defensive: '1' + null + '5' → '6' (popover 旧テストと整合する境界)
    expect(nextSortKey(['1', null, '5'])).toBe('6')
  })

  it('戻り値は常に string (TEXT 列契約)', () => {
    expect(typeof nextSortKey([])).toBe('string')
    expect(typeof nextSortKey(['0', '1', '2'])).toBe('string')
  })
})
