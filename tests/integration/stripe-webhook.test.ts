import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Fake db: insert for stripe_events idempotency (returning[]) + update for users.
// A module-level Map tracks seen event ids across tests to simulate the
// ON CONFLICT DO NOTHING + RETURNING behavior.
// ---------------------------------------------------------------------------
const {
  mockDb,
  mockDbExecute,
  seenEventIds,
  mockStripeRetrieve,
  mockNotifyWebhookError,
} = vi.hoisted(() => {
  const seen = new Set<string>()
  const onConflictReturning = vi.fn()
  const insertValues = vi.fn()
  const insert = vi.fn()
  const updateSet = vi.fn()
  const updateWhere = vi.fn()
  const update = vi.fn()
  // RLS-P2 (Task 7): resolve (app_resolve_user_for_stripe) は db.execute で叩く。
  const execute = vi.fn()
  // withTenantTx が使う db.transaction。callback を実行し、tx は users write を担う
  // update / insert (module spy) と setTenantContext 用 execute (tx-local no-op) を渡す。
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert,
      update,
      execute: () => Promise.resolve([]),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve([]) }),
    }),
  )
  const mockStripeRetrieve = vi.fn()
  const mockNotifyWebhookError = vi.fn().mockResolvedValue(undefined)

  return {
    seenEventIds: seen,
    mockDb: {
      insert,
      update,
      execute,
      transaction,
      _chains: { onConflictReturning, insertValues, updateSet, updateWhere },
    },
    mockDbExecute: execute,
    mockStripeRetrieve,
    mockNotifyWebhookError,
  }
})

// RLS-P2 (Task 7): resolve が返す内部 id。tx-local set_config は mock では no-op ゆえ
// 実 uuid 妥当性は問われない (実 PG 検証は test:iso / Task 10)。
const RESOLVED_UUID = '00000000-0000-0000-0000-000000000001'

// Partial mock: preserve the real webhooks.constructEvent (used for signature
// verification with generateTestHeaderString) but override subscriptions.retrieve
// so tests can control the returned subscription without hitting Stripe.
vi.mock('@/lib/stripe/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/stripe/client')>()
  return {
    stripe: {
      ...actual.stripe,
      subscriptions: {
        retrieve: mockStripeRetrieve,
      },
    },
  }
})

// RLS-P3 (Task 1): route.ts event dedup + handle-stripe-event.ts pre-tenant
// resolve now call getNonTenantDb() (same underlying connection as getDb() —
// mechanical mock-target alias, assertions/behavior unchanged). getDb() itself
// remains used by evaluateReleaseGate's withTenantTx(getDb(), ...) call sites.
vi.mock('@/lib/db', () => ({ getDb: () => mockDb, getNonTenantDb: () => mockDb }))

vi.mock('@/lib/ops', () => ({
  notifyWebhookError: mockNotifyWebhookError,
  notifyOps: vi.fn().mockResolvedValue(undefined),
}))

// I-4 fix: integration test でも clerk-metadata helper を mock。 mock しないと
// route 内 syncClerkPublicMetadata が実 Clerk API call を試み、 ok:false が
// silent 帰ってきて Coverage が 0 になる。
vi.mock('@/lib/auth/clerk-metadata', () => ({
  syncClerkPublicMetadata: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '@/app/api/webhooks/stripe/route'

const SECRET = 'whsec_stripe_test_fake'

function signed(body: string): Request {
  const ts = Math.floor(Date.now() / 1000)
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: SECRET,
    timestamp: ts,
  })
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body,
  })
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  seenEventIds.clear()
  vi.clearAllMocks()

  // RLS-P2 (Task 7): resolve のデフォルト = 紐付き済み・退会前 (deleted_at null)。
  // 各 users-touching event はこれで tenant context を張り既存 write 群へ進む。
  mockDbExecute.mockResolvedValue([{ id: RESOLVED_UUID, deleted_at: null }])

  // insert(stripe_events).values({eventId, type}).onConflictDoNothing().returning()
  // Returns [{id}] for new events, [] for already-seen.
  mockDb.insert.mockImplementation(() => ({
    values: vi.fn((row: { eventId: string }) => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(() => {
          if (seenEventIds.has(row.eventId)) return Promise.resolve([])
          seenEventIds.add(row.eventId)
          return Promise.resolve([{ id: row.eventId }])
        }),
      })),
    })),
  }))

  // update(users).set(...).where(...) → thenable resolving to undefined
  mockDb.update.mockImplementation(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }))
})

