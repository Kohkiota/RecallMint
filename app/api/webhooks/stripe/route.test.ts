import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- hoisted mocks ---
const {
  mockConstructEvent,
  mockDbInsert,
  mockDbUpdate,
  mockSubscriptionsRetrieve,
  mockNotifyOps,
  mockNotifyWebhookError,
  mockSyncClerkMetadata,
  mockReleaseCompletedDowngrade,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockNotifyOps: vi.fn().mockResolvedValue(undefined),
  mockNotifyWebhookError: vi.fn().mockResolvedValue(undefined),
  mockSyncClerkMetadata: vi.fn().mockResolvedValue({ ok: true }),
  mockReleaseCompletedDowngrade: vi.fn().mockResolvedValue('released'),
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    insert: mockDbInsert,
    update: mockDbUpdate,
  }),
}))

vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
  },
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
  notifyWebhookError: mockNotifyWebhookError,
}))

vi.mock('@/lib/auth/clerk-metadata', () => ({
  syncClerkPublicMetadata: mockSyncClerkMetadata,
}))

vi.mock('@/lib/stripe/subscription', () => ({
  releaseCompletedDowngrade: mockReleaseCompletedDowngrade,
}))

import { POST } from './route'
import { integrationFailures } from '@/lib/db/schema'
import { INTEGRATION_FAILURE_CATALOG } from '@/lib/integration-failures'

const SECRET = 'whsec_test_for_stripe_unit'

// vitest.setup.ts が STRIPE_PRICE_* 4 種類を fake_standard_monthly などで設定済。
// 各 test では実値を baseline から参照する (price-mapping.test.ts と同 pattern)。
const PRICE = {
  STANDARD_MONTHLY: process.env.STRIPE_PRICE_STANDARD_MONTHLY!,
  STANDARD_YEARLY: process.env.STRIPE_PRICE_STANDARD_YEARLY!,
  PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY!,
  PRO_YEARLY: process.env.STRIPE_PRICE_PRO_YEARLY!,
}

/**
 * Drizzle chain mock。 clerk webhook test と同 pattern。
 * insert/update を順次呼ぶ handler でも `.values().onConflictDoNothing().returning()`
 * `.set().where()` が連結 await できる。
 */
function chain(resolveTo: unknown = undefined) {
  const c: Record<string, unknown> = {}
  c.values = vi.fn().mockReturnValue(c)
  c.onConflictDoNothing = vi.fn().mockReturnValue(c)
  c.returning = vi.fn().mockReturnValue(c)
  c.set = vi.fn().mockReturnValue(c)
  c.where = vi.fn().mockReturnValue(c)
  c.then = (onFulfilled: (v: unknown) => void) =>
    Promise.resolve(resolveTo).then(onFulfilled)
  return c
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  mockNotifyOps.mockResolvedValue(undefined)
  mockSyncClerkMetadata.mockResolvedValue({ ok: true })
  mockReleaseCompletedDowngrade.mockResolvedValue('released')
  // recordIntegrationFailure (dual-write) は getDb().insert(integrationFailures) を
  // 呼ぶため、 idempotency INSERT (mockReturnValueOnce) 消費後の追加 insert が
  // undefined を返さないよう default chain を敷く。 これがないと helper の INSERT が
  // fail し throw-safe path (ledgerWriteError) に落ちて dual-write の row を検証できない。
  mockDbInsert.mockReturnValue(chain())
})

// dual-write: getDb().insert(integrationFailures).values({...}) に渡った row を拾う。
// mockDbInsert は idempotency (stripeEvents) と ledger (integrationFailures) の両方で
// 呼ばれるため、 第 1 引数が integrationFailures の call だけを対象にする。
function integrationInsertRow(): Record<string, unknown> | undefined {
  const idx = mockDbInsert.mock.calls.findIndex((c) => c[0] === integrationFailures)
  if (idx === -1) return undefined
  const chainObj = mockDbInsert.mock.results[idx].value as {
    values: ReturnType<typeof vi.fn>
  }
  return chainObj.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined
}

