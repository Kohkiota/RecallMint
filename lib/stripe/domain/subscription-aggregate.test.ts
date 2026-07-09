import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'
import {
  projectStripeSnapshot,
  applyDeleted,
  reserveDowngrade,
  clearReservation,
  canChangePlan,
  evaluateRelease,
} from './subscription-aggregate'
import type { PendingState } from '@/lib/stripe/subscription-changes'
import type { ScheduledChange } from '@/lib/stripe/domain/subscription-values'

// Stripe.Subscription の最小 stub。 aggregate は items.data[0].price.id /
// items.data[0].current_period_end / cancel_at / status / id / schedule のみ触る。
function sub(over: {
  status?: Stripe.Subscription.Status
  priceId?: string | null
  currentPeriodEnd?: number | undefined
  cancelAt?: number | null
  id?: string
  schedule?: string | { id: string } | null
  emptyItems?: boolean
}): Stripe.Subscription {
  const {
    status = 'active',
    priceId = 'price_std_month',
    currentPeriodEnd = 1_800_000_000,
    cancelAt = null,
    id = 'sub_test',
    schedule = null,
    emptyItems = false,
  } = over
  const item = {
    price: priceId === null ? null : { id: priceId },
    current_period_end: currentPeriodEnd,
  }
  return {
    id,
    status,
    cancel_at: cancelAt,
    schedule,
    items: { data: emptyItems ? [] : [item] },
  } as unknown as Stripe.Subscription
}

describe('projectStripeSnapshot', () => {
  it('sub + derived から 6 列を整形する (status=normalizeSubStatus / subId=sub.id)', () => {
    const result = projectStripeSnapshot(
      sub({ status: 'active', currentPeriodEnd: 1_800_000_000, cancelAt: null, id: 'sub_abc' }),
      { plan: 'standard', billingInterval: 'month' },
    )
    expect(result).toEqual({
      plan: 'standard',
      billingInterval: 'month',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(1_800_000_000 * 1000),
      cancelAt: null,
      stripeSubscriptionId: 'sub_abc',
    })
  })

  it('trialing → active に正規化 (normalizeSubStatus 経由)', () => {
    const result = projectStripeSnapshot(sub({ status: 'trialing' }), {
      plan: 'pro',
      billingInterval: 'year',
    })
    expect(result.subscriptionStatus).toBe('active')
    expect(result.plan).toBe('pro')
    expect(result.billingInterval).toBe('year')
  })

  it('past_due / canceled 正規化', () => {
    expect(
      projectStripeSnapshot(sub({ status: 'unpaid' }), { plan: 'free', billingInterval: null })
        .subscriptionStatus,
    ).toBe('past_due')
    expect(
      projectStripeSnapshot(sub({ status: 'canceled' }), { plan: 'free', billingInterval: null })
        .subscriptionStatus,
    ).toBe('canceled')
  })

  it('cancel_at が数値なら Date、null なら null', () => {
    expect(projectStripeSnapshot(sub({ cancelAt: 1_700_000_000 }), {
      plan: 'standard',
      billingInterval: 'month',
    }).cancelAt).toEqual(new Date(1_700_000_000 * 1000))
    expect(
      projectStripeSnapshot(sub({ cancelAt: null }), { plan: 'standard', billingInterval: 'month' })
        .cancelAt,
    ).toBeNull()
  })

  it('current_period_end 欠落 (item なし) は currentPeriodEnd=null', () => {
    const result = projectStripeSnapshot(sub({ emptyItems: true }), {
      plan: 'free',
      billingInterval: null,
    })
    expect(result.currentPeriodEnd).toBeNull()
  })
})

describe('applyDeleted', () => {
  it('8 列を reset 値で返す', () => {
    expect(applyDeleted()).toEqual({
      plan: 'free',
      billingInterval: null,
      subscriptionStatus: 'canceled',
      cancelAt: null,
      stripeSubscriptionId: null,
      scheduledDowngradeScheduleId: null,
      scheduledTargetPriceId: null,
      scheduledChangeEffectiveAt: null,
    })
  })

  it('currentPeriodEnd を含まない (現行非更新)', () => {
    expect('currentPeriodEnd' in applyDeleted()).toBe(false)
  })
})

