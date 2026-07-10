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
  mockDbUpdate,
  mockDbSet,
  mockDbWhere,
  mockDbReturning,
} = vi.hoisted(() => {
  // DB write chain: db.update(users).set({...}).where(eq(...)).returning(...)
  // (repository 経由で .returning() が付く。 await 解決点は returning)
  const mockDbReturning = vi.fn().mockResolvedValue([])
  const mockDbWhere = vi.fn(() => ({ returning: mockDbReturning }))
  const mockDbSet = vi.fn(() => ({ where: mockDbWhere }))
  const mockDbUpdate = vi.fn(() => ({ set: mockDbSet }))
  return {
    mockGetCurrentUser: vi.fn(),
    mockCheckoutCreate: vi.fn(),
    mockResolveActiveSubscription: vi.fn(),
    mockGetPendingState: vi.fn(),
    mockApplyUpgrade: vi.fn(),
    mockScheduleDowngrade: vi.fn(),
    mockCancelScheduledDowngrade: vi.fn(),
    mockNotifyOps: vi.fn(),
    mockDbUpdate,
    mockDbSet,
    mockDbWhere,
    mockDbReturning,
  }
})

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/stripe/client', () => ({
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
    applyUpgrade: mockApplyUpgrade,
    scheduleDowngrade: mockScheduleDowngrade,
    cancelScheduledDowngrade: mockCancelScheduledDowngrade,
  }
})

// getPendingState は pure module へ抽出済 (subscription-changes)。action 層 test では
// pending 状態を任意に注入したいので mock する。classifyChange は純ロジックのため
// importOriginal で real を維持し、実際の rank 比較を通す。
vi.mock('@/lib/stripe/subscription-changes', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/stripe/subscription-changes')>()
  return {
    ...actual,
    getPendingState: mockGetPendingState,
  }
})

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
}))

// getDb は changePlan downgrade + cancelDowngrade の DB write で呼ばれる。
// singleton パターン (lib/db/index.ts) だが test では factory ごと差し替える。
vi.mock('@/lib/db', () => ({ getDb: () => ({ update: mockDbUpdate }) }))

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    // Next.js の redirect は throw でフロー終了する semantics を持つので
    // test 側で同等の throw を投げて assert で捕捉する。
    throw new Error(`__REDIRECT__:${url}`)
  },
}))

import { eq } from 'drizzle-orm'
import {
  createCheckoutSession,
  changePlan,
  cancelDowngrade,
} from './actions'
import {
  NoSubscriptionError,
  AmbiguousSubscriptionError,
} from '@/lib/stripe/subscription'
import { users } from '@/lib/db/schema'

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
  // ダウングレード予約 3 列: 既存 test が「予約なし」状態を前提とするため null に初期化。
  scheduledDowngradeScheduleId: null,
  scheduledTargetPriceId: null,
  scheduledChangeEffectiveAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  // DB mock チェーンは vi.clearAllMocks で実装が消えるので毎回再登録する。
  mockDbReturning.mockResolvedValue([])
  mockDbWhere.mockReturnValue({ returning: mockDbReturning })
  mockDbSet.mockReturnValue({ where: mockDbWhere })
  mockDbUpdate.mockReturnValue({ set: mockDbSet })

  mockGetCurrentUser.mockResolvedValue(baseUser)
  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/test/abc' })
  // changePlan/cancelDowngrade のデフォルト happy-path 値。各 test で上書きする。
  // downgrade test は scheduleDowngrade に渡る sub を { id: 'sub_1' } で verbatim
  // assert するため、resolve の戻り sub は最小 shape を維持する (customer は付けない)。
  // upgrade 枝の customerId は sub.customer (undefined) を anomaly notify 専用に読むが、
  // healthy path では未使用なので undefined でも問題ない。
  mockResolveActiveSubscription.mockResolvedValue({
    sub: { id: 'sub_1' },
    itemId: 'si_1',
  })
  mockGetPendingState.mockReturnValue({
    hasPendingUpdate: false,
    scheduleId: null,
    cancelScheduled: false,
  })
  // W (W-A2): upgrade 枝が applyUpgrade の戻り値を real projectStripeSubscription で
  // 即時射影する。default は pro/year 昇格後の valid subscription を返す。
  mockApplyUpgrade.mockResolvedValue(
    upgradedSub({ priceId: process.env.STRIPE_PRICE_PRO_YEARLY! }),
  )
  // scheduleDowngrade は phases[0].end_date (unix 秒) を含む SubscriptionSchedule を返す。
  // 1893456000 = 2030-01-01T00:00:00Z (arbitrary future timestamp for test assertions)
  mockScheduleDowngrade.mockResolvedValue({
    id: 'sched_1',
    phases: [{ end_date: 1893456000 }],
  })
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

