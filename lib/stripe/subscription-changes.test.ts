import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'

import { classifyChange, getPendingState } from './subscription-changes'
import { rankPlan } from '@/lib/plan-catalog'
import type { Plan } from '@/lib/auth/plan-limits'
import type { BillingInterval } from '@/lib/stripe/price-mapping'

// ---------------------------------------------------------------------------
// F1 golden (Phase G): 現行挙動 pin。 classifyChange の全 rank matrix と
// getPendingState の cancel 合成 predicate / schedule 3 形 / hasPendingUpdate を
// characterization する。 期待値は現行実装から観測して固定 (仕様推測禁止)。
// ---------------------------------------------------------------------------

// rankPlan(plan, interval) の (plan, interval) → rank 一覧 (lib/plan-catalog.ts):
//   free/null=0 / standard月=1 / standard年=2 / pro月=3 / pro年=4
// rank 0-4 を再現するための代表 (plan, interval) 組。 matrix は rank 数値で回す。
const RANK_INPUTS: ReadonlyArray<{ plan: Plan; interval: BillingInterval | null }> = [
  { plan: 'free', interval: null }, // 0
  { plan: 'standard', interval: 'month' }, // 1
  { plan: 'standard', interval: 'year' }, // 2
  { plan: 'pro', interval: 'month' }, // 3
  { plan: 'pro', interval: 'year' }, // 4
]

describe('F1 golden: classifyChange 全 rank matrix (0-4 × 0-4)', () => {
  // rankPlan の rank 定義自体を先に pin (matrix の前提)。
  it('rankPlan の rank 定義が free=0 / standard月=1 / standard年=2 / pro月=3 / pro年=4', () => {
    expect(RANK_INPUTS.map((i) => rankPlan(i.plan, i.interval))).toEqual([0, 1, 2, 3, 4])
  })

  it('rank 増=upgrade / 減=downgrade / 同=same を 25 組すべてで満たす', () => {
    for (let current = 0; current <= 4; current++) {
      for (let target = 0; target <= 4; target++) {
        const expected =
          target > current ? 'upgrade' : target < current ? 'downgrade' : 'same'
        expect(classifyChange(current, target)).toBe(expected)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// getPendingState — cancel 合成 predicate 4 象限 + schedule 3 形 + hasPendingUpdate。
// Stripe.Subscription の必要フィールドのみ部分 mock (実装は純関数、呼出なし)。
// ---------------------------------------------------------------------------
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

describe('F1 golden: getPendingState cancelScheduled 合成 predicate 4 象限', () => {
  it('cancel_at のみ non-null → cancelScheduled=true', () => {
    expect(getPendingState(makeSub({ cancel_at: 1750000000 })).cancelScheduled).toBe(true)
  })

  it('cancel_at_period_end のみ true → cancelScheduled=true', () => {
    expect(getPendingState(makeSub({ cancel_at_period_end: true })).cancelScheduled).toBe(true)
  })

  it('両方 (cancel_at + cancel_at_period_end) → cancelScheduled=true', () => {
    expect(
      getPendingState(makeSub({ cancel_at: 1750000000, cancel_at_period_end: true }))
        .cancelScheduled,
    ).toBe(true)
  })

  it('どちらも無し (cancel_at=null + cancel_at_period_end=false) → cancelScheduled=false', () => {
    expect(
      getPendingState(makeSub({ cancel_at: null, cancel_at_period_end: false })).cancelScheduled,
    ).toBe(false)
  })
})

describe('F1 golden: getPendingState scheduleId 3 形 + hasPendingUpdate', () => {
  it('schedule=string id → scheduleId=その値', () => {
    expect(getPendingState(makeSub({ schedule: 'sub_sched_str' })).scheduleId).toBe(
      'sub_sched_str',
    )
  })

  it('schedule=展開 object → scheduleId=object.id', () => {
    expect(getPendingState(makeSub({ schedule: { id: 'sub_sched_obj' } })).scheduleId).toBe(
      'sub_sched_obj',
    )
  })

  it('schedule=null → scheduleId=null', () => {
    expect(getPendingState(makeSub({ schedule: null })).scheduleId).toBeNull()
  })

  it('pending_update 有 → hasPendingUpdate=true / 無 → false', () => {
    expect(
      getPendingState(makeSub({ pending_update: { billing_cycle_anchor: 'now' } }))
        .hasPendingUpdate,
    ).toBe(true)
    expect(getPendingState(makeSub({ pending_update: null })).hasPendingUpdate).toBe(false)
  })
})
