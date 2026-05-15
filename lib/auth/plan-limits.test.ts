import { describe, it, expect } from 'vitest'
import { PLAN_LIMITS, limitsFor } from './plan-limits'

describe('plan-limits', () => {
  it('PLAN_LIMITS.free equals { words: 100, aiGenPerDay: 10 }', () => {
    expect(PLAN_LIMITS.free).toEqual({ words: 100, aiGenPerDay: 10 })
  })

  it('PLAN_LIMITS.pro equals { words: 2000, aiGenPerDay: 100 }', () => {
    expect(PLAN_LIMITS.pro).toEqual({ words: 2000, aiGenPerDay: 100 })
  })

  it('limitsFor("free").words === 100', () => {
    expect(limitsFor('free').words).toBe(100)
  })

  it('limitsFor("pro").words === 2000', () => {
    expect(limitsFor('pro').words).toBe(2000)
  })
})
