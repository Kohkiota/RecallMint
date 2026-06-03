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

vi.mock('@/lib/stripe', () => ({
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
})

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
  it('#1 + #5 充足 → releaseCompletedDowngrade 委譲 / released で 3 列 clear', async () => {
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
    // 1st = plan-sync (returning gateRow)、 2nd = clear update
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_gate_1' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).toHaveBeenCalledWith('sched_x', 'autorelease:sched_x')
    // 2nd update = 3 列 clear
    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledDowngradeScheduleId: null,
        scheduledTargetPriceId: null,
        scheduledChangeEffectiveAt: null,
      }),
    )
  })

  it('result = already_terminal でも 3 列 clear', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_2',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_gate_2',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('already_terminal')
    mockDbUpdate.mockReturnValueOnce(chain(gateRow())).mockReturnValueOnce(chain())

    const res = await POST(makeReq({ id: 'evt_gate_2' }))
    expect(res.status).toBe(200)

    expect(mockDbUpdate).toHaveBeenCalledTimes(2)
    const clearSet = (mockDbUpdate.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledDowngradeScheduleId: null }),
    )
  })

  it('result = skipped → clear しない (予約維持)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_gate_3',
      type: 'customer.subscription.updated',
      data: {
        object: sub({
          priceId: PRICE.STANDARD_MONTHLY,
          customerId: 'cus_gate_3',
          schedule: 'sched_x',
        }),
      },
    })
    stubIdempotencyInsertOnce()
    mockReleaseCompletedDowngrade.mockResolvedValueOnce('skipped')
    mockDbUpdate.mockReturnValueOnce(chain(gateRow()))

    const res = await POST(makeReq({ id: 'evt_gate_3' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).toHaveBeenCalledTimes(1)
    // plan-sync の 1 回のみ。clear update なし。
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
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

  it('sub.schedule = null (DB 予約あり) → no-op: 委譲なし・clear なし・mismatch notify なし', async () => {
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
    mockDbUpdate.mockReturnValueOnce(chain(gateRow()))

    const res = await POST(makeReq({ id: 'evt_gate_5' }))
    expect(res.status).toBe(200)

    expect(mockReleaseCompletedDowngrade).not.toHaveBeenCalled()
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    // mismatch notify は出ない (schedule null は released handler 担当)。
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
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      expect.stringMatching(/schedule.*mismatch/i),
      expect.objectContaining({ customerId: 'cus_gate_6' }),
    )
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