describe('POST /api/webhooks/stripe', () => {
  it('bad signature → 400', async () => {
    const req = new Request('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 't=0,v1=deadbeef' },
      body: '{}',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('checkout.session.completed → users.stripe_customer_id 紐付け', async () => {
    const body = JSON.stringify({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          client_reference_id: 'user_abc',
          customer: 'cus_1',
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockDb.update).toHaveBeenCalledOnce()
  })

  it('customer.subscription.created → plan=pro + status=active + periodEnd', async () => {
    const body = JSON.stringify({
      id: 'evt_sub_created_1',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockDb.update).toHaveBeenCalledOnce()
  })

  it('customer.subscription.updated (past_due) → status=past_due、plan は pro 維持', async () => {
    const body = JSON.stringify({
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'past_due',
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockDb.update).toHaveBeenCalledOnce()
  })

  it('customer.subscription.deleted → plan=free + status=canceled + cancel reset', async () => {
    const body = JSON.stringify({
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'canceled',
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockDb.update).toHaveBeenCalledOnce()
  })

  it('duplicate event_id → 200 skip、update なし', async () => {
    const body = JSON.stringify({
      id: 'evt_dup_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } },
    })
    // First delivery
    const res1 = await POST(signed(body))
    expect(res1.status).toBe(200)
    expect(mockDb.update).toHaveBeenCalledOnce()

    // Second delivery — idempotent
    const res2 = await POST(signed(body))
    expect(res2.status).toBe(200)
    // still once from the first delivery; duplicate did NOT trigger update
    expect(mockDb.update).toHaveBeenCalledOnce()
  })

  // Fix 3 (Sprint 6.2 I-2): checkout.session.completed with subscription field
  // → retrieves sub directly + performs 2nd update to sync plan/status/periodEnd
  it('checkout.session.completed with subscription → retrieve + plan sync (2 updates)', async () => {
    mockStripeRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      customer: 'cus_1',
      items: { data: [{ current_period_end: 1735689600 }] },
    })

    const body = JSON.stringify({
      id: 'evt_checkout_with_sub',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_2',
          client_reference_id: 'user_abc',
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)

    // Both the customer-link update and the plan-sync update must have fired
    expect(mockDb.update).toHaveBeenCalledTimes(2)

    // The subscription was retrieved with the correct sub ID
    expect(mockStripeRetrieve).toHaveBeenCalledWith('sub_1')
  })

  // Fix 3 (Sprint 6.2 I-2): checkout.session.completed without subscription field
  // → only the customer-link update fires; no retrieve call
  it('checkout.session.completed without subscription → customer link only, no retrieve', async () => {
    const body = JSON.stringify({
      id: 'evt_checkout_no_sub',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_3',
          client_reference_id: 'user_abc',
          customer: 'cus_1',
          subscription: null,
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)

    // Only the customer-link update
    expect(mockDb.update).toHaveBeenCalledOnce()

    // No subscription retrieve since session has no subscription
    expect(mockStripeRetrieve).not.toHaveBeenCalled()
  })

  // Case A: subscription.updated で cancel_at_period_end=true + cancel_at 値
  // → DB に cancelAt=Date が書き込まれる (cancelAtPeriodEnd は廃止、cancel_at != null で解約予約判定)
  it('customer.subscription.updated cancel_at set → cancelAt=Date (cancel_at_period_end は無視)', async () => {
    const cancelAtTs = 1740000000 // 任意の Unix epoch
    const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.update.mockImplementation(() => ({ set: mockSet }))

    const body = JSON.stringify({
      id: 'evt_sub_cancel_true',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_2',
          customer: 'cus_2',
          status: 'active',
          cancel_at_period_end: true,
          cancel_at: cancelAtTs,
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelAt: new Date(cancelAtTs * 1000),
      }),
    )
    // cancelAtPeriodEnd は schema から削除済み、handler も write しない
    const setArg = (mockSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(setArg).not.toHaveProperty('cancelAtPeriodEnd')
  })

  // Case B: subscription.updated で cancel_at=null (解約予約撤回)
  // → DB に cancelAt=null が書き込まれる (cancelAtPeriodEnd は廃止)
  it('customer.subscription.updated cancel_at=null → cancelAt=null reset (解約予約撤回)', async () => {
    const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.update.mockImplementation(() => ({ set: mockSet }))

    const body = JSON.stringify({
      id: 'evt_sub_cancel_false',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_3',
          customer: 'cus_3',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelAt: null,
      }),
    )
    // cancelAtPeriodEnd は schema から削除済み、handler も write しない
    const setArg = (mockSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(setArg).not.toHaveProperty('cancelAtPeriodEnd')
  })

  // Case C: subscription.deleted → cancelAt=null reset
  // currentPeriodEnd は touch されないことも確認 (cancelAtPeriodEnd は廃止)
  it('customer.subscription.deleted → cancelAt=null reset (currentPeriodEnd untouched, cancelAtPeriodEnd 廃止)', async () => {
    const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.update.mockImplementation(() => ({ set: mockSet }))

    const body = JSON.stringify({
      id: 'evt_sub_deleted_2',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_4',
          customer: 'cus_4',
          status: 'canceled',
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'free',
        subscriptionStatus: 'canceled',
        cancelAt: null,
      }),
    )
    // cancelAtPeriodEnd は schema から削除済み、handler も write しない
    const setArg = (mockSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]
    expect(setArg).not.toHaveProperty('cancelAtPeriodEnd')
    // currentPeriodEnd should NOT be in the set payload for deleted events
    expect(setArg).not.toHaveProperty('currentPeriodEnd')
  })

  // E-3: outer catch error path
  // handler 内 throw → 200 swallow + notifyWebhookError 呼ばれる
  // (CLAUDE.md §Stripe-5: エラー時も 200 を返す、再送ループ防止)
  it('handler error → 200 swallow + notifyWebhookError 呼ばれる (handler/eventId/eventType/customerId)', async () => {
    // Force the users update to throw, simulating a DB write failure。
    // C1 publicMetadata sync 追加で `.returning()` が chain に挟まったため、
    // where() の次に returning() で reject させる (旧来の where() reject pattern を
    // 維持すると "where(...).returning is not a function" になり Error が変わる)。
    mockDb.update.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockRejectedValue(new Error('boom: db down')),
        })),
      })),
    }))

    const body = JSON.stringify({
      id: 'evt_outer_catch_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_x',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)
    const arg = mockNotifyWebhookError.mock.calls[0][0] as {
      handler: string
      eventId: string
      eventType: string
      err: unknown
      customerId?: string
    }
    expect(arg.handler).toBe('stripe')
    expect(arg.eventId).toBe('evt_outer_catch_1')
    expect(arg.eventType).toBe('customer.subscription.updated')
    expect(arg.customerId).toBe('cus_x')
    expect(arg.err).toBeInstanceOf(Error)
    expect((arg.err as Error).message).toBe('boom: db down')
    // Spec §2 invariant: environment / timestamp は callsite では渡さず helper 内部で
    // 自動付与する。callsite 引数に load されたら spec drift。
    expect(arg).not.toHaveProperty('environment')
    expect(arg).not.toHaveProperty('timestamp')
  })

  // Case D: subscription.created で items.data[0].current_period_end から正しく Date 化
  // Unix epoch → new Date(ts * 1000) の境界値テスト
  it('customer.subscription.created → items.data[0].current_period_end が Date 化される境界値', async () => {
    const periodEndTs = 1730000000 // 境界値: 任意の Unix epoch
    const mockSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.update.mockImplementation(() => ({ set: mockSet }))

    const body = JSON.stringify({
      id: 'evt_sub_created_boundary',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_5',
          customer: 'cus_5',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ current_period_end: periodEndTs }] },
        },
      },
    })
    const res = await POST(signed(body))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPeriodEnd: new Date(periodEndTs * 1000),
      }),
    )
  })

  // -------------------------------------------------------------------------
  // F1 golden (Phase G): retrieve reject の 200-swallow と、created 先着 → checkout
  // 後着の順序 recovery を end-to-end で pin。 現行実挙動を観測して固定。
  // -------------------------------------------------------------------------

  // G3: checkout.session.completed で subscriptions.retrieve が reject。
  // Step1 (customer link の db.update) は実行済、 Step2 (plan sync) は throw →
  // outer catch → notifyWebhookError + HTTP 200。 Step2 の plan 書込は起きない
  // (= db.update は Step1 の 1 回のみ)。
  it('checkout.session.completed で subscriptions.retrieve reject → Step1 のみ実行・notifyWebhookError・200 (Step2 plan 書込なし)', async () => {
    mockStripeRetrieve.mockRejectedValueOnce(new Error('stripe 5xx: retrieve failed'))

    const body = JSON.stringify({
      id: 'evt_checkout_retrieve_reject',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_retrieve_reject',
          client_reference_id: 'user_rr',
          customer: 'cus_rr',
          subscription: 'sub_rr',
        },
      },
    })
    const res = await POST(signed(body))

    // outer catch で 200 を返す (Stripe 再送ループ防止)。
    expect(res.status).toBe(200)
    // Step1 (customer link) の 1 回のみ。 Step2 の plan-sync update は到達しない。
    expect(mockDb.update).toHaveBeenCalledOnce()
    // retrieve は正しい subId で呼ばれ reject。
    expect(mockStripeRetrieve).toHaveBeenCalledWith('sub_rr')
    // outer catch → notifyWebhookError 発火 (handler=stripe / eventId / eventType)。
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)
    const arg = mockNotifyWebhookError.mock.calls[0][0] as {
      handler: string
      eventId: string
      eventType: string
      customerId?: string
    }
    expect(arg.handler).toBe('stripe')
    expect(arg.eventId).toBe('evt_checkout_retrieve_reject')
    expect(arg.eventType).toBe('checkout.session.completed')
    expect(arg.customerId).toBe('cus_rr')
  })

  // G6: customer.subscription.created が customer 未 link で先着 (db.update が
  // 0 行 match = returning [])。 現行は silent (notifyOps 不発)。 その後
  // checkout.session.completed 後着で customer link + plan sync 完了。 順序 recovery。
  it('subscription.created 先着 (unlinked, returning []) は silent → 後着 checkout.session.completed で link + plan sync 完了', async () => {
    const { notifyOps } = await import('@/lib/ops')
    const mockNotifyOps = vi.mocked(notifyOps)

    // --- 1) subscription.created 先着: stripeCustomerId 未 link で 0 行 match ---
    // .created/.updated handler は .where().returning() を呼ぶため returning chain 必要。
    mockDb.update.mockImplementationOnce(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]), // 0 行 match
        })),
      })),
    }))

    const createdBody = JSON.stringify({
      id: 'evt_created_first',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_order',
          customer: 'cus_order_new',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO_MONTHLY }, current_period_end: 1735689600 }] },
        },
      },
    })
    const resCreated = await POST(signed(createdBody))
    expect(resCreated.status).toBe(200)
    // 現行挙動: .created の unlinked は transient race として silent (notifyOps 不発)。
    expect(mockNotifyOps).not.toHaveBeenCalled()

    // --- 2) checkout.session.completed 後着: link + plan sync 完了 ---
    mockStripeRetrieve.mockResolvedValueOnce({
      id: 'sub_order',
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      customer: 'cus_order_new',
      items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO_MONTHLY }, current_period_end: 1735689600 }] },
    })
    // Step1 (customer link) は default mock、 Step2 (plan sync) は returning に clerkId。
    const step2Set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ clerkId: 'user_order' }]),
      })),
    }))
    mockDb.update
      .mockImplementationOnce(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }))
      .mockImplementationOnce(() => ({ set: step2Set }))

    const checkoutBody = JSON.stringify({
      id: 'evt_checkout_after',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_after',
          client_reference_id: 'user_order',
          customer: 'cus_order_new',
          subscription: 'sub_order',
        },
      },
    })
    const resCheckout = await POST(signed(checkoutBody))
    expect(resCheckout.status).toBe(200)
    // Step2 plan sync が pro を書き込む (= recovery 成立)。
    expect(step2Set).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'pro', subscriptionStatus: 'active' }),
    )
  })
})

