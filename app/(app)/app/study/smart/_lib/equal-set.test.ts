// 集合一致 helper の unit test。 順序非依存 / 重複は 1 件扱い。

import { describe, it, expect } from 'vitest'
import { equalSet } from './equal-set'

describe('equalSet', () => {
  it('両方空なら true', () => {
    expect(equalSet([], [])).toBe(true)
  })

  it('1 要素一致', () => {
    expect(equalSet(['a'], ['a'])).toBe(true)
  })

  it('順序逆でも一致', () => {
    expect(equalSet(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(true)
  })

  it('部分一致 (不足) は false', () => {
    expect(equalSet(['a'], ['a', 'b'])).toBe(false)
  })

  it('余剰 (1 つ多い) は false', () => {
    expect(equalSet(['a', 'b', 'c'], ['a', 'b'])).toBe(false)
  })

  it('完全不一致は false', () => {
    expect(equalSet(['a', 'b'], ['c', 'd'])).toBe(false)
  })

  it('重複は 1 件扱い (Set 化)', () => {
    expect(equalSet(['a', 'a', 'b'], ['a', 'b'])).toBe(true)
    expect(equalSet(['a', 'a'], ['a'])).toBe(true)
  })

  it('片側空 / 片側非空は false', () => {
    expect(equalSet([], ['a'])).toBe(false)
    expect(equalSet(['a'], [])).toBe(false)
  })
})
