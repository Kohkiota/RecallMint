import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Fake db: insert for stripe_events idempotency (returning[]) + update for users.
// A module-level Map tracks seen event ids across tests to simulate the
// ON CONFLICT DO NOTHING + RETURNING behavior.
// ---------------------------------------------------------------------------
const { mockDb, seenEventIds, mockStripeRetrieve, mockNotifyWebhookError } =
  vi.hoisted(() => {
    const seen = new Set<string>()
    const onConflictReturning = vi.fn()
    const insertValues = vi.fn()
    const insert = vi.fn()
    const updateSet = vi.fn()
    const updateWhere = vi.fn()
    const update = vi.fn()
    const mockStripeRetrieve = vi.fn()
    const mockNotifyWebhookError = vi.fn().mockResolvedValue(undefined)

    return {
      seenEventIds: seen,
      mockDb: {
        insert,
        update,
        _chains: { onConflictReturning, insertValues, updateSet, updateWhere },
      },
      mockStripeRetrieve,
      mockNotifyWebhookError,
    }
  })

// Partial mock: preserve the real webhooks.constructEvent (used for signature
// verification with generateTestHeaderString) but override subscriptions.retrieve
// so tests can control the returned subscription without hitting Stripe.
vi.mock('@/lib/stripe', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/stripe')>()
  return {
    stripe: {
      ...actual.stripe,
      subscriptions: {
        retrieve: mockStripeRetrieve,
      },
    },
  }
})

vi.mock('@/lib/db', () => ({ getDb: () => mockDb }))

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
})
