import { describe, it, expect } from 'vitest'
import { hasCompletion, processingIds } from './exam-status-poll'

describe('processingIds', () => {
  it('processing の examId だけを Set で返す', () => {
    const ids = processingIds({ a: 'processing', b: 'failed', c: 'processing' })
    expect(ids).toEqual(new Set(['a', 'c']))
  })

  it('空 map → 空 Set', () => {
    expect(processingIds({})).toEqual(new Set())
  })

  it('failed のみ → 空 Set', () => {
    expect(processingIds({ a: 'failed' })).toEqual(new Set())
  })
})

describe('hasCompletion', () => {
  it('prev で processing だった id が next で消えていれば true (= completed)', () => {
    expect(hasCompletion(new Set(['a', 'b']), new Set(['a']))).toBe(true)
  })

  it('prev の id が next でも processing のまま → false', () => {
    expect(hasCompletion(new Set(['a']), new Set(['a']))).toBe(false)
  })

  it('next に新しい processing が増えただけ → false (完了ではない)', () => {
    expect(hasCompletion(new Set(['a']), new Set(['a', 'b']))).toBe(false)
  })

  it('prev で processing だった id が processing から外れた (failed 化) → true', () => {
    // failed になると nextProcessing 集合から外れるため completion 扱いになる。
    expect(hasCompletion(new Set(['a']), new Set())).toBe(true)
  })

  it('prev が空 → 常に false', () => {
    expect(hasCompletion(new Set(), new Set(['a']))).toBe(false)
  })
})
