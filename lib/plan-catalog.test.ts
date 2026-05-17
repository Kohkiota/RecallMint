import { describe, it, expect } from 'vitest'
import {
  PAID_PLAN_CATALOG,
  FREE_PLAN,
  rankPlan,
  isUpgrade,
  planLabelFor,
  yearlyDiscountPercent,
  yearlyMonthlyEquivalent,
} from './plan-catalog'

describe('plan-catalog', () => {
  describe('PAID_PLAN_CATALOG values (2026-05-17 確定)', () => {
    it('Standard: ¥680/月、 ¥6,800/年', () => {
      expect(PAID_PLAN_CATALOG.standard.monthlyYen).toBe(680)
      expect(PAID_PLAN_CATALOG.standard.yearlyYen).toBe(6800)
    })

    it('Pro: ¥1,280/月、 ¥12,800/年', () => {
      expect(PAID_PLAN_CATALOG.pro.monthlyYen).toBe(1280)
      expect(PAID_PLAN_CATALOG.pro.yearlyYen).toBe(12800)
    })

    it('Free: ¥0', () => {
      expect(FREE_PLAN.monthlyYen).toBe(0)
    })
  })

  describe('rankPlan: upsell 順位', () => {
    it('free=0 < standard月=1 < standard年=2 < pro月=3 < pro年=4', () => {
      expect(rankPlan('free', null)).toBe(0)
      expect(rankPlan('standard', 'month')).toBe(1)
      expect(rankPlan('standard', 'year')).toBe(2)
      expect(rankPlan('pro', 'month')).toBe(3)
      expect(rankPlan('pro', 'year')).toBe(4)
    })

    it('paid plan で interval=null (transition window) は month 扱い', () => {
      expect(rankPlan('standard', null)).toBe(1)
      expect(rankPlan('pro', null)).toBe(3)
    })
  })

  describe('isUpgrade', () => {
    it('free → standard月: true', () => {
      expect(isUpgrade({ plan: 'free', interval: null }, { plan: 'standard', interval: 'month' })).toBe(true)
    })

    it('standard月 → standard年: true (cycle 切替も upgrade)', () => {
      expect(isUpgrade({ plan: 'standard', interval: 'month' }, { plan: 'standard', interval: 'year' })).toBe(true)
    })

    it('standard年 → pro月: true', () => {
      expect(isUpgrade({ plan: 'standard', interval: 'year' }, { plan: 'pro', interval: 'month' })).toBe(true)
    })

    it('pro月 → pro年: true (最後の upgrade path)', () => {
      expect(isUpgrade({ plan: 'pro', interval: 'month' }, { plan: 'pro', interval: 'year' })).toBe(true)
    })

    it('pro年 → 何でも: false (最上位)', () => {
      expect(isUpgrade({ plan: 'pro', interval: 'year' }, { plan: 'pro', interval: 'year' })).toBe(false)
      expect(isUpgrade({ plan: 'pro', interval: 'year' }, { plan: 'standard', interval: 'year' })).toBe(false)
    })

    it('同 rank: false (現在のプラン)', () => {
      expect(isUpgrade({ plan: 'standard', interval: 'month' }, { plan: 'standard', interval: 'month' })).toBe(false)
    })

    it('downgrade: false (pro月 → standard年 は実際 rank 下がる)', () => {
      expect(isUpgrade({ plan: 'pro', interval: 'month' }, { plan: 'standard', interval: 'year' })).toBe(false)
    })
  })

  describe('planLabelFor', () => {
    it('Free: "Free プラン"', () => {
      expect(planLabelFor('free', null)).toBe('Free プラン')
    })

    it('Standard 月額', () => {
      expect(planLabelFor('standard', 'month')).toBe('Standard プラン 月額')
    })

    it('Pro 年額', () => {
      expect(planLabelFor('pro', 'year')).toBe('Pro プラン 年額')
    })

    it('transition window: paid + interval=null → "(同期中)"', () => {
      expect(planLabelFor('standard', null)).toBe('Standard プラン (同期中)')
      expect(planLabelFor('pro', null)).toBe('Pro プラン (同期中)')
    })
  })

  describe('割引表示 helpers', () => {
    it('Standard 年額: 月比 17% off (8160-6800=1360 / 8160=16.67% → round 17)', () => {
      expect(yearlyDiscountPercent(680, 6800)).toBe(17)
    })

    it('Pro 年額: 月比 17% off (15360-12800=2560 / 15360=16.67% → round 17)', () => {
      expect(yearlyDiscountPercent(1280, 12800)).toBe(17)
    })

    it('yearlyMonthlyEquivalent: 端数切捨て', () => {
      expect(yearlyMonthlyEquivalent(6800)).toBe(566)
      expect(yearlyMonthlyEquivalent(12800)).toBe(1066)
    })
  })
})
