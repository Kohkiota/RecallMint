import { describe, it, expect } from 'vitest'
import { PLAN_LIMITS, limitsFor } from './plan-limits'

describe('plan-limits', () => {
  it('PLAN_LIMITS.free.ocrPagesPerMonth === 30', () => {
    expect(PLAN_LIMITS.free.ocrPagesPerMonth).toBe(30)
  })

  it('PLAN_LIMITS.standard.ocrPagesPerMonth === 300', () => {
    expect(PLAN_LIMITS.standard.ocrPagesPerMonth).toBe(300)
  })

  it('PLAN_LIMITS.pro.ocrPagesPerMonth === null (公平利用)', () => {
    expect(PLAN_LIMITS.pro.ocrPagesPerMonth).toBeNull()
  })

  it('limitsFor("free").ocrPagesPerMonth === 30', () => {
    expect(limitsFor('free').ocrPagesPerMonth).toBe(30)
  })

  it('limitsFor("standard").ocrPagesPerMonth === 300', () => {
    expect(limitsFor('standard').ocrPagesPerMonth).toBe(300)
  })

  it('limitsFor("pro").ocrPagesPerMonth === null', () => {
    expect(limitsFor('pro').ocrPagesPerMonth).toBeNull()
  })

  it('Plan keys are exactly { free, standard, pro }', () => {
    const keys = Object.keys(PLAN_LIMITS).sort()
    expect(keys).toEqual(['free', 'pro', 'standard'])
  })
})
