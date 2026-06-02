import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetCurrentUser,
  mockCheckoutCreate,
  mockResolveActiveSubscription,
  mockGetPendingState,
  mockApplyUpgrade,
  mockScheduleDowngrade,
  mockCancelScheduledDowngrade,
  mockNotifyOps,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockCheckoutCreate: vi.fn(),
  mockResolveActiveSubscription: vi.fn(),
  mockGetPendingState: vi.fn(),
  mockApplyUpgrade: vi.fn(),
  mockScheduleDowngrade: vi.fn(),
  mockCancelScheduledDowngrade: vi.fn(),
  mockNotifyOps: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    checkout: { sessions: { create: mockCheckoutCreate } },
  },
}))

// changePlan / cancelDowngrade は Task 2/3 の純ロジック + Stripe 呼出関数を
// orchestrate するだけ。これらは個別に test 済なので action 層では mock し、
// 「正しい引数で・正しい順序で・ブロック時は呼ばない」ことだけを検証する。
// error class は actual 実装を使い (instanceof 判定が action 側にある)、
// 関数群のみ mock 差し替えする。
vi.mock('@/lib/stripe/subscription', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/stripe/subscription')>()
  return {
    ...actual,
    resolveActiveSubscription: mockResolveActiveSubscription,
    getPendingState: mockGetPendingState,
    applyUpgrade: mockApplyUpgrade,
    scheduleDowngrade: mockScheduleDowngrade,
    cancelScheduledDowngrade: mockCancelScheduledDowngrade,
  }
})

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
}))

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    // Next.js の redirect は throw でフロー終了する semantics を持つので
    // test 側で同等の throw を投げて assert で捕捉する。
    throw new Error(`__REDIRECT__:${url}`)
  },
}))

import {
  createCheckoutSession,
  changePlan,
  cancelDowngrade,
} from './actions'
import {
  NoSubscriptionError,
  AmbiguousSubscriptionError,
} from '@/lib/stripe/subscription'

const baseUser = {
  id: 'u_1',
  clerkId: 'clerk_u_1',
  email: 'test@example.com',
  stripeCustomerId: null,
  plan: 'free' as const,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAt: null,
  billingInterval: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCurrentUser.mockResolvedValue(baseUser)
  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/test/abc' })
  // changePlan/cancelDowngrade のデフォルト happy-path 値。各 test で上書きする。
  mockResolveActiveSubscription.mockResolvedValue({
    sub: { id: 'sub_1' },
    itemId: 'si_1',
  })
  mockGetPendingState.mockReturnValue({
    hasPendingUpdate: false,
    scheduleId: null,
    cancelScheduled: false,
  })
  mockApplyUpgrade.mockResolvedValue({ id: 'sub_1' })
  mockScheduleDowngrade.mockResolvedValue({ id: 'sched_1' })
  mockCancelScheduledDowngrade.mockResolvedValue({ id: 'sched_1' })
  mockNotifyOps.mockResolvedValue(undefined)
})

// 有料契約者の baseUser (changePlan 系 test 用)。plan='pro'/month が現在プラン。
const paidUser = {
  ...baseUser,
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  plan: 'pro' as const,
  subscriptionStatus: 'active' as const,
  billingInterval: 'month' as const,
}

function changeFd(opts: {
  plan?: string
  interval?: string
  operationId?: string
}): FormData {
  const f = new FormData()
  if (opts.plan !== undefined) f.set('plan', opts.plan)
  if (opts.interval !== undefined) f.set('interval', opts.interval)
  if (opts.operationId !== undefined) f.set('operationId', opts.operationId)
  return f
}

function fd(plan: string, interval: string): FormData {
  const f = new FormData()
  f.set('plan', plan)
  f.set('interval', interval)
  return f
}

