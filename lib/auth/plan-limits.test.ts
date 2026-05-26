import { describe, it, expect } from 'vitest'
import { PLAN_LIMITS, limitsFor, limitsForOrFree } from './plan-limits'

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

describe('limitsForOrFree (safe accessor)', () => {
  it('既知 plan は limitsFor と同値を返す', () => {
    expect(limitsForOrFree('free')).toEqual(PLAN_LIMITS.free)
    expect(limitsForOrFree('standard')).toEqual(PLAN_LIMITS.standard)
    expect(limitsForOrFree('pro')).toEqual(PLAN_LIMITS.pro)
  })

  it('plan = undefined → free にフォールバック (JWT claim 未浸透時の safety net)', () => {
    expect(limitsForOrFree(undefined)).toEqual(PLAN_LIMITS.free)
  })

  it('plan = null → free にフォールバック (publicMetadata 経由で null が漏れた場合)', () => {
    expect(limitsForOrFree(null)).toEqual(PLAN_LIMITS.free)
  })

  it('plan = 空文字 → free にフォールバック', () => {
    expect(limitsForOrFree('' as never)).toEqual(PLAN_LIMITS.free)
  })

  it('未知の plan 値 → free にフォールバック (DB 値の手動操作 / 旧 enum 名残対策)', () => {
    // 'gold' / 'enterprise' 等の PLAN_LIMITS にない値は安全側で free 扱い
    expect(limitsForOrFree('gold' as never)).toEqual(PLAN_LIMITS.free)
    expect(limitsForOrFree('pro_yearly' as never)).toEqual(PLAN_LIMITS.free)
  })

  it('返却 object は ocrPagesPerMonth プロパティを必ず持つ (`.ocrPagesPerMonth` access が undefined にならない)', () => {
    // 「PLAN_LIMITS[plan] が undefined を返してクラッシュ」 という症状を構造的に防ぐ
    // ことを assertion で固定する。
    const inputs = [undefined, null, '', 'gold', 'free'] as const
    for (const v of inputs) {
      const limits = limitsForOrFree(v as never)
      expect(limits).toBeDefined()
      expect('ocrPagesPerMonth' in limits).toBe(true)
    }
  })
})