function makeReq(body: unknown): Request {
  return new Request('https://test/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'stripe-signature': 't=0,v1=fake',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// helper: 通常 idempotency INSERT は returning [{id}] を返して新規扱い
function stubIdempotencyInsertOnce() {
  mockDbInsert.mockReturnValueOnce(chain([{ id: 'evt_unit_test' }]))
}

// helper: 各 (priceId, status, cycleEnd, cancelAt) を持つ subscription object
function sub({
  priceId,
  status = 'active',
  cycleEnd = 1779999999,
  cancelAt = null,
  customerId = 'cus_unit_test',
  schedule = null,
}: {
  priceId: string
  status?: string
  cycleEnd?: number
  cancelAt?: number | null
  customerId?: string
  // §6.4 release gate #1: sub.schedule は string id / 展開 object / null で来うる。
  // 既存 test は schedule 不要なので default null (gate を通っても no-op)。
  schedule?: string | { id: string } | null
}) {
  return {
    id: 'sub_unit',
    customer: customerId,
    status,
    cancel_at: cancelAt,
    schedule,
    items: { data: [{ price: { id: priceId }, current_period_end: cycleEnd }] },
  }
}

describe('Stripe webhook: Standard 配線 + billing_interval', () => {
  it('checkout.session.completed → standard monthly: plan=standard, interval=month', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_clerk_1',
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain()).mockReturnValueOnce(chain())
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_1' }),
    )

    const res = await POST(makeReq({ id: 'evt_1' }))
    expect(res.status).toBe(200)

    // 2 段階 update: 1st = stripeCustomerId link、 2nd = plan + interval sync。
    // race defense (subscription.created 先着でも customerId 未紐付け回避) は
    // 1st update に依存しているので両 update の発火を強く検証する。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const firstSetCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> })
      .set
    expect(firstSetCall).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCustomerId: 'cus_1' }),
    )
    const secondSetCall = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> })
      .set
    expect(secondSetCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'standard',
        billingInterval: 'month',
        subscriptionStatus: 'active',
      }),
    )
  })

  it('customer.subscription.updated → pro yearly: plan=pro, interval=year', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId: PRICE.PRO_YEARLY, customerId: 'cus_2' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_2' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'pro',
        billingInterval: 'year',
        subscriptionStatus: 'active',
      }),
    )
  })

  it('customer.subscription.created → standard yearly: plan=standard, interval=year', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_3',
      type: 'customer.subscription.created',
      data: { object: sub({ priceId: PRICE.STANDARD_YEARLY, customerId: 'cus_3' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_3' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'standard',
        billingInterval: 'year',
      }),
    )
  })

  it('customer.subscription.deleted → plan=free, billingInterval=null', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_4' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_4' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        subscriptionStatus: 'canceled',
        billingInterval: null,
        cancelAt: null,
      }),
    )
    // currentPeriodEnd は billing 履歴として touch しない契約 (route.ts §deleted)。
    // set 引数の key を厳密検証することで「うっかり currentPeriodEnd: null を
    // 足す」regression を弾く。 §6.4 で予約 3 列 clear を追加したのでそれらは含む。
    const setArgs = (setCall.mock.calls[0][0] ?? {}) as Record<string, unknown>
    expect(Object.keys(setArgs).sort()).toEqual(
      [
        'billingInterval',
        'cancelAt',
        'plan',
        'stripeSubscriptionId',
        'subscriptionStatus',
        'scheduledDowngradeScheduleId',
        'scheduledTargetPriceId',
        'scheduledChangeEffectiveAt',
      ].sort(),
    )
  })

  it('subscription.updated status=past_due → plan preserved, interval preserved', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_5',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.PRO_MONTHLY,
          status: 'past_due',
          customerId: 'cus_5',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_5' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'pro',
        billingInterval: 'month',
        subscriptionStatus: 'past_due',
      }),
    )
  })

  it('subscription.updated status=unpaid → plan=free (downgrade), interval=null', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_6',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          status: 'unpaid',
          customerId: 'cus_6',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_6' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        billingInterval: null,
        subscriptionStatus: 'past_due',
      }),
    )
  })

  it('unknown price_id (env 設定漏れ) → notifyOps + plan=free fallback + 200', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_7',
      type: 'customer.subscription.updated',
      data: {
        object: sub({ priceId: 'price_unknown_xyz', customerId: 'cus_7' }),
      },
    })
    stubIdempotencyInsertOnce()
    // I-2 fix で UPDATE returning [] のとき .updated path は "unlinked customer"
    // notify が乗るため、 本 test の前提 (linked customer + unknown price) に揃える
    // ために returning に clerkId を入れる。 これで notifyOps は unknown price の
    // 1 件だけが期待される。
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_7' }]))

    const res = await POST(makeReq({ id: 'evt_7' }))
    expect(res.status).toBe(200)

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      expect.stringMatching(/unknown price/i),
      expect.objectContaining({
        priceId: 'price_unknown_xyz',
        eventId: 'evt_7',
        customerId: 'cus_7',
      }),
    )
    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        billingInterval: null,
      }),
    )
  })

  // F1 golden (Phase G): items.data 空 (price_id 取得不能) の missing_price 経路。
  // extractSubFields で priceId=null → resolvePlanFromSub (active) が
  // notifyOps('stripe sub missing price_id') 発火 + plan=free 書込。 現行実挙動を
  // 観測して pin (notifyOps subject 文言 + plan/interval)。
  it('items.data 空 (missing price_id) → notifyOps "stripe sub missing price_id" + plan=free + 200', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_missing_price',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_unit',
          customer: 'cus_missing_price',
          status: 'active',
          cancel_at: null,
          schedule: null,
          items: { data: [] },
        },
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_mp' }]))

    const res = await POST(makeReq({ id: 'evt_missing_price' }))
    expect(res.status).toBe(200)

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe sub missing price_id',
      expect.objectContaining({
        eventId: 'evt_missing_price',
        customerId: 'cus_missing_price',
        status: 'active',
      }),
    )
    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        billingInterval: null,
      }),
    )
  })

  it('idempotency: duplicate event_id → 200 without processing', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_dup',
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId: PRICE.PRO_MONTHLY }) },
    })
    // INSERT ON CONFLICT DO NOTHING RETURNING = empty → 既処理
    mockDbInsert.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_dup' }))
    expect(res.status).toBe(200)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('bad signature → 400', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('invalid signature')
    })
    const res = await POST(makeReq({}))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Task 4: subscription id 同期 + invoice.payment_failed + 正規化不変条件