describe('createCheckoutSession: 4 種類 (plan × interval) を Stripe Checkout に渡す', () => {
  it('Standard monthly: STRIPE_PRICE_STANDARD_MONTHLY を渡し redirect', async () => {
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      /__REDIRECT__:https:\/\/checkout/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [
          { price: process.env.STRIPE_PRICE_STANDARD_MONTHLY, quantity: 1 },
        ],
      }),
    )
  })

  it('Standard yearly', async () => {
    await expect(createCheckoutSession(fd('standard', 'year'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          { price: process.env.STRIPE_PRICE_STANDARD_YEARLY, quantity: 1 },
        ],
      }),
    )
  })

  it('Pro monthly', async () => {
    await expect(createCheckoutSession(fd('pro', 'month'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          { price: process.env.STRIPE_PRICE_PRO_MONTHLY, quantity: 1 },
        ],
      }),
    )
  })

  it('Pro yearly', async () => {
    await expect(createCheckoutSession(fd('pro', 'year'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          { price: process.env.STRIPE_PRICE_PRO_YEARLY, quantity: 1 },
        ],
      }),
    )
  })
})

describe('createCheckoutSession: 不正入力 / 未同期 user 拒否', () => {
  it('plan が未対応値 (free / null / garbage) → throw、 Stripe 呼ばない', async () => {
    await expect(createCheckoutSession(fd('free', 'month'))).rejects.toThrow(/Invalid plan/)
    await expect(createCheckoutSession(fd('garbage', 'month'))).rejects.toThrow(/Invalid plan/)
    // null は FormData.set で文字列化されるため、 plan キー未設定で再現
    const fEmpty = new FormData()
    fEmpty.set('interval', 'month')
    await expect(createCheckoutSession(fEmpty)).rejects.toThrow(/Invalid plan/)

    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('interval が未対応値 (weekly / 空) → throw、 Stripe 呼ばない', async () => {
    await expect(createCheckoutSession(fd('standard', 'weekly'))).rejects.toThrow(
      /Invalid interval/,
    )
    const fEmpty = new FormData()
    fEmpty.set('plan', 'standard')
    await expect(createCheckoutSession(fEmpty)).rejects.toThrow(/Invalid interval/)

    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('getCurrentUser null (webhook race) → USER_NOT_SYNCED throw、 Stripe 呼ばない', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      'USER_NOT_SYNCED',
    )
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('stripeCustomerId 既存時: customer を渡し customer_email は undefined', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({
      ...baseUser,
      stripeCustomerId: 'cus_existing',
    })
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
        customer_email: undefined,
      }),
    )
  })
})

