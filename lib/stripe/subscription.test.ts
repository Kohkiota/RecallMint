import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'

// --- hoisted Stripe mock (route.test.ts と同 vi.mock 方式、実 API 禁止) ---
const {
  mockRetrieve,
  mockList,
  mockUpdate,
  mockScheduleCreate,
  mockScheduleUpdate,
  mockScheduleRelease,
} = vi.hoisted(() => ({
  mockRetrieve: vi.fn(),
  mockList: vi.fn(),
  mockUpdate: vi.fn(),
  mockScheduleCreate: vi.fn(),
  mockScheduleUpdate: vi.fn(),
  mockScheduleRelease: vi.fn(),
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: mockRetrieve,
      list: mockList,
      update: mockUpdate,
    },
    subscriptionSchedules: {
      create: mockScheduleCreate,
      update: mockScheduleUpdate,
      release: mockScheduleRelease,
    },
  },
}))

import {
  classifyChange,
  getPendingState,
  resolveActiveSubscription,
  applyUpgrade,
  scheduleDowngrade,
  cancelScheduledDowngrade,
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

// ---------------------------------------------------------------------------
// Stripe API 呼出関数群 (Task 3)
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
})

// helper: active subscription の最小 mock (customer は string / object 両対応)
function makeRetrieveSub(opts: {
  status?: Stripe.Subscription.Status
  customer?: string | { id: string }
  itemId?: string
  priceId?: string
}): Stripe.Subscription {
  return {
    id: 'sub_test',
    status: opts.status ?? 'active',
    customer: opts.customer ?? 'cus_test',
    items: {
      data: [{ id: opts.itemId ?? 'si_test', price: { id: opts.priceId ?? 'price_cur' } }],
    },
  } as unknown as Stripe.Subscription
}

describe('resolveActiveSubscription', () => {
  describe('stripeSubscriptionId 有り', () => {
    it('(a) status active + customer 一致 (string) → { sub, itemId }', async () => {
      mockRetrieve.mockResolvedValueOnce(
        makeRetrieveSub({ status: 'active', customer: 'cus_1', itemId: 'si_1' }),
      )
      const result = await resolveActiveSubscription({
        stripeSubscriptionId: 'sub_1',
        stripeCustomerId: 'cus_1',
      })
      expect(mockRetrieve).toHaveBeenCalledWith('sub_1')
      expect(result.itemId).toBe('si_1')
      expect(result.sub.id).toBe('sub_test')
    })

    it('(a2) customer が object {id} でも一致すれば OK', async () => {
      mockRetrieve.mockResolvedValueOnce(
        makeRetrieveSub({ status: 'trialing', customer: { id: 'cus_obj' }, itemId: 'si_obj' }),
      )
      const result = await resolveActiveSubscription({
        stripeSubscriptionId: 'sub_obj',
        stripeCustomerId: 'cus_obj',
      })
      expect(result.itemId).toBe('si_obj')
    })

    it('status past_due でも採用される', async () => {
      mockRetrieve.mockResolvedValueOnce(
        makeRetrieveSub({ status: 'past_due', customer: 'cus_pd' }),
      )
      const result = await resolveActiveSubscription({
        stripeSubscriptionId: 'sub_pd',
        stripeCustomerId: 'cus_pd',
      })
      expect(result.sub.status).toBe('past_due')
    })

    it('(b) customer 不一致 → AmbiguousSubscriptionError', async () => {
      mockRetrieve.mockResolvedValueOnce(
        makeRetrieveSub({ status: 'active', customer: 'cus_other' }),
      )
      await expect(
        resolveActiveSubscription({
          stripeSubscriptionId: 'sub_x',
          stripeCustomerId: 'cus_mine',
        }),
      ).rejects.toThrow(AmbiguousSubscriptionError)
    })

    it('(c) status canceled → AmbiguousSubscriptionError', async () => {
      mockRetrieve.mockResolvedValueOnce(
        makeRetrieveSub({ status: 'canceled', customer: 'cus_c' }),
      )
      await expect(
        resolveActiveSubscription({
          stripeSubscriptionId: 'sub_c',
          stripeCustomerId: 'cus_c',
        }),
      ).rejects.toThrow(AmbiguousSubscriptionError)
    })

    it('(h) items 空 → AmbiguousSubscriptionError', async () => {
      const subNoItems = {
        id: 'sub_noitem',
        status: 'active',
        customer: 'cus_ni',
        items: { data: [] },
      } as unknown as Stripe.Subscription
      mockRetrieve.mockResolvedValueOnce(subNoItems)
      await expect(
        resolveActiveSubscription({
          stripeSubscriptionId: 'sub_noitem',
          stripeCustomerId: 'cus_ni',
        }),
      ).rejects.toThrow(AmbiguousSubscriptionError)
    })
  })

  describe('stripeSubscriptionId 無し (fallback)', () => {
    it('(d) list 1 本 → 採用', async () => {
      mockList.mockResolvedValueOnce({
        data: [makeRetrieveSub({ customer: 'cus_f', itemId: 'si_f' })],
      })
      const result = await resolveActiveSubscription({
        stripeSubscriptionId: null,
        stripeCustomerId: 'cus_f',
      })
      expect(mockList).toHaveBeenCalledWith({ customer: 'cus_f', status: 'active' })
      expect(result.itemId).toBe('si_f')
    })

    it('(e) list 0 本 → NoSubscriptionError', async () => {
      mockList.mockResolvedValueOnce({ data: [] })
      await expect(
        resolveActiveSubscription({
          stripeSubscriptionId: null,
          stripeCustomerId: 'cus_e',
        }),
      ).rejects.toThrow(NoSubscriptionError)
    })

    it('(f) list 2 本以上 → AmbiguousSubscriptionError (自動選択しない)', async () => {
      mockList.mockResolvedValueOnce({
        data: [makeRetrieveSub({}), makeRetrieveSub({})],
      })
      await expect(
        resolveActiveSubscription({
          stripeSubscriptionId: null,
          stripeCustomerId: 'cus_2',
        }),
      ).rejects.toThrow(AmbiguousSubscriptionError)
    })

    it('(g) customerId も無し → NoSubscriptionError (list せず)', async () => {
      await expect(
        resolveActiveSubscription({
          stripeSubscriptionId: null,
          stripeCustomerId: null,
        }),
      ).rejects.toThrow(NoSubscriptionError)
      expect(mockList).not.toHaveBeenCalled()
    })
  })
})