// ---------------------------------------------------------------------------
describe('Stripe webhook: subscriptionId 同期', () => {
  it('customer.subscription.created → set に stripeSubscriptionId = sub.id', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_subid_1',
      type: 'customer.subscription.created',
      data: { object: sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_subid_1' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_subid_1' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: 'sub_unit' }),
    )
  })

  it('customer.subscription.updated → set に stripeSubscriptionId = sub.id', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_subid_2',
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId: PRICE.PRO_YEARLY, customerId: 'cus_subid_2' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_subid_2' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: 'sub_unit' }),
    )
  })

  it('customer.subscription.deleted → set に stripeSubscriptionId = null (plan=free 等は従来通り)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_subid_3',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_subid_3' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_subid_3' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        billingInterval: null,
        subscriptionStatus: 'canceled',
        cancelAt: null,
        stripeSubscriptionId: null,
      }),
    )
  })

  it('checkout.session.completed Step2 → set に stripeSubscriptionId = sub.id', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_subid_4',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_clerk_subid_4',
          customer: 'cus_subid_4',
          subscription: 'sub_subid_4',
        },
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain()).mockReturnValueOnce(chain())
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_subid_4' }),
    )

    const res = await POST(makeReq({ id: 'evt_subid_4' }))
    expect(res.status).toBe(200)

    // 2nd update (plan/status sync) の set に subscription id が含まれること
    const secondSetCall = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> })
      .set
    expect(secondSetCall).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: 'sub_unit' }),
    )
  })
})

describe('Stripe webhook: invoice.payment_failed', () => {
  it('DB の plan/status を変更しない + notifyOps + 200 (customer = string)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_pf_1',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_pf_1' } },
    })
    stubIdempotencyInsertOnce()

    const res = await POST(makeReq({ id: 'evt_pf_1' }))
    expect(res.status).toBe(200)

    // DB plan/status は据え置き → update を一切呼ばない
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe invoice.payment_failed',
      expect.objectContaining({ eventId: 'evt_pf_1', customerId: 'cus_pf_1' }),
    )
    expect(mockNotifyWebhookError).not.toHaveBeenCalled()
  })

  it('customer が object 形式でも id を取り出す', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_pf_2',
      type: 'invoice.payment_failed',
      data: { object: { customer: { id: 'cus_pf_2' } } },
    })
    stubIdempotencyInsertOnce()

    const res = await POST(makeReq({ id: 'evt_pf_2' }))
    expect(res.status).toBe(200)

    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe invoice.payment_failed',
      expect.objectContaining({ customerId: 'cus_pf_2' }),
    )
    expect(mockNotifyWebhookError).not.toHaveBeenCalled()
  })
})

