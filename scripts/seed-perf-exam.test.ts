import { describe, it, expect } from 'vitest'
import {
  parseWithAnswersRatio,
  pickAnsweredCount,
  WITH_ANSWERS_DEFAULT_RATIO,
} from './seed-perf-exam'

describe('parseWithAnswersRatio', () => {
  it('undefined → undefined (機能オフ)', () => {
    expect(parseWithAnswersRatio(undefined)).toBeUndefined()
  })

  it('true → デフォルト ratio (0.5)', () => {
    expect(parseWithAnswersRatio(true)).toBe(WITH_ANSWERS_DEFAULT_RATIO)
    expect(parseWithAnswersRatio(true)).toBe(0.5)
  })

  it('"0.7" → 0.7', () => {
    expect(parseWithAnswersRatio('0.7')).toBe(0.7)
  })

  it('"0" → 0 (境界値: 0件 = 未回答のまま)', () => {
    expect(parseWithAnswersRatio('0')).toBe(0)
  })

  it('"1" → 1 (境界値: 全件回答済み)', () => {
    expect(parseWithAnswersRatio('1')).toBe(1)
  })

  it('"-0.1" → Error (範囲外)', () => {
    expect(() => parseWithAnswersRatio('-0.1')).toThrow()
  })

  it('"1.1" → Error (範囲外)', () => {
    expect(() => parseWithAnswersRatio('1.1')).toThrow()
  })

  it('"abc" → Error (非数値)', () => {
    expect(() => parseWithAnswersRatio('abc')).toThrow()
  })

  it('"" → Error (空文字は非数値扱い)', () => {
    expect(() => parseWithAnswersRatio('')).toThrow()
  })

  it('エラーメッセージに入力値を含む', () => {
    expect(() => parseWithAnswersRatio('bad')).toThrowError(/bad/)
  })
})

describe('pickAnsweredCount', () => {
  it('total=300, ratio=0.5 → 150', () => {
    expect(pickAnsweredCount(300, 0.5)).toBe(150)
  })

  it('total=300, ratio=0.7 → 210', () => {
    expect(pickAnsweredCount(300, 0.7)).toBe(210)
  })

  it('total=300, ratio=1 → 300 (全件)', () => {
    expect(pickAnsweredCount(300, 1)).toBe(300)
  })

  it('total=300, ratio=0 → 0 (0件)', () => {
    expect(pickAnsweredCount(300, 0)).toBe(0)
  })

  it('total=0 → 0', () => {
    expect(pickAnsweredCount(0, 0.5)).toBe(0)
  })

  it('total=1, ratio=0.5 → 1 (Math.round による四捨五入)', () => {
    // 1 * 0.5 = 0.5 → Math.round → 1
    expect(pickAnsweredCount(1, 0.5)).toBe(1)
  })

  it('total=3, ratio=0.33 → 1 (小数の切り捨て)', () => {
    // 3 * 0.33 = 0.99 → Math.round → 1
    expect(pickAnsweredCount(3, 0.33)).toBe(1)
  })
})