describe('reserveDowngrade / clearReservation', () => {
  it('reserveDowngrade は 3 列を change から set', () => {
    const change: NonNullable<ScheduledChange> = {
      scheduleId: 'sched_1',
      targetPriceId: 'price_target',
      effectiveAt: new Date('2026-01-01T00:00:00Z'),
    }
    expect(reserveDowngrade(change)).toEqual({
      scheduledDowngradeScheduleId: 'sched_1',
      scheduledTargetPriceId: 'price_target',
      scheduledChangeEffectiveAt: new Date('2026-01-01T00:00:00Z'),
    })
  })

  it('clearReservation は 3 列 null', () => {
    expect(clearReservation()).toEqual({
      scheduledDowngradeScheduleId: null,
      scheduledTargetPriceId: null,
      scheduledChangeEffectiveAt: null,
    })
  })
})

describe('canChangePlan', () => {
  const base: PendingState = {
    hasPendingUpdate: false,
    scheduleId: null,
    cancelScheduled: false,
  }

  it('全 false + dbScheduleId null → ok', () => {
    expect(canChangePlan(base, null)).toEqual({ ok: true })
  })

  it('hasPendingUpdate=true → CHANGE_BLOCKED', () => {
    expect(canChangePlan({ ...base, hasPendingUpdate: true }, null)).toEqual({
      ok: false,
      reason: 'CHANGE_BLOCKED',
    })
  })

  it('dbScheduleId != null → CHANGE_BLOCKED', () => {
    expect(canChangePlan(base, 'sched_x')).toEqual({
      ok: false,
      reason: 'CHANGE_BLOCKED',
    })
  })

  it('cancelScheduled=true → CHANGE_BLOCKED', () => {
    expect(canChangePlan({ ...base, cancelScheduled: true }, null)).toEqual({
      ok: false,
      reason: 'CHANGE_BLOCKED',
    })
  })
})

describe('evaluateRelease (4 値網羅)', () => {
  it('subScheduleId == null → clear_direct (方向2 保険)', () => {
    expect(
      evaluateRelease({
        subScheduleId: null,
        dbScheduleId: 'sched_1',
        priceId: 'price_target',
        dbTargetPriceId: 'price_target',
      }),
    ).toBe('clear_direct')
  })

  it('subScheduleId !== dbScheduleId → mismatch', () => {
    expect(
      evaluateRelease({
        subScheduleId: 'sched_other',
        dbScheduleId: 'sched_1',
        priceId: 'price_target',
        dbTargetPriceId: 'price_target',
      }),
    ).toBe('mismatch')
  })

  it('id 一致 + price 不一致 → skip (予約維持)', () => {
    expect(
      evaluateRelease({
        subScheduleId: 'sched_1',
        dbScheduleId: 'sched_1',
        priceId: 'price_phase0',
        dbTargetPriceId: 'price_target',
      }),
    ).toBe('skip')
  })

  it('id 一致 + price 一致 → delegate', () => {
    expect(
      evaluateRelease({
        subScheduleId: 'sched_1',
        dbScheduleId: 'sched_1',
        priceId: 'price_target',
        dbTargetPriceId: 'price_target',
      }),
    ).toBe('delegate')
  })

  it('境界: priceId=null と dbTargetPriceId=null が一致すれば delegate', () => {
    expect(
      evaluateRelease({
        subScheduleId: 'sched_1',
        dbScheduleId: 'sched_1',
        priceId: null,
        dbTargetPriceId: null,
      }),
    ).toBe('delegate')
  })

  it('境界: priceId=null と dbTargetPriceId 非 null は skip', () => {
    expect(
      evaluateRelease({
        subScheduleId: 'sched_1',
        dbScheduleId: 'sched_1',
        priceId: null,
        dbTargetPriceId: 'price_target',
      }),
    ).toBe('skip')
  })
})