// ---------------------------------------------------------------------------
// RLS-P2 (Task 7): 退会済み user (resolve が deleted_at 非 null を返す) 宛の Stripe
// event は log + skip する (新規の明示挙動: 現状は scrub 済み行にも silent write が
// 通り得た。spec §2.5 / §7-2)。skip = users write なし・外部 I/O (notifyOps / Clerk
// sync / Stripe retrieve) なし・warn を PII/id なしで 1 行残す・200。
// ---------------------------------------------------------------------------
describe('POST /api/webhooks/stripe: 退会済み user は log + skip (RLS-P2 Task 7)', () => {
  async function opsMock() {
    const { notifyOps } = await import('@/lib/ops')
    return vi.mocked(notifyOps)
  }
  async function clerkMock() {
    const { syncClerkPublicMetadata } = await import('@/lib/auth/clerk-metadata')
    return vi.mocked(syncClerkPublicMetadata)
  }

  it('customer.subscription.deleted → 退会済み: write なし・notifyOps/Clerk sync なし・warn 1 行 (PII なし)・200', async () => {
    mockDbExecute.mockResolvedValue([
      { id: RESOLVED_UUID, deleted_at: '2026-07-01T00:00:00.000Z' },
    ])
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const notifyOps = await opsMock()
    const syncClerk = await clerkMock()

    const body = JSON.stringify({
      id: 'evt_deleted_user_del',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_z', customer: 'cus_deleted', status: 'canceled' } },
    })
    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    // skip: users write (update) は一切呼ばれない。
    expect(mockDb.update).not.toHaveBeenCalled()
    // 外部副作用は skip より先にも後にも起きない。
    expect(notifyOps).not.toHaveBeenCalled()
    expect(syncClerk).not.toHaveBeenCalled()
    // warn 1 行: event + type のみ、PII/id は載せない。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.event).toBe('stripe.event.skipped_deleted_user')
    expect(payload.type).toBe('customer.subscription.deleted')
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('customerId')
    expect(payload).not.toHaveProperty('userId')
    warnSpy.mockRestore()
  })

  it('customer.subscription.updated → 退会済み: write なし・notifyOps (unlinked/anomaly) なし・200', async () => {
    mockDbExecute.mockResolvedValue([
      { id: RESOLVED_UUID, deleted_at: '2026-07-01T00:00:00.000Z' },
    ])
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const notifyOps = await opsMock()

    const body = JSON.stringify({
      id: 'evt_deleted_user_upd',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_z',
          customer: 'cus_deleted',
          status: 'active',
          cancel_at: null,
          items: { data: [{ current_period_end: 1735689600 }] },
        },
      },
    })
    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(notifyOps).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('checkout.session.completed → 退会済み: users link write なし・Stripe retrieve なし・200', async () => {
    mockDbExecute.mockResolvedValue([
      { id: RESOLVED_UUID, deleted_at: '2026-07-01T00:00:00.000Z' },
    ])
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const body = JSON.stringify({
      id: 'evt_deleted_user_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_z',
          client_reference_id: 'user_deleted',
          customer: 'cus_deleted',
          subscription: 'sub_z',
        },
      },
    })
    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    // Step 1 (customer link) も Step 2 (retrieve + projection) も走らない。
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(mockStripeRetrieve).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  // 上の checkout test は clerkId resolve が deleted 行を直接返す変種だが、実際の
  // scrub は clerk_id=NULL 化 + deleted_at 付与するのが正なので scrub 済み user は
  // clerkId では引けない (resolve []=null)。この場合 checkout は clerkId miss →
  // customerId fallback resolve で退会判定して log+skip する必要がある (canonical/
  // Codex Important: 他 path は元々 customerId 解決で deleted を捕捉済みだが checkout
  // だけ clerkId 単独ゆえ deleted user を unlinked 経路に取りこぼして Stripe retrieve
  // まで走らせていた)。
  it('checkout.session.completed → 退会済み (clerk_id=NULL scrub): clerkId resolve [] → customerId fallback で deleted 検出 → link/retrieve なし・warn 1 行 (PII なし)・200', async () => {
    // 1 回目 (clerkId resolve) = [] (scrub で clerk_id NULL)、2 回目 (customerId
    // fallback resolve) = deleted_at 付き行。resolveStripeUser は rows[0] で判定。
    mockDbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: RESOLVED_UUID, deleted_at: '2026-07-01T00:00:00.000Z' }])
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const notifyOps = await opsMock()
    const syncClerk = await clerkMock()

    const body = JSON.stringify({
      id: 'evt_deleted_scrub_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_scrub',
          client_reference_id: 'user_scrubbed',
          customer: 'cus_scrubbed',
          subscription: 'sub_scrub',
        },
      },
    })
    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    // customerId fallback が deleted を検出 → skip: Step1 link write も Step2 retrieve
    // も走らない (fallback なしなら retrieve('sub_scrub') が走り warn は 0 → red)。
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(mockStripeRetrieve).not.toHaveBeenCalled()
    expect(notifyOps).not.toHaveBeenCalled()
    expect(syncClerk).not.toHaveBeenCalled()
    // warn 1 行: event + type のみ、PII/id は載せない。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.event).toBe('stripe.event.skipped_deleted_user')
    expect(payload.type).toBe('checkout.session.completed')
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('customerId')
    expect(payload).not.toHaveProperty('userId')
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// RLS-P2 (Task 7): unlinked user = resolve が [] (該当行なし) を返すと resolved=null。
// 退会 skip (deleted_at 非 null) とは別経路で、resolved=null の新分岐を駆動する:
//   - checkout Step 1 の `if (resolved)` (customer link を発行しない)
//   - projectStripeSubscription の `userId === null` 早期 return (DB/Clerk を触らず
//     UNMATCHED_RESULT を返す) — checkout Step 2 と .updated の両経路から到達
// 既存の "unlinked" test は mockDb.update.returning([]) で旧 0 行 match を模しており
// resolve のデフォルトは resolved 済み id ゆえ、この resolve=null の新経路は未駆動
// だった (canonical review Important)。挙動不変 = users write なし・Clerk sync なし・
// old 0 行 match と同じ unlinked routing (checkout=silent / .updated=notifyOps)・200。
// ---------------------------------------------------------------------------
describe('POST /api/webhooks/stripe: unlinked user は resolve=null 経路で 0 行 match 相当 (RLS-P2 Task 7)', () => {
  async function opsMock() {
    const { notifyOps } = await import('@/lib/ops')
    return vi.mocked(notifyOps)
  }
  async function clerkMock() {
    const { syncClerkPublicMetadata } = await import('@/lib/auth/clerk-metadata')
    return vi.mocked(syncClerkPublicMetadata)
  }

  it('checkout.session.completed → unlinked (resolve []): Step1 customer link write なし・Step2 projection write/Clerk sync なし・notifyOps なし・200', async () => {
    // resolve 0 行 → resolveStripeUser が null を返す (rows[0] undefined)。
    mockDbExecute.mockResolvedValue([])
    const notifyOps = await opsMock()
    const syncClerk = await clerkMock()
    // 既知 price → projectStripeSubscription 内の anomaly notify は発火しない
    // (userId===null 早期 return のみを純粋に観測するため)。
    mockStripeRetrieve.mockResolvedValueOnce({
      id: 'sub_u',
      status: 'active',
      cancel_at: null,
      customer: 'cus_unlinked',
      items: {
        data: [
          { price: { id: process.env.STRIPE_PRICE_PRO_MONTHLY }, current_period_end: 1735689600 },
        ],
      },
    })

    const body = JSON.stringify({
      id: 'evt_unlinked_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_u',
          client_reference_id: 'user_unlinked',
          customer: 'cus_unlinked',
          subscription: 'sub_u',
        },
      },
    })
    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    // Step 1 は `if (resolved)` が false ゆえ customer link を発行しない。 Step 2 は
    // projectStripeSubscription(userId=null) が DB を触らず UNMATCHED_RESULT を返す。
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(syncClerk).not.toHaveBeenCalled()
    // checkout unlinked は silent (old Step2 returning [] path と同じ、notifyOps 不発)。
    expect(notifyOps).not.toHaveBeenCalled()
  })

  it('customer.subscription.updated → unlinked (resolve []): saveProjection write なし・Clerk sync なし・notifyOps (unlinked anomaly) 発火・200', async () => {
    // resolve 0 行 → resolveStripeUser が null → projectStripeSubscription(userId=null)。
    mockDbExecute.mockResolvedValue([])
    const notifyOps = await opsMock()
    const syncClerk = await clerkMock()

    const body = JSON.stringify({
      id: 'evt_unlinked_upd',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_u',
          customer: 'cus_unlinked',
          status: 'active',
          cancel_at: null,
          items: {
            data: [
              { price: { id: process.env.STRIPE_PRICE_PRO_MONTHLY }, current_period_end: 1735689600 },
            ],
          },
        },
      },
    })
    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    // userId=null ゆえ saveProjection (users write) は発行されない。
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(syncClerk).not.toHaveBeenCalled()
    // .updated の unlinked = OT 介入対象 anomaly → notifyOps (old returning [] path と同じ)。
    expect(notifyOps).toHaveBeenCalledTimes(1)
    expect(notifyOps).toHaveBeenCalledWith(
      'stripe sub event for unlinked customer',
      expect.objectContaining({
        eventId: 'evt_unlinked_upd',
        customerId: 'cus_unlinked',
        eventType: 'customer.subscription.updated',
      }),
    )
  })
})