// applyUpgrade が返す Stripe.Subscription の最小 shape を組む helper。
// projectStripeSubscription (real) が読む field のみ:
//   - status → subscriptionStatus 正規化
//   - items.data[0].price.id → plan/billingInterval 導出 (resolveFromPriceId)
//   - items.data[0].current_period_end → currentPeriodEnd (Unix 秒 → Date)
//   - cancel_at → cancelAt (Unix 秒 → Date)
//   - id → stripeSubscriptionId
//   - customer → anomaly notify payload (healthy path では未使用)
// 1893456000 = 2030-01-01T00:00:00Z (arbitrary future timestamp)。
// I-14 pin 用に pendingUpdate を渡すと pending_update を持つ「支払保留」sub を作る。
function upgradedSub(opts: {
  priceId: string
  status?: string
  currentPeriodEnd?: number
  cancelAt?: number | null
  pendingUpdate?: boolean
}) {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: opts.status ?? 'active',
    cancel_at: opts.cancelAt ?? null,
    // pending_update: 支払保留時 Stripe は旧 price を items に維持し pending_update に
    // 目標変更を退避する。projectStripeSubscription は items の (旧) price を読むため、
    // pendingUpdate=true でも本 helper は「items に旧 price を積んだ sub」を呼出側が
    // 渡すことで I-14 (旧 plan 射影) を表現する。ここでは pending_update flag のみ付す。
    pending_update: opts.pendingUpdate ? { expires_at: 1893456000 } : null,
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: opts.priceId },
          current_period_end: opts.currentPeriodEnd ?? 1893456000,
        },
      ],
    },
  }
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

  // R1: success_url を ?billing=new に統合 (旧 ?checkout=success を廃止)。
  it('success_url は /app?billing=new (banner entry 統合)', async () => {
    await expect(createCheckoutSession(fd('standard', 'month'))).rejects.toThrow(
      /__REDIRECT__/,
    )
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: expect.stringMatching(/\/app\?billing=new$/),
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

  // W (W-A2 挙動変更): applyUpgrade は valid Stripe.Subscription を返し (beforeEach
  // default = upgradedSub)、後段で eager projection が走るようになった。本 test は
  // applyUpgrade の引数 + redirect の不変性のみを pin (射影値は専用 test で assert)。
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
      { userId: 'u_1', operationId: 'op_def' },
    )
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
  })

  // §5.3: downgrade 後に 3 列を DB に set してブロックを即時有効化する。
  it('downgrade 経路: scheduleDowngrade 成功後 DB 3 列を set (user スコープ)', async () => {
    // scheduleDowngrade は { id, phases: [{ end_date }] } を返す (beforeEach で設定済)
    await expect(
      changePlan(changeFd({ plan: 'standard', interval: 'month', operationId: 'op_set' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=downgrade')

    expect(mockDbSet).toHaveBeenCalledWith({
      scheduledDowngradeScheduleId: 'sched_1',
      scheduledTargetPriceId: process.env.STRIPE_PRICE_STANDARD_MONTHLY,
      // end_date (Unix 秒) → Date に変換
      scheduledChangeEffectiveAt: new Date(1893456000 * 1000),
    })
    // user スコープ: where 句で user.id を使う
    expect(mockDbWhere).toHaveBeenCalledWith(eq(users.id, baseUser.id))
  })

  // A-3 整合窓: scheduleDowngrade (Stripe) 成功後の db.update が失敗した場合、
  // notifyOps で検知可能にする (挙動不変・検知のみ)。
  it('downgrade 経路: db.update 失敗 → notifyOps 1 回 + rethrow (redirect 不到達)', async () => {
    const dbErr = new Error('db unreachable')
    mockDbReturning.mockRejectedValueOnce(dbErr)

    await expect(
      changePlan(changeFd({ plan: 'standard', interval: 'month', operationId: 'op_dbfail' })),
    ).rejects.toThrow('db unreachable')

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'plan change: db write failed after stripe success',
      expect.objectContaining({
        operation: 'scheduleDowngrade',
        userId: 'u_1',
        operationId: 'op_dbfail',
        scheduleId: 'sched_1',
        targetPriceId: process.env.STRIPE_PRICE_STANDARD_MONTHLY,
        error: dbErr,
        environment: expect.any(String),
        timestamp: expect.any(String),
      }),
    )
  })

  // notifyOps 自身が throw する degraded path (prod misconfig 等) でも、A-3 の目的である
  // 「Stripe 成功後の DB 失敗」を root cause として rethrow する (notifyOps のエラーで
  // マスクされない)。
  it('downgrade 経路: db.update 失敗 かつ notifyOps 自身も throw → 元の DB error を rethrow', async () => {
    const dbErr = new Error('db unreachable')
    mockDbReturning.mockRejectedValueOnce(dbErr)
    mockNotifyOps.mockRejectedValueOnce(new Error('ops misconfig'))

    await expect(
      changePlan(changeFd({ plan: 'standard', interval: 'month', operationId: 'op_dbfail2' })),
    ).rejects.toThrow('db unreachable')
  })

  it('downgrade 経路: db.update 成功 → notifyOps 不発 + redirect throw', async () => {
    await expect(
      changePlan(changeFd({ plan: 'standard', interval: 'month', operationId: 'op_ok' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=downgrade')

    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  // W (W-A2 挙動変更): upgrade 経路は plan 6 列を eager project する (saveProjection)。
  // 一方で予約 3 列 (scheduledDowngradeScheduleId / scheduledTargetPriceId /
  // scheduledChangeEffectiveAt) は触らない (saveProjection の update に含めない)。
  // 旧挙動 (upgrade は DB write ゼロ) からの意図的更新。
  it('upgrade 経路: plan 6 列を eager project、予約 3 列は触らない', async () => {
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_up' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')

    // plan 6 列で set される (射影発火)。
    expect(mockDbSet).toHaveBeenCalledTimes(1)
    // mockDbSet は vi.fn(() => ...) で引数型が空 tuple 推論のため、set 引数を
    // Record として取り出す (projection update = 動的 object)。
    const setArg = (mockDbSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    // 予約 3 列は projection update に一切含まれない (I-9: 予約は saveReservation 専用)。
    expect(setArg).not.toHaveProperty('scheduledDowngradeScheduleId')
    expect(setArg).not.toHaveProperty('scheduledTargetPriceId')
    expect(setArg).not.toHaveProperty('scheduledChangeEffectiveAt')
    // plan 6 列 key を持つ。
    expect(Object.keys(setArg).sort()).toEqual(
      [
        'billingInterval',
        'cancelAt',
        'currentPeriodEnd',
        'plan',
        'stripeSubscriptionId',
        'subscriptionStatus',
      ].sort(),
    )
  })

  // ── W (W-A2) 新規 test 5 本: eager projection の実挙動 pin ──────────────
  // real projectStripeSubscription を通す (db/ops/clerk は既存 mock)。射影値・
  // 実失敗・冪等を非真空 assert する。

  // #1: upgrade 成功 → applyUpgrade 戻り sub どおりの plan 6 列を DB へ set。
  // matched 行の clerkId は null にして Clerk sync を skip させる (scrub 行流儀)。
  it('upgrade 成功: applyUpgrade 戻り sub どおりの plan 6 列を eager project (値 assert)', async () => {
    // pro/year 昇格 (rank 4)。period_end / cancel_at を具体値で pin。
    mockApplyUpgrade.mockResolvedValueOnce(
      upgradedSub({
        priceId: process.env.STRIPE_PRICE_PRO_YEARLY!,
        status: 'active',
        currentPeriodEnd: 1900000000,
        cancelAt: null,
      }),
    )
    // matched=true / clerkId=null (Clerk sync skip)。
    mockDbReturning.mockResolvedValueOnce([
      {
        clerkId: null,
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
      },
    ])

    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_proj' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')

    expect(mockDbSet).toHaveBeenCalledWith({
      plan: 'pro',
      billingInterval: 'year',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(1900000000 * 1000),
      cancelAt: null,
      stripeSubscriptionId: 'sub_1',
    })
    // user スコープ (WHERE eq(users.id, ...))。
    expect(mockDbWhere).toHaveBeenCalledWith(eq(users.id, paidUser.id))
    // Clerk sync は matched だが clerkId null なので notifyOps 系は不発。
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  // #2: 射影 DB reject → notifyOps(operation:'applyUpgrade') 1 回 + 元 error rethrow、
  // redirect 不到達 (A-3 同型)。terminal な mockDbReturning を reject させる。
  it('upgrade: 射影 DB 書込失敗 → notifyOps(applyUpgrade) 1 回 + rethrow、redirect 不到達', async () => {
    const dbErr = new Error('db unreachable')
    mockDbReturning.mockRejectedValueOnce(dbErr)

    // redirect(__REDIRECT__) ではなく DB error が投げられる = redirect 不到達の証拠。
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_projfail' })),
    ).rejects.toThrow('db unreachable')

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'plan change: db write failed after stripe success',
      expect.objectContaining({
        operation: 'applyUpgrade',
        userId: 'u_1',
        operationId: 'op_projfail',
        error: dbErr,
        environment: expect.any(String),
        timestamp: expect.any(String),
      }),
    )
    // applyUpgrade (Stripe) は成功済 = 呼ばれている。
    expect(mockApplyUpgrade).toHaveBeenCalled()
  })

  // #3: 射影 DB reject かつ notifyOps 自身も throw → 元 DB error を rethrow
  // (notifyOps の error でマスクされない、A-3 同型)。
  it('upgrade: 射影 DB 書込失敗 かつ notifyOps も throw → 元の DB error を rethrow', async () => {
    const dbErr = new Error('db unreachable')
    mockDbReturning.mockRejectedValueOnce(dbErr)
    mockNotifyOps.mockRejectedValueOnce(new Error('ops misconfig'))

    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_projfail2' })),
    ).rejects.toThrow('db unreachable')
  })

  // #4 (I-14): 支払保留 (pending_if_incomplete) 時、applyUpgrade は items に旧 price を
  // 維持したまま pending_update を持つ sub を返す → projectStripeSubscription は
  // items の旧 price を読み、旧 plan を射影する (upgrade 未発効を正しく反映)。
  it('upgrade 支払保留 (pending_update): items の旧 price → 旧 plan を射影', async () => {
    // 現プラン pro/month (paidUser)。UI は pro/year を要求するが、支払保留のため
    // applyUpgrade の戻り sub は items に旧 price (PRO_MONTHLY) を維持 + pending_update。
    mockApplyUpgrade.mockResolvedValueOnce(
      upgradedSub({
        priceId: process.env.STRIPE_PRICE_PRO_MONTHLY!,
        status: 'active',
        pendingUpdate: true,
      }),
    )
    mockDbReturning.mockResolvedValueOnce([
      {
        clerkId: null,
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
      },
    ])

    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_pending' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')

    // 旧 plan (pro/month) が射影される (pro/year に昇格しない = I-14 pin)。
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'pro', billingInterval: 'month' }),
    )
  })

  // #5 冪等: 同一 updatedSub で 2 回 upgrade を走らせると、set される plan 6 列は
  // 2 回とも同一 (終状態不変 = 再射影しても値が変わらない)。
  it('upgrade 冪等: 同一 updatedSub の再射影で set 値が 2 回とも同一', async () => {
    const sameSub = upgradedSub({
      priceId: process.env.STRIPE_PRICE_PRO_YEARLY!,
      status: 'active',
      currentPeriodEnd: 1900000000,
      cancelAt: 1910000000,
    })
    mockApplyUpgrade.mockResolvedValue(sameSub)
    mockDbReturning.mockResolvedValue([
      {
        clerkId: null,
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
      },
    ])

    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_idem1' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_idem2' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')

    const expectedSet = {
      plan: 'pro',
      billingInterval: 'year',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(1900000000 * 1000),
      cancelAt: new Date(1910000000 * 1000),
      stripeSubscriptionId: 'sub_1',
    }
    expect(mockDbSet).toHaveBeenCalledTimes(2)
    expect(mockDbSet).toHaveBeenNthCalledWith(1, expectedSet)
    expect(mockDbSet).toHaveBeenNthCalledWith(2, expectedSet)
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

  // §5.5: ブロック条件は DB 列 (scheduledDowngradeScheduleId != null)。
  // pending.scheduleId 単独ではブロックしない (回帰テスト)。
  it('DB 列 scheduledDowngradeScheduleId 有 → CHANGE_BLOCKED、apply/schedule 未呼出', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...paidUser,
      scheduledDowngradeScheduleId: 'sched_existing',
    })
    // getPendingState は scheduleId: null を返しても DB 列だけでブロックされる
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: null,
      cancelScheduled: false,
    })
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('CHANGE_BLOCKED')
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
    // DB write もされない
    expect(mockDbSet).not.toHaveBeenCalled()
  })

  // §5.5 回帰: sub.schedule (pending.scheduleId) だけでは CHANGE_BLOCKED しない。
  // DB 列が null であれば変更処理を続行する。
  it('pending.scheduleId 有でも DB 列 null → ブロックせず処理続行 (upgrade 例)', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_from_stripe', // Stripe 側には schedule がある
      cancelScheduled: false,
    })
    // user.scheduledDowngradeScheduleId は null (DB 列未設定)
    // → ブロックされずに upgrade 処理が走る
    await expect(
      changePlan(changeFd({ plan: 'pro', interval: 'year', operationId: 'op_1' })),
    ).rejects.toThrow('__REDIRECT__:/app?billing=upgrade')
    expect(mockApplyUpgrade).toHaveBeenCalled()
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

  // F1 golden (Phase G): cancelScheduled=true かつ DB 列 scheduledDowngradeScheduleId
  // も non-null の複合 (両条件が同時に真)。 block 条件 (actions.ts:110-116) で
  // CHANGE_BLOCKED throw、 Stripe mutate (applyUpgrade / scheduleDowngrade) は
  // 一切呼ばれない現行挙動を pin。
  it('cancelScheduled=true かつ DB 列 scheduledDowngradeScheduleId non-null (複合) → CHANGE_BLOCKED、Stripe mutate 未呼出', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...paidUser,
      scheduledDowngradeScheduleId: 'sched_reserved',
    })
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_reserved',
      cancelScheduled: true,
    })
    await expect(
      changePlan(changeFd({ plan: 'standard', interval: 'month', operationId: 'op_compound' })),
    ).rejects.toThrow('CHANGE_BLOCKED')
    expect(mockApplyUpgrade).not.toHaveBeenCalled()
    expect(mockScheduleDowngrade).not.toHaveBeenCalled()
    // DB write も走らない (block は Stripe mutate の前段)。
    expect(mockDbSet).not.toHaveBeenCalled()
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

  // §5.5 例外: cancelScheduledDowngrade 成功後 DB 3 列を null に clear する。
  it('cancelScheduledDowngrade 成功後 DB 3 列を clear (null set、user スコープ)', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_x',
      cancelScheduled: false,
    })
    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_clear' })),
    ).rejects.toThrow('__REDIRECT__:/app/upgrade')

    expect(mockDbSet).toHaveBeenCalledWith({
      scheduledDowngradeScheduleId: null,
      scheduledTargetPriceId: null,
      scheduledChangeEffectiveAt: null,
    })
    expect(mockDbWhere).toHaveBeenCalledWith(eq(users.id, baseUser.id))
  })

  // A-3 整合窓: cancelScheduledDowngrade (Stripe) 成功後の db.update が失敗した場合、
  // notifyOps で検知可能にする (挙動不変・検知のみ)。
  it('db.update 失敗 → notifyOps 1 回 (targetPriceId なし) + rethrow (redirect 不到達)', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_x',
      cancelScheduled: false,
    })
    const dbErr = new Error('db unreachable')
    mockDbReturning.mockRejectedValueOnce(dbErr)

    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_dbfail' })),
    ).rejects.toThrow('db unreachable')

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    const [subject, context] = mockNotifyOps.mock.calls[0]
    expect(subject).toBe('plan change: db write failed after stripe success')
    expect(context).toEqual(
      expect.objectContaining({
        operation: 'cancelDowngrade',
        userId: 'u_1',
        operationId: 'op_dbfail',
        scheduleId: 'sched_x',
        error: dbErr,
        environment: expect.any(String),
        timestamp: expect.any(String),
      }),
    )
    expect(context).not.toHaveProperty('targetPriceId')
  })

  it('db.update 成功 → notifyOps 不発 + redirect throw', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_y',
      cancelScheduled: false,
    })
    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_ok' })),
    ).rejects.toThrow('__REDIRECT__:/app/upgrade')

    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  // notifyOps 自身が throw する degraded path (prod misconfig 等) でも、A-3 の目的である
  // 「Stripe 成功後の DB 失敗」を root cause として rethrow する (notifyOps のエラーで
  // マスクされない)。
  it('db.update 失敗 かつ notifyOps 自身も throw → 元の DB error を rethrow', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_x',
      cancelScheduled: false,
    })
    const dbErr = new Error('db unreachable')
    mockDbReturning.mockRejectedValueOnce(dbErr)
    mockNotifyOps.mockRejectedValueOnce(new Error('ops misconfig'))

    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_dbfail2' })),
    ).rejects.toThrow('db unreachable')
  })

  // #5 順序 pin (spec N-5): cancelScheduledDowngrade (release) が非冪等 error で reject
  // すると、catch なしで伝播し後段の DB clear (db.update) には到達しない = 予約が維持される。
  // R (webhook #1) が release→clear 順を反転しても、action #5 のこの順序は不変であることの
  // 恒久防波堤 (逆転すると reverse orphan: DB は予約無しだが Stripe schedule が残る)。
  it('cancelScheduledDowngrade reject(非冪等 error)→ throw 伝播・db.update 未呼出(予約維持・#5 順序 pin)', async () => {
    mockGetPendingState.mockReturnValue({
      hasPendingUpdate: false,
      scheduleId: 'sched_x',
      cancelScheduled: false,
    })
    const releaseErr = new Error('Stripe API error: could not release schedule')
    mockCancelScheduledDowngrade.mockRejectedValueOnce(releaseErr)

    await expect(
      cancelDowngrade(changeFd({ operationId: 'op_release_fail' })),
    ).rejects.toThrow('Stripe API error: could not release schedule')

    // release 失敗で DB clear には到達しない (予約 3 列は維持される)。
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockDbSet).not.toHaveBeenCalled()
  })
})