describe('Stripe webhook: 正規化不変条件 (pending_update 非昇格)', () => {
  it('updated で pending_update に別 target price があっても DB plan は現 item price から正規化', async () => {
    // 現 item price = STANDARD_MONTHLY、 pending_update.subscription_items の
    // target = PRO_YEARLY。 現在プランは現 item price (standard) であるべきで、
    // pending target (pro) に昇格してはならない。
    const subObj = sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_pu_1' }) as Record<
      string,
      unknown
    >
    subObj.pending_update = {
      subscription_items: [{ price: { id: PRICE.PRO_YEARLY } }],
    }
    mockConstructEvent.mockReturnValue({
      id: 'evt_pu_1',
      type: 'customer.subscription.updated',
      data: { object: subObj },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_pu_1' }]))

    const res = await POST(makeReq({ id: 'evt_pu_1' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'standard',
        billingInterval: 'month',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Clerk publicMetadata sync — 3 event 種別すべてで users.plan UPDATE と並行に
// syncClerkPublicMetadata({ clerkId, plan }) が呼ばれることを verify。
// clerkId 解決:
// - checkout.session.completed: s.client_reference_id を直接利用 (UPDATE 結果不要)
// - subscription.created/updated/deleted: UPDATE.returning({ clerkId }) の結果から
// ---------------------------------------------------------------------------
describe('Stripe webhook: Clerk publicMetadata sync', () => {
  it('checkout.session.completed → Step 2 UPDATE returning [{clerkId}] → syncClerkPublicMetadata({clerkId, plan}) (I-3 fix で gating 化)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_clerk_meta_1',
          customer: 'cus_meta_1',
          subscription: 'sub_meta_1',
        },
      },
    })
    stubIdempotencyInsertOnce()
    // 1st = stripeCustomerId link、 2nd = plan/status + returning [{clerkId}]
    mockDbUpdate
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain([{ clerkId: 'user_clerk_meta_1' }]))
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_meta_1' }),
    )

    const res = await POST(makeReq({ id: 'evt_meta_1' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).toHaveBeenCalledTimes(1)
    expect(mockSyncClerkMetadata).toHaveBeenCalledWith({
      clerkId: 'user_clerk_meta_1',
      plan: 'standard',
    })
  })

  it('customer.subscription.updated → UPDATE returning [{clerkId}] → syncClerkPublicMetadata({clerkId, plan})', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_2',
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId: PRICE.PRO_YEARLY, customerId: 'cus_meta_2' }) },
    })
    stubIdempotencyInsertOnce()
    // UPDATE returning [{clerkId}]
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_meta_2' }]))

    const res = await POST(makeReq({ id: 'evt_meta_2' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).toHaveBeenCalledTimes(1)
    expect(mockSyncClerkMetadata).toHaveBeenCalledWith({
      clerkId: 'user_clerk_meta_2',
      plan: 'pro',
    })
  })

  it('customer.subscription.created → UPDATE returning [{clerkId}] → syncClerkPublicMetadata', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_3',
      type: 'customer.subscription.created',
      data: { object: sub({ priceId: PRICE.STANDARD_YEARLY, customerId: 'cus_meta_3' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_meta_3' }]))

    const res = await POST(makeReq({ id: 'evt_meta_3' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).toHaveBeenCalledWith({
      clerkId: 'user_clerk_meta_3',
      plan: 'standard',
    })
  })

  it('customer.subscription.deleted → UPDATE returning [{clerkId}] → syncClerkPublicMetadata({plan:free})', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_4',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_meta_4' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_meta_4' }]))

    const res = await POST(makeReq({ id: 'evt_meta_4' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).toHaveBeenCalledWith({
      clerkId: 'user_clerk_meta_4',
      plan: 'free',
    })
  })

  it('subscription.updated で UPDATE returning [] → sync skip + notifyOps で観測性確保 (I-2 fix)', async () => {
    // .updated 経由で unlinked = OT 介入対象 anomaly (Portal 経由 plan 変更等の
    // user operation 起因なのに stripeCustomerId 紐付き欠落)。
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_5',
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId: PRICE.PRO_MONTHLY, customerId: 'cus_orphan' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([])) // returning empty

    const res = await POST(makeReq({ id: 'evt_meta_5' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe sub event for unlinked customer',
      expect.objectContaining({
        eventId: 'evt_meta_5',
        customerId: 'cus_orphan',
        eventType: 'customer.subscription.updated',
      }),
    )
  })

  it('subscription.created で UPDATE returning [] → sync skip + notifyOps なし (transient race 許容)', async () => {
    // .created 経由 unlinked は新規 sign-up の自然な webhook ordering、 後続の
    // checkout.session.completed で sync が走るため OT alert 不要 (noise 防止)。
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_5b',
      type: 'customer.subscription.created',
      data: { object: sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_orphan_new' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_meta_5b' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('subscription.deleted で UPDATE returning [] → sync skip + notifyOps で観測性確保 (I-2 fix)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_5c',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_orphan_del' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_meta_5c' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe sub event for unlinked customer',
      expect.objectContaining({
        eventType: 'customer.subscription.deleted',
        customerId: 'cus_orphan_del',
      }),
    )
  })

  it('checkout.session.completed で Step 2 UPDATE returning [] (user.created race) → sync skip (I-3 fix)', async () => {
    // user.created webhook が checkout.session.completed より遅延した race。
    // Step 2 UPDATE が 0 行 match → RETURNING 空 → publicMetadata に standard を
    // 書かない (= 後着の user.created が plan='free' で clobber する整合崩壊回避)。
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_5d',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_clerk_race',
          customer: 'cus_race',
          subscription: 'sub_race',
        },
      },
    })
    stubIdempotencyInsertOnce()
    // 1st update (stripeCustomerId link) + 2nd update (plan/status)。 2nd の returning は空。
    mockDbUpdate.mockReturnValueOnce(chain()).mockReturnValueOnce(chain([]))
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_race' }),
    )

    const res = await POST(makeReq({ id: 'evt_meta_5d' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
  })

  it('syncClerkPublicMetadata ok:false でも 200 を返す (webhook 不変条件)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta_6',
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_meta_6' }) },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_clerk_meta_6' }]))
    mockSyncClerkMetadata.mockResolvedValueOnce({ ok: false })

    const res = await POST(makeReq({ id: 'evt_meta_6' }))
    expect(res.status).toBe(200)
    expect(mockSyncClerkMetadata).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Task 12: ダウングレード発効後 release gate (§6.4) + subscription_schedule.released
//
// gate は customer.subscription.updated でのみ走る。plan-sync update の
// returning に scheduledDowngradeScheduleId / scheduledTargetPriceId を載せ、
// #1 (sub.schedule === DB scheduleId) かつ #5 (item price === target price) を
// 充足したときのみ releaseCompletedDowngrade に委譲。戻り値で 3 列 clear 分岐。
// ---------------------------------------------------------------------------

// helper: gate test 用 plan-sync returning row (linked + 予約あり)。
function gateRow(overrides: Record<string, unknown> = {}) {
  return [
    {
      clerkId: 'user_gate',
      scheduledDowngradeScheduleId: 'sched_x',
      scheduledTargetPriceId: PRICE.STANDARD_MONTHLY,
      ...overrides,
    },
  ]
}

describe('Stripe webhook: release gate (§6.4)', () => {
  it('#1 + #5 充足 → clear が release より先に呼ばれる (R: 順序反転)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_1',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_gate_1',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('released')
    // 1st = plan-sync (returning gateRow)、 2nd = clear update (release より先)。
    // clear の RETURNING は matched 行を返す (clearReservationMatching の SaveResult 用)。
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

    const res = await POST(makeReq({ id: 'evt_gate_1' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).toHaveBeenCalledWith('sched_x', 'autorelease:sched_x')
    // 2nd update = 3 列 clear (release 結果非依存で先行)。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
    // R 順序反転の pin: clear (2nd db.update) が release より先に invoke される。
    const clearOrder = mockDbUpdate.mock.invocationCallOrder[1]
    const releaseOrder = mockReleaseCompletedDowngrade.mock.invocationCallOrder[0]
    expect(clearOrder).toBeLessThan(releaseOrder)
  })

  it('release 結果に関わらず clear する (already_terminal / skipped どちらでも先行 clear)', async () => {
    // R (順序反転) 前は release の戻り値で clear を分岐していた (already_terminal は
    // clear・skipped は clear なし)。 新挙動では clear は release 結果非依存で先行する
    // ので、 どちらの戻り値でも 3 列 clear が走る (旧「skipped で clear しない」は撤去)。
    for (const [customerId, result] of [
      ['cus_gate_2', 'already_terminal'],
      ['cus_gate_3', 'skipped'],
    ] as const) {
      vi.clearAllMocks()
      mockReleaseCompletedDowngrade.mockResolvedValue('released')
      mockConstructEvent.mockReturnValue({
        id: 'evt_gate_' + customerId,
        type: 'customer.subscription.updated',
        data: {
          object: sub({
            priceId: PRICE.STANDARD_MONTHLY,
            customerId,
            schedule: 'sched_x',
          }),
        },
      })
      stubIdempotencyInsertOnce()
      mockReleaseCompletedDowngrade.mockResolvedValueOnce(result)
      mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

      const res = await POST(makeReq({ id: 'evt_gate_' + customerId }))
      expect(res.status).toBe(200)

      // plan-sync + clear の 2 回。 clear は release 結果非依存で先行。
      expect(mockDbUpdate).toHaveBeenCalledTimes(2)
      const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
      expect(clearSet).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledDowngradeScheduleId: null }),
      )
    }
  })

  it('#5 未反映 (item price !== target) → 委譲せず・clear なし', async () => {
    // item price = PRO_YEARLY だが target = STANDARD_MONTHLY (まだ phase0)。
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_4',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.PRO_YEARLY,
          customerId: 'cus_gate_4',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain(gateRow()))

    const res = await POST(makeReq({ id: 'evt_gate_4' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
  })

  it('§6.4.x 方向2: sub.schedule = null + DB に予約残存 → 3 列 clear (released webhook 取りこぼし保険)、 委譲なし・mismatch notify なし', async () => {
    // Portal cancel が即時 release を引き起こすケース等の保険経路。 .released
    // が endpoint 未購読 / Stripe 仕様で配信されない / 別デバイス race で取りこぼ
    // される場合でも、 .updated は確実に配信されるためここで 3 列 clear する。
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_5',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_gate_5',
          schedule: null,
        }),
      },
    })
    stubIdempotencyInsertOnce()
    // 1st = plan-sync (returning gateRow)、 2nd = 方向2 clear
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_gate_5' }))
    expect(res.status).toBe(200)

    // releaseCompletedDowngrade は呼ばれない (sub.schedule==null = Stripe 側で
    // 既に release 済 / 別経路で消滅、 委譲不要)。
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    // 方向2 で 3 列 clear UPDATE が走るため 2 回呼ばれる。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
    // mismatch notify は出ない (sub.schedule==null は正常な「Stripe が既に release」
    // 状態であり anomaly ではない)。
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('§6.4.x 方向2: Portal 解約シミュ (.updated + sub.schedule=null + cancel_at set + DB 予約残存) → cancel_at は plan-sync で set、 3 列 clear、 mismatch notify なし', async () => {
    // 本番で観測された Portal 解約由来のシナリオ: Stripe が schedule を即時 release し、
    // 同時に sub に cancel_at を set。 .released が配信されなくても、 .updated 経由で
    // (a) plan-sync が cancel_at を set、 (b) 方向2 が scheduled 3 列を clear、 を
    // 同一 webhook 受信内で完結させる。
    const cancelAtUnix = 1750000000 // 任意の Unix 秒
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_portal_cancel',
      type: 'customer.subscription.updated',
      data: {
        object: {
          ...sub({
            priceId: PRICE.STANDARD_MONTHLY,
            customerId: 'cus_portal_cancel',
            schedule: null,
          }),
          cancel_at: cancelAtUnix,
          cancel_at_period_end: true,
        },
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_gate_portal_cancel' }))
    expect(res.status).toBe(200)

    // 1st UPDATE = plan-sync。 SET 句に cancelAt が含まれていること (Date 化済)。
    const planSyncSet = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(planSyncSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelAt: new Date(cancelAtUnix * 1000),
      }),
    )
    // 2nd UPDATE = 方向2 clear。 scheduled 3 列のみ touched。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('§6.4.x 方向2: 方向1 (.released) 先着 → 後着 .updated (sub.schedule=null) は方向2 に到達せず単一 clear に収束', async () => {
    // .released が先に DB 3 列を clear (route.ts:348-361)、 その後 .updated が
    // 後着するシナリオ。 後着 .updated では plan-sync の RETURNING が
    // scheduledDowngradeScheduleId=null を返すため、 evaluateReleaseGate は
    // dbScheduleId==null で全 skip し方向2 のコードに到達しない。
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_released_first',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_released_first',
          schedule: null,
        }),
      },
    })
    stubIdempotencyInsertOnce()
    // .released 先着で既に clear 済 → plan-sync RETURNING の予約列は null。
    mockDbUpdate.mockReturnValueOnce(
      chain([{ clerkId: 'user_gate', scheduledDowngradeScheduleId: null, scheduledTargetPriceId: null }]),
    )

    const res = await POST(makeReq({ id: 'evt_gate_released_first' }))
    expect(res.status).toBe(200)

    // 方向2 の UPDATE は走らない (line 384 で全 skip)。 plan-sync の 1 回のみ。
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('sub.schedule = 別 non-null id → notifyOps (mismatch)・委譲なし・clear なし', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_6',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_gate_6',
          schedule: 'sched_other',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain(gateRow()))

    const res = await POST(makeReq({ id: 'evt_gate_6' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    // Sprint 2 dual-write: integration_failures INSERT (ledger) + plan-sync UPDATE。
    // db.update は plan-sync の 1 回のみ (clear なし)、 ledger は db.insert 側。
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    // Discord notify は byte 不変 (helper 内部で発火)。 subject / context 不変。
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe release gate schedule mismatch',
      expect.objectContaining({
        customerId: 'cus_gate_6',
        subScheduleId: 'sched_other',
        dbScheduleId: 'sched_x',
      }),
    )
    // dual-write: ledger 行に catalog の 4 軸 (stripe_gate_mismatch) + 型付き ref。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.stripe_gate_mismatch
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      stripeCustomerId: 'cus_gate_6',
      stripeSubscriptionId: 'sub_unit',
      scheduleId: 'sched_x',
    })
    // anomaly 検知系ゆえ errorMessage は NULL (subScheduleId は context 内)。
    expect(row!.errorMessage).toBeUndefined()
    expect(row!.context).toMatchObject({ subScheduleId: 'sched_other' })
  })

  it('DB scheduledDowngradeScheduleId null (予約なし) → gate 全 skip (sub.schedule あっても)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_7',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_gate_7',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(
      chain([{ clerkId: 'user_gate', scheduledDowngradeScheduleId: null, scheduledTargetPriceId: null }]),
    )

    const res = await POST(makeReq({ id: 'evt_gate_7' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // R (Task 2): #1 delegate の順序反転 — clear 先行 / release best-effort。
  // delegate 到達 = 発効済 (price==target 確認済) で予約は消費済ゆえ、 DB clear を
  // release 成否に無関係に確定させる。 release throw は握って notifyOps のみ、 clear
  // 済なので orphan は生じない。 clear throw は握らず伝播 (correctness 重大)。
  // ---------------------------------------------------------------------------

  it('N-1: delegate + release throw → 予約 clear 済 + handler は throw しない (200) + notifyOps 発火 (scheduleId/targetPriceId)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_r_n1',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_r_n1',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    // release が throw しても、 clear は先行済で確定している (順序反転の主命題)。
    mockReleaseCompletedDowngrade.mockRejectedValueOnce(new Error('release boom'))
    // 1st = plan-sync (returning gateRow)、 2nd = clear update (release より先に走る)。
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

    const res = await POST(makeReq({ id: 'evt_r_n1' }))
    // release throw を握って 200 (outer catch でなく delegate 内 try/catch)。
    expect(res.status).toBe(200)
    expect(mockNotifyWebhookError).not.toHaveBeenCalled()

    // clear は release throw に無関係に実行済 (2nd update)。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
    // release 失敗の notifyOps に scheduleId / targetPriceId が載る (Discord byte 不変)。
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe autorelease failed (reservation cleared)',
      expect.objectContaining({
        scheduleId: 'sched_x',
        targetPriceId: PRICE.STANDARD_MONTHLY,
        error: expect.any(Error),
      }),
    )
    // Sprint 2 dual-write: ledger 行に catalog の 4 軸 (stripe_release) + 型付き ref +
    // caught error の errorMessage。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.stripe_release
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      stripeCustomerId: 'cus_r_n1',
      stripeSubscriptionId: 'sub_unit',
      scheduleId: 'sched_x',
      errorMessage: 'release boom',
    })
    // targetPriceId は独立列にせず context 内に残す。
    expect(row!.context).toMatchObject({ targetPriceId: PRICE.STANDARD_MONTHLY })
  })

  it('N-2: delegate + release 成功 → clear が release より先に呼ばれる (呼出順)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_r_n2',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_r_n2',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('released')
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

    const res = await POST(makeReq({ id: 'evt_r_n2' }))
    expect(res.status).toBe(200)

    // clear (2nd db.update) が release より先に invoke されている。
    const clearOrder = mockDbUpdate.mock.invocationCallOrder[1]
    const releaseOrder = mockReleaseCompletedDowngrade.mock.invocationCallOrder[0]
    expect(clearOrder).toBeLessThan(releaseOrder)
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
  })

  it('N-3: 再送 (clear 済み行) → clearReservationMatching matched:false・release は already_terminal で API 未呼出・notifyOps なし', async () => {
    // 予約列は plan-sync RETURNING で残存 (dbScheduleId 非 null で delegate 到達) だが
    // clearReservationMatching の UPDATE は 0 行 (別処理が既に clear 済 = matched:false)。
    // release は releaseCompletedDowngrade の status gate が already_terminal を返し
    // API 未呼出・二重副作用なし。
    mockConstructEvent.mockReturnValue({
      id: 'evt_r_n3',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_r_n3',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    // release は既に終端 → already_terminal (API 未呼出)。 release throw しないので
    // notifyOps は不発。
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('already_terminal')
    // 2nd update (clear) は 0 行 match (matched:false)。
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_r_n3' }))
    expect(res.status).toBe(200)

    // clear は無条件先行するので release 結果に関わらず 2 回目の update が走る。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    // release は委譲される (status gate 側で already_terminal に落ちる)。
    expect(mockReleaseCompletedDowngrade).toHaveBeenCalledTimes(1)
    // 二重副作用なし: release 成功 (throw なし) ゆえ notifyOps は発火しない。
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('N-4: DB 予約が別 schedule/target に差替 (race) → clear matched:false・release へは進む', async () => {
    // clearReservationMatching は WHERE の schedule/target 照合で 0 行になるが、
    // matched:false は release を gate しない (clear 先行 → release は常に委譲)。
    mockConstructEvent.mockReturnValue({
      id: 'evt_r_n4',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_r_n4',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('released')
    // 2nd update (clear) は差替で 0 行 match。
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_r_n4' }))
    expect(res.status).toBe(200)

    // clear (0 行でも) 先行し、 release へ進む。
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    expect(mockReleaseCompletedDowngrade).toHaveBeenCalledWith('sched_x', 'autorelease:sched_x')
  })

  it('裏面: delegate で clear (DB) が throw → 伝播 (handler throw → 200 via outer catch) + release 未呼出', async () => {
    // clear throw は correctness 重大ゆえ握らず伝播する。 release へ進まない。
    mockConstructEvent.mockReturnValue({
      id: 'evt_r_back',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_r_back',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    const rejectingClear = chain()
    rejectingClear.then = (_onF: unknown, onRej: (e: unknown) => void) =>
      Promise.reject(new Error('clear failed')).then(undefined, onRej)
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(rejectingClear)

    const res = await POST(makeReq({ id: 'evt_r_back' }))
    // clear throw は outer catch で notifyWebhookError + 200。
    expect(res.status).toBe(200)
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)
    // clear が先行し throw したため release へ進まない。
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
  })

  it('null-guard #1: delegate 到達で dbTargetPriceId null → 手順0 notifyOps + clear せず return (予約維持)', async () => {
    // I-9 上ありえない破損 (schedule 有・target null)。 item price も null (missing)
    // のとき evaluateRelease は priceId(null)===dbTargetPriceId(null) で delegate に
    // 到達しうる。 delegate 冒頭の手順0 が null を弾き、 誤 clear せず notifyOps +
    // 予約維持 return する (型 narrowing + 防御)。
    mockConstructEvent.mockReturnValue({
      id: 'evt_r_ng1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          // item に price を持たせない → extractPriceId が null を返す。
          id: 'sub_ng1',
          status: 'active',
          customer: 'cus_r_ng1',
          schedule: 'sched_x',
          cancel_at: null,
          items: { data: [{ current_period_end: 1779999999 }] },
        },
      },
    })
    stubIdempotencyInsertOnce()
    // plan-sync RETURNING: schedule 有・target null (破損状態)。
    mockDbUpdate.mockReturnValueOnce(
      chain([
        {
          clerkId: 'user_gate',
          scheduledDowngradeScheduleId: 'sched_x',
          scheduledTargetPriceId: null,
        },
      ]),
    )

    const res = await POST(makeReq({ id: 'evt_r_ng1' }))
    expect(res.status).toBe(200)

    // delegate 手順0 が発火: clear なし・委譲なし・予約維持。 plan-sync の 1 回のみ。
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    // 手順0 の notifyOps (missing target price)。 missing_price anomaly の notify とは
    // 別 subject なので guard subject で明示照合する。
    expect(mockNotifyOps).toHaveBeenCalledWith(
      expect.stringMatching(/reservation missing target price/i),
      expect.objectContaining({ scheduleId: 'sched_x' }),
    )
  })

  it('subscription_schedule.released → 3 列冪等 clear (where on scheduledDowngradeScheduleId)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_rel_1',
      type: 'subscription_schedule.released',
      data: { object: { id: 'sched_x' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

    const res = await POST(makeReq({ id: 'evt_rel_1' }))
    expect(res.status).toBe(200)

    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    const clearSet = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
  })

  it('subscription_schedule.released で 0 行 match → 200・notifyOps なし (冪等)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_rel_2',
      type: 'subscription_schedule.released',
      data: { object: { id: 'sched_already_cleared' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([])) // 0 row

    const res = await POST(makeReq({ id: 'evt_rel_2' }))
    expect(res.status).toBe(200)

    expect(mockNotifyOps).not.toHaveBeenCalled()
    expect(mockNotifyWebhookError).not.toHaveBeenCalled()
  })

  it('§6.4.1 recovery: released 後の clear 失敗を .released が回収', async () => {
    // 1) .updated: delegate released → clear update が reject → outer catch で 200。
    mockConstructEvent.mockReturnValueOnce({
      id: 'evt_rec_1',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_rec',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('released')
    const rejectingClear = chain()
    rejectingClear.then = (_onF: unknown, onRej: (e: unknown) => void) =>
      Promise.reject(new Error('clear failed')).then(undefined, onRej)
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(rejectingClear)

    const res1 = await POST(makeReq({ id: 'evt_rec_1' }))
    expect(res1.status).toBe(200)
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)

    // 2) 別 .released event が clear を回収。
    mockConstructEvent.mockReturnValueOnce({
      id: 'evt_rec_2',
      type: 'subscription_schedule.released',
      data: { object: { id: 'sched_x' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

    const res2 = await POST(makeReq({ id: 'evt_rec_2' }))
    expect(res2.status).toBe(200)
    const recoverSet = (mockDbUpdate.mock.results[2].value as { set: ReturnType<typeof vi.fn> }).set
    expect(recoverSet).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDowngradeScheduleId: null }),
    )
  })

  it('.released 先着 → 後着 .updated は no-op (plan-sync returning が予約 null)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_order_1',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_order',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    // .released 先着で既に clear 済 → plan-sync returning の予約列は null。
    mockDbUpdate.mockReturnValueOnce(
      chain([{ clerkId: 'user_gate', scheduledDowngradeScheduleId: null, scheduledTargetPriceId: null }]),
    )

    const res = await POST(makeReq({ id: 'evt_order_1' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
  })

  it('customer.subscription.deleted → reset SET に 3 列 clear を含む', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_del_clear',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_del_clear' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: 'user_gate' }]))

    const res = await POST(makeReq({ id: 'evt_del_clear' }))
    expect(res.status).toBe(200)

    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
  })

  it('release gate: 委譲は customer.subscription.created では走らない', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_created_gate',
      type: 'customer.subscription.created',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_created_gate',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain(gateRow()))

    const res = await POST(makeReq({ id: 'evt_created_gate' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Task 4 (A-4): 退会自己誘発 webhook 偽アラートの root fix。
//
// 根本原因: clerkId 非 null を「UPDATE が行に match したか」の proxy に使うと、
// GDPR scrub 済み行 (clerkId=null だが行自体は存在 = stripeCustomerId で match)
// への正常な自己誘発 webhook を「行なし = 整合崩壊」と誤判定して notifyOps
// してしまう。「行 match の有無 (配列長)」と「clerkId の有無 (metadata sync
// 要否)」を分離することで、scrub 行は無害 skip・真の unlinked (行なし) だけ
// notifyOps を維持する。
// ---------------------------------------------------------------------------
describe('Stripe webhook: 退会自己誘発 webhook の偽アラート fix (Task 4 / A-4)', () => {
  it('(a) customer.subscription.deleted → scrub 行 (clerkId: null, 行 match) → notifyOps 不発 + syncClerkMetadata 不発', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_task4_a',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_scrubbed_del' } },
    })
    stubIdempotencyInsertOnce()
    // scrub 済み行: stripeCustomerId で match したので行は返るが clerkId は null。
    mockDbUpdate.mockReturnValueOnce(chain([{ clerkId: null }]))

    const res = await POST(makeReq({ id: 'evt_task4_a' }))
    expect(res.status).toBe(200)

    // DB 更新 (SET) 自体は従来どおり実行されている (行 match のため)。
    const setCall = (mockDbUpdate.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set
    expect(setCall).toHaveBeenCalledWith(expect.objectContaining({ plan: 'free' }))
    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('(b) customer.subscription.deleted → 行なし (returning []) → notifyOps 発火 (既存維持)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_task4_b',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_truly_unlinked_del' } },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_task4_b' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe sub event for unlinked customer',
      expect.objectContaining({
        eventId: 'evt_task4_b',
        customerId: 'cus_truly_unlinked_del',
        eventType: 'customer.subscription.deleted',
      }),
    )
  })

  it('(c) customer.subscription.updated → scrub 行 (clerkId: null, 行 match, 予約なし) → notifyOps 不発 + syncClerkMetadata 不発', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_task4_c',
      type: 'customer.subscription.updated',
      data: {
        object: sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_scrubbed_upd' }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(
      chain([
        {
          clerkId: null,
          scheduledDowngradeScheduleId: null,
          scheduledTargetPriceId: null,
        },
      ]),
    )

    const res = await POST(makeReq({ id: 'evt_task4_c' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
    // 予約なし (dbScheduleId null) のため gate 冒頭で早期 return。
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
  })

  it('(d) customer.subscription.updated → 行なし (returning []) → notifyOps 発火 (既存維持)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_task4_d',
      type: 'customer.subscription.updated',
      data: {
        object: sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_truly_unlinked_upd' }),
      },
    })
    stubIdempotencyInsertOnce()
    mockDbUpdate.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ id: 'evt_task4_d' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'stripe sub event for unlinked customer',
      expect.objectContaining({
        eventId: 'evt_task4_d',
        customerId: 'cus_truly_unlinked_upd',
        eventType: 'customer.subscription.updated',
      }),
    )
  })

  it('(e) customer.subscription.updated → scrub 行 (clerkId: null) + 予約 3 列あり → release gate は clerkId 無しでも評価される (Codex 論点)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_task4_e',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_scrubbed_gate',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    // scrub 行だが .deleted 先着で予約 3 列は通常 clear 済み → dbScheduleId null →
    // gate 冒頭の `if (!dbScheduleId) return` で無害 (releaseCompletedDowngrade 未呼出・
    // notifyOps 不発・throw なし)。
    mockDbUpdate.mockReturnValueOnce(
      chain([
        {
          clerkId: null,
          scheduledDowngradeScheduleId: null,
          scheduledTargetPriceId: null,
        },
      ]),
    )

    const res = await POST(makeReq({ id: 'evt_task4_e' }))
    expect(res.status).toBe(200)

    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
  })
})
