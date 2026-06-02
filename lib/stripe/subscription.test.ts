import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'

import {
  classifyChange,
  getPendingState,
  NoSubscriptionError,
  AmbiguousSubscriptionError,
} from './subscription'

// ---------------------------------------------------------------------------
// classifyChange
// ---------------------------------------------------------------------------
// rank 付与方針 (lib/plan-catalog.ts rankPlan):
//   free=0, standard月=1, standard年=2, pro月=3, pro年=4
// ---------------------------------------------------------------------------
describe('classifyChange', () => {
  describe('upgrade: targetRank > currentRank', () => {
    it('standard月(1) → pro月(3) は upgrade', () => {
      expect(classifyChange(1, 3)).toBe('upgrade')
    })

    it('standard月(1) → standard年(2) 月→年 は upgrade', () => {
      expect(classifyChange(1, 2)).toBe('upgrade')
    })

    it('pro月(3) → pro年(4) は upgrade', () => {
      expect(classifyChange(3, 4)).toBe('upgrade')
    })

    it('free(0) → standard月(1) は upgrade', () => {
      expect(classifyChange(0, 1)).toBe('upgrade')
    })
  })

  describe('downgrade: targetRank < currentRank', () => {
    it('pro月(3) → standard月(1) は downgrade', () => {
      expect(classifyChange(3, 1)).toBe('downgrade')
    })

    it('standard年(2) → standard月(1) 年→月 は downgrade', () => {
      expect(classifyChange(2, 1)).toBe('downgrade')
    })

    it('pro年(4) → standard月(2) tier跨ぎ は downgrade', () => {
      expect(classifyChange(4, 2)).toBe('downgrade')
    })

    it('pro年(4) → free(0) は downgrade', () => {
      expect(classifyChange(4, 0)).toBe('downgrade')
    })
  })

  describe('same: targetRank === currentRank', () => {
    it('standard年(2) → standard年(2) は same', () => {
      expect(classifyChange(2, 2)).toBe('same')
    })

    it('free(0) → free(0) は same', () => {
      expect(classifyChange(0, 0)).toBe('same')
    })
  })
})

// ---------------------------------------------------------------------------
// getPendingState
// ---------------------------------------------------------------------------
// Stripe.Subscription の必要フィールドのみ部分 mock。 as unknown as
// Stripe.Subscription でキャスト (実装は純粋関数で呼出なし)。
// ---------------------------------------------------------------------------
describe('getPendingState', () => {
  function makeSub(
    overrides: Partial<{
      pending_update: object | null
      schedule: string | { id: string } | null
      cancel_at: number | null
      cancel_at_period_end: boolean
    }>,
  ): Stripe.Subscription {
    return {
      pending_update: null,
      schedule: null,
      cancel_at: null,
      cancel_at_period_end: false,
      ...overrides,
    } as unknown as Stripe.Subscription
  }

  describe('hasPendingUpdate', () => {
    it('pending_update が非 null → hasPendingUpdate=true', () => {
      const sub = makeSub({ pending_update: { billing_cycle_anchor: 'now' } })
      expect(getPendingState(sub).hasPendingUpdate).toBe(true)
    })

    it('pending_update が null → hasPendingUpdate=false', () => {
      const sub = makeSub({ pending_update: null })
      expect(getPendingState(sub).hasPendingUpdate).toBe(false)
    })
  })

  describe('scheduleId', () => {
    it('schedule が string id → scheduleId にその値', () => {
      const sub = makeSub({ schedule: 'sub_sched_abc123' })
      expect(getPendingState(sub).scheduleId).toBe('sub_sched_abc123')
    })

    it('schedule が展開 object → scheduleId に object.id', () => {
      const sub = makeSub({ schedule: { id: 'sub_sched_expanded' } })
      expect(getPendingState(sub).scheduleId).toBe('sub_sched_expanded')
    })

    it('schedule が null → scheduleId=null', () => {
      const sub = makeSub({ schedule: null })
      expect(getPendingState(sub).scheduleId).toBeNull()
    })
  })

  describe('cancelScheduled', () => {
    it('cancel_at が非 null → cancelScheduled=true', () => {
      const sub = makeSub({ cancel_at: 1750000000 })
      expect(getPendingState(sub).cancelScheduled).toBe(true)
    })

    it('cancel_at_period_end=true → cancelScheduled=true', () => {
      const sub = makeSub({ cancel_at_period_end: true })
      expect(getPendingState(sub).cancelScheduled).toBe(true)
    })

    it('どちらも偽 → cancelScheduled=false', () => {
      const sub = makeSub({ cancel_at: null, cancel_at_period_end: false })
      expect(getPendingState(sub).cancelScheduled).toBe(false)
    })
  })

  describe('複合パターン', () => {
    it('pending_update 有 + schedule string + cancel_at 有 の組合せ', () => {
      const sub = makeSub({
        pending_update: { billing_cycle_anchor: 'now' },
        schedule: 'sub_sched_xyz',
        cancel_at: 1750000000,
        cancel_at_period_end: false,
      })
      const result = getPendingState(sub)
      expect(result.hasPendingUpdate).toBe(true)
      expect(result.scheduleId).toBe('sub_sched_xyz')
      expect(result.cancelScheduled).toBe(true)
    })

    it('すべて false / null の組合せ', () => {
      const sub = makeSub({})
      const result = getPendingState(sub)
      expect(result.hasPendingUpdate).toBe(false)
      expect(result.scheduleId).toBeNull()
      expect(result.cancelScheduled).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// error 型
// ---------------------------------------------------------------------------
describe('NoSubscriptionError', () => {
  it('message を保持する', () => {
    const err = new NoSubscriptionError('active subscription not found')
    expect(err.message).toBe('active subscription not found')
  })

  it('instanceof Error', () => {
    expect(new NoSubscriptionError('x')).toBeInstanceOf(Error)
  })

  it('name が NoSubscriptionError', () => {
    expect(new NoSubscriptionError('x').name).toBe('NoSubscriptionError')
  })
})

describe('AmbiguousSubscriptionError', () => {
  it('message を保持する', () => {
    const err = new AmbiguousSubscriptionError('multiple active subscriptions')
    expect(err.message).toBe('multiple active subscriptions')
  })

  it('instanceof Error', () => {
    expect(new AmbiguousSubscriptionError('x')).toBeInstanceOf(Error)
  })

  it('name が AmbiguousSubscriptionError', () => {
    expect(new AmbiguousSubscriptionError('x').name).toBe('AmbiguousSubscriptionError')
  })
})