describe('changePlan: in-place アップグレード / ダウングレード', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(paidUser)
  })

  it('upgrade 経路: applyUpgrade(subId,itemId,targetPrice,key) + /app?billing=upgrade redirect', async () => {
    // 現プラン pro/month (rank 3) → pro/year (rank 4) = upgrade
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_abc' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')

    expect(mockApplyUpgrade).toHaveBeenCalledWith(
      'sub_1',
      'si_1',
      process.env.STRIPE_PRICE_PRO_YEARLY,
      'changePlan:u_1:op_abc',
    )
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
  })

  it('downgrade 経路: scheduleDowngrade(sub,targetPrice,key) + /app?billing=downgrade redirect', async () => {
    // 現プラン pro/month (rank 3) → standard/month (rank 1) = downgrade
    await expect(
      changePlan(changeFd({ plan: 'standard', interval: 'month', operationId: 'op_def' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=downgrade')

    expect(mockScheduleDowngrade).toHaveBeenCalledWith(
      { id: 'sub_1' },
      process.env.STRIPE_PRICE_STANDARD_MONTHLY,
      'changePlan:u_1:op_def',
    )
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
  })

  it('hasPendingUpdate → CHANGE_BLOCKED、apply/schedule 未呼出', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: true,
      scheduleId: null,
      cancelScheduled: false,
    })
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('CHANGE_BLOCKED')
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
  })

  it('scheduleId 有 → CHANGE_BLOCKED、apply/schedule 未呼出', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_x',
      cancelScheduled: false,
    })
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('CHANGE_BLOCKED')
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
  })

  it('cancelScheduled → CHANGE_BLOCKED、apply/schedule 未呼出', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: null,
      cancelScheduled: true,
    })
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('CHANGE_BLOCKED')
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
  })

  it('same rank → NO_CHANGE throw、apply/schedule 未呼出', async () => {
    // 現プラン pro/month → pro/month = same
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'month', operationId: 'op_1' })),
    ).rejects.toThrow('NO_CHANGE')
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
  })

  it('resolve が NoSubscriptionError → notifyOps + SUBSCRIPTION_UNRESOLVED、Stripe mutate 未呼出', async () => {
    mockResolveActiveSubscription.mockRejectedValue(
      new NoSubscriptionError('none'),
    )
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('SUBSCRIPTION_UNRESOLVED')

    expect(mockNotifyOps).toHaveBeenCalledWith(
      'plan change: subscription unresolved',
      expect.objectContaining({
        userId: 'u_1',
        clerkId: 'clerk_u_1',
        kind: 'NoSubscriptionError',
      }),
    )
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
  })

  it('resolve が AmbiguousSubscriptionError → notifyOps(kind=Ambiguous) + SUBSCRIPTION_UNRESOLVED', async () => {
    mockResolveActiveSubscription.mockRejectedValue(
      new AmbiguousSubscriptionError('multiple'),
    )
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('SUBSCRIPTION_UNRESOLVED')
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'plan change: subscription unresolved',
      expect.objectContaining({ kind: 'AmbiguousSubscriptionError' }),
    )
  })

  it('operationId 欠落 → MISSING_OPERATION_ID throw、resolve 未呼出', async () => {
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year' })),
    ).rejects.toThrow('MISSING_OPERATION_ID')
    expect(mockResolveActiveSubscription).not.toHaveBeenCalled()
  })

  it('operationId 空文字 → MISSING_OPERATION_ID throw', async () => {
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: '' })),
    ).rejects.toThrow('MISSING_OPERATION_ID')
  })

  it('不正 plan → throw、resolve 未呼出', async () => {
    await expect(
      changePlan(changeFd({ plan: 'free', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow(/Invalid plan/)
    expect(mockResolveActiveSubscription).not.toHaveBeenCalled()
  })

  it('不正 interval → throw、resolve 未呼出', async () => {
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'weekly', operationId: 'op_1' })),
    ).rejects.toThrow(/Invalid interval/)
    expect(mockResolveActiveSubscription).not.toHaveBeenCalled()
  })

  it('getCurrentUser null → USER_NOT_SYNCED、resolve 未呼出', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('USER_NOT_SYNCED')
    expect(mockResolveActiveSubscription).not.toHaveBeenCalled()
  })
})

describe('cancelDowngrade: 予約取消', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(paidUser)
  })

  it('scheduleId 有 → cancelScheduledDowngrade(scheduleId,key) + /app/upgrade redirect', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_x',
      cancelScheduled: false,
    })
    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_cancel' })),
    ).rejects.toThrow('__REDIRECT__:/app/upgrade')

    expect(mockCancelScheduledDowngrade).toHaveBeenCalledWith(
      'sched_x',
      'cancelDowngrade:u_1:op_cancel',
    )
  })

  it('scheduleId null → NO_SCHEDULE throw、cancel 未呼出', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: null,
      cancelScheduled: false,
    })
    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_1' })),
    ).rejects.toThrow('NO_SCHEDULE')
    expect(mockCancelScheduledDowngrade).not.toHaveBeenCalled()
  })

  it('operationId 欠落 → MISSING_OPERATION_ID throw', async () => {
    await expect(cancelDowngrade(changeFd({}))).rejects.toThrow(
      'MISSING_OPERATION_ID',
    )
    expect(mockResolveActiveSubscription).not.toHaveBeenCalled()
  })

  it('resolve が AmbiguousSubscriptionError → notifyOps + SUBSCRIPTION_UNRESOLVED', async () => {
    mockResolveActiveSubscription.mockRejectedValue(
      new AmbiguousSubscriptionError('x'),
    )
    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_1' })),
    ).rejects.toThrow('SUBSCRIPTION_UNRESOLVED')
    expect(mockNotifyOps).toHaveBeenCalled()
    expect(mockCancelScheduledDowngrade).not.toHaveBeenCalled()
  })

  it('getCurrentUser null → USER_NOT_SYNCED', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_1' })),
    ).rejects.toThrow('USER_NOT_SYNCED')
  })
})