describe('applyUpgrade', () => {
  it('update を items/proration_behavior/payment_behavior + idempotencyKey で呼ぶ', async () => {
    const returned = makeRetrieveSub({})
    mockUpdate.mockResolvedValueOnce(returned)

    const result = await applyUpgrade('sub_up', 'si_up', 'price_target', 'idem_up')

    expect(mockUpdate).toHaveBeenCalledWith(
      'sub_up',
      {
        items: [{ id: 'si_up', price: 'price_target' }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      },
      { idempotencyKey: 'idem_up' },
    )
    expect(result).toBe(returned)
  })
})

describe('scheduleDowngrade', () => {
  // from_subscription で作られた schedule の phase[0] (現請求期間)
  function makeCreatedSchedule(): Stripe.SubscriptionSchedule {
    return {
      id: 'sub_sched_1',
      phases: [
        {
          start_date: 1750000000,
          end_date: 1752592000,
          items: [{ price: 'price_cur', quantity: 1 }],
        },
      ],
    } as unknown as Stripe.SubscriptionSchedule
  }

  it('create=from_subscription、update=2 phase(現+次 none) end_behavior release、key は :create/:update で別', async () => {
    mockScheduleCreate.mockResolvedValueOnce(makeCreatedSchedule())
    const updated = { id: 'sub_sched_1' } as unknown as Stripe.SubscriptionSchedule
    mockScheduleUpdate.mockResolvedValueOnce(updated)

    const sub = makeRetrieveSub({ priceId: 'price_cur' })
    const result = await scheduleDowngrade(sub, 'price_next', 'idem_dn')

    // create: from_subscription + idempotencyKey ':create'
    expect(mockScheduleCreate).toHaveBeenCalledWith(
      { from_subscription: 'sub_test' },
      { idempotencyKey: 'idem_dn:create' },
    )

    // update: 2 phase + release + idempotencyKey ':update'
    expect(mockScheduleUpdate).toHaveBeenCalledWith(
      'sub_sched_1',
      {
        end_behavior: 'release',
        phases: [
          {
            start_date: 1750000000,
            end_date: 1752592000,
            items: [{ price: 'price_cur', quantity: 1 }],
          },
          {
            items: [{ price: 'price_next', quantity: 1 }],
            proration_behavior: 'none',
          },
        ],
      },
      { idempotencyKey: 'idem_dn:update' },
    )

    // create / update の idempotency key が別文字列であること
    const createKey = mockScheduleCreate.mock.calls[0][1].idempotencyKey
    const updateKey = mockScheduleUpdate.mock.calls[0][1].idempotencyKey
    expect(createKey).not.toBe(updateKey)

    expect(result).toBe(updated)
  })
})

describe('cancelScheduledDowngrade', () => {
  it('release を scheduleId + idempotencyKey で呼ぶ (cancel は使わない)', async () => {
    const released = { id: 'sub_sched_r' } as unknown as Stripe.SubscriptionSchedule
    mockScheduleRelease.mockResolvedValueOnce(released)

    const result = await cancelScheduledDowngrade('sub_sched_r', 'idem_rel')

    expect(mockScheduleRelease).toHaveBeenCalledWith(
      'sub_sched_r',
      {},
      { idempotencyKey: 'idem_rel' },
    )
    expect(result).toBe(released)
  })
})
