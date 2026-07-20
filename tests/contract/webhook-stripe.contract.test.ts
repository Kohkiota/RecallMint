/**
 * tests/contract/webhook-stripe.contract.test.ts
 *
 * Wire-contract snapshot for POST /api/webhooks/stripe.
 *
 * Frozen faces (spec §3.2 webhook row + P0 brief):
 * 1. 400-vs-200 separation (unambiguous):
 *    - missing stripe-signature header → HTTP 400, body 'missing stripe-signature'
 *    - invalid signature (constructEvent throws) → HTTP 400, body 'invalid signature'
 *    - duplicate event_id → HTTP 200, body 'duplicate'
 *    - unknown/unsupported event → HTTP 200, body 'ok'
 *    - handler error (outer catch) → HTTP 200, body 'handler error swallowed'
 * 2. Status matrix — captured users UPDATE extracted scalar values:
 *    - active → subscriptionStatus='active', plan resolved from price_id
 *    - trialing → subscriptionStatus='active' (normalizes same as active)
 *    - past_due → subscriptionStatus='past_due', plan preserved (NOT downgraded)
 *    - unpaid → subscriptionStatus='past_due' BUT plan='free' (§A #14 asymmetry)
 *    - incomplete → subscriptionStatus='past_due' BUT plan='free' (same as unpaid)
 *    - canceled → subscriptionStatus='canceled', plan='free'
 *    - incomplete_expired → subscriptionStatus='canceled', plan='free'
 *    - unknown price_id → notifyOps subject + plan='free' fallback
 * 3. Added events:
 *    - checkout.session.completed (subscription retrieve path, plan sync)
 *    - invoice.payment_failed (notifyOps, no plan/status DB change)
 *    - subscription_schedule.released (3 scheduled cols cleared to null)
 *    - unknown event type → no-op, HTTP 200 'ok', no DB update
 *
 * NOT frozen: timing/ops payloads, logger call details, Stripe API shapes,
 *             currentPeriodEnd/cancelAt Date objects (implementation-fragile).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks (must be before vi.mock calls) ─────────────────────────────
const {
  mockConstructEvent,
  mockDbInsert,
  mockDbUpdate,
  mockDbExecute,
  mockSubscriptionsRetrieve,
  mockNotifyOps,
  mockNotifyWebhookError,
  mockSyncClerkMetadata,
  mockReleaseCompletedDowngrade,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  // RLS-P2 (Task 7): resolve (app_resolve_user_for_stripe) は db.execute で叩く。
  mockDbExecute: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockNotifyOps: vi.fn().mockResolvedValue(undefined),
  mockNotifyWebhookError: vi.fn().mockResolvedValue(undefined),
  mockSyncClerkMetadata: vi.fn().mockResolvedValue({ ok: true }),
  mockReleaseCompletedDowngrade: vi.fn().mockResolvedValue('released'),
}))

// RLS-P2 (Task 7): resolve が返す内部 id (tx-local set_config は mock では no-op)。
const RESOLVED_UUID = '00000000-0000-0000-0000-000000000001'

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    insert: mockDbInsert,
    update: mockDbUpdate,
    execute: mockDbExecute,
    // withTenantTx の db.transaction: callback を実行し、tx は users write の update /
    // insert (module spy) + setTenantContext 用 execute (tx-local no-op) を渡す。
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: mockDbInsert,
        update: mockDbUpdate,
        execute: () => Promise.resolve([]),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        delete: () => ({ where: () => Promise.resolve([]) }),
      }),
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

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// ── Route under test ──────────────────────────────────────────────────────────
import { POST } from '../../app/api/webhooks/stripe/route'

// ── Fixtures ──────────────────────────────────────────────────────────────────
import { makeReq, stubIdempotencyInsertOnce, sub, PRICE } from '../fixtures/webhooks-stripe'

// ── Local chain mock ──────────────────────────────────────────────────────────
// Defined locally (not re-exported from fixture) to avoid vi.resetModules()
// live-binding invalidation between beforeEach and test body execution.
function chain(resolveTo: unknown = undefined): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  const self = () => c
  c.values = vi.fn(self)
  c.onConflictDoNothing = vi.fn(self)
  c.returning = vi.fn(self)
  c.set = vi.fn(self)
  c.where = vi.fn(self)
  c.from = vi.fn(self)
  c.limit = vi.fn(self)
  c.then = (onFulfilled: (v: unknown) => void) =>
    Promise.resolve(resolveTo).then(onFulfilled)
  return c
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks()
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_contract_stripe'
  mockNotifyOps.mockResolvedValue(undefined)
  mockSyncClerkMetadata.mockResolvedValue({ ok: true })
  mockReleaseCompletedDowngrade.mockResolvedValue('released')
  // RLS-P2 (Task 7): resolve のデフォルト = 紐付き済み・退会前 (deleted_at null)。
  mockDbExecute.mockResolvedValue([{ id: RESOLVED_UUID, deleted_at: null }])
})

// ── Capture helper ────────────────────────────────────────────────────────────
/**
 * Extract scalar plan/status mutation values from the nth mockDbUpdate call.
 * Only picks primitives (plan, subscriptionStatus, billingInterval) — avoids
 * Date objects and SQL expressions that would make snapshots non-deterministic.
 */
function captureSubMutation(updateResultIndex = 0): {
  plan: unknown
  subscriptionStatus: unknown
  billingInterval: unknown
} {
  const c = mockDbUpdate.mock.results[updateResultIndex]?.value as {
    set: ReturnType<typeof vi.fn>
  }
  const args = c.set.mock.calls[0]?.[0] as Record<string, unknown>
  return {
    plan: args.plan,
    subscriptionStatus: args.subscriptionStatus,
    billingInterval: args.billingInterval,
  }
}

// ── 1. 400-vs-200 separation ──────────────────────────────────────────────────

describe('Stripe webhook: 400-vs-200 separation', () => {
  it('missing stripe-signature header → HTTP 400 (NOT in 200 group)', async () => {
    // No stripe-signature header → route returns 400 before constructEvent
    const req = new Request('https://test/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const res = await POST(req)
    const body = await res.text()
    // Hard assert: 400 is unambiguously separate from all 200 paths
    expect(res.status).toBe(400)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('invalid signature (constructEvent throws) → HTTP 400 (NOT in 200 group)', async () => {
    // stripe-signature present but constructEvent rejects it
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })
    const res = await POST(makeReq({}))
    const body = await res.text()
    // Hard assert: 400, distinct from the 200 'handler error swallowed' group
    expect(res.status).toBe(400)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('duplicate event_id → HTTP 200, body=duplicate (200 group)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_dup_contract',
      type: 'customer.subscription.updated',
      data: { object: {} },
    })
    // Idempotency INSERT ON CONFLICT DO NOTHING → returning [] = already processed
    mockDbInsert.mockReturnValueOnce(chain([]))
    const res = await POST(makeReq({}))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('unknown/unsupported event → HTTP 200, body=ok (200 group)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_unk_contract',
      type: 'payment_intent.created',
      data: { object: {} },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    const res = await POST(makeReq({}))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('handler error (outer catch swallows) → HTTP 200, body=handler error swallowed (200 group)', async () => {
    // Valid event + idempotency passes, but DB update throws inside handleEvent
    mockConstructEvent.mockReturnValue({
      id: 'evt_err_contract',
      type: 'customer.subscription.created',
      data: { object: sub({ priceId: PRICE.STANDARD_MONTHLY, customerId: 'cus_err' }) },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    // DB update throws → handleEvent propagates → outer catch → 200
    mockDbUpdate.mockImplementationOnce(() => {
      throw new Error('DB connection lost')
    })
    const res = await POST(makeReq({}))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({ status: res.status, body }).toMatchSnapshot()
  })
})

// ── 2. Status matrix ──────────────────────────────────────────────────────────

describe('Stripe webhook: status matrix (captured users UPDATE mutation — extracted scalars only)', () => {
  /**
   * Set up a customer.subscription.updated event with the given status + priceId.
   * Returns clerkId from the DB update mock so release gate runs (but early-returns
   * because dbScheduleId=null). Keeps mock call count predictable.
   */
  function setupSubUpdated(status: string, priceId: string, customerId = 'cus_matrix'): void {
    mockConstructEvent.mockReturnValue({
      id: `evt_matrix_${status}`,
      type: 'customer.subscription.updated',
      data: { object: sub({ priceId, status, customerId }) },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    mockDbUpdate.mockReturnValueOnce(
      chain([
        {
          clerkId: 'user_clerk_matrix',
          scheduledDowngradeScheduleId: null, // gate early-returns → no extra DB calls
          scheduledTargetPriceId: null,
        },
      ]),
    )
  }

  it('active → subscriptionStatus=active, plan resolved from price_id', async () => {
    setupSubUpdated('active', PRICE.STANDARD_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('trialing → subscriptionStatus=active (trialing normalizes same as active)', async () => {
    setupSubUpdated('trialing', PRICE.PRO_YEARLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('past_due → subscriptionStatus=past_due, plan preserved from price_id (NOT downgraded)', async () => {
    setupSubUpdated('past_due', PRICE.PRO_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('unpaid → subscriptionStatus=past_due BUT plan=free (§A #14 intentional asymmetry)', async () => {
    // KEY CONTRACT: normalizeSubStatus('unpaid')='past_due' BUT resolvePlanFromSub
    // re-checks original status and returns plan='free'. This is the §A #14 asymmetry.
    setupSubUpdated('unpaid', PRICE.PRO_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('incomplete → subscriptionStatus=past_due BUT plan=free (same as unpaid path)', async () => {
    setupSubUpdated('incomplete', PRICE.STANDARD_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('canceled → subscriptionStatus=canceled, plan=free', async () => {
    setupSubUpdated('canceled', PRICE.PRO_YEARLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('incomplete_expired → subscriptionStatus=canceled, plan=free', async () => {
    setupSubUpdated('incomplete_expired', PRICE.STANDARD_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('unknown price_id → notifyOps subject + plan=free fallback', async () => {
    // price_id not in env mapping → notifyOps('stripe sub unknown price_id') + plan='free'
    mockConstructEvent.mockReturnValue({
      id: 'evt_unk_price',
      type: 'customer.subscription.updated',
      data: {
        object: sub({ priceId: 'price_completely_unknown_xyz', status: 'active', customerId: 'cus_unk_price' }),
      },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    mockDbUpdate.mockReturnValueOnce(
      chain([
        {
          clerkId: 'user_clerk_unk',
          scheduledDowngradeScheduleId: null,
          scheduledTargetPriceId: null,
        },
      ]),
    )
    await POST(makeReq({}))
    expect({
      mutation: captureSubMutation(),
      notifyOpsSubject: (mockNotifyOps.mock.calls[0]?.[0] as string) ?? null,
    }).toMatchSnapshot()
  })

  // F1 golden (Phase G): normalizeSubStatus の default 分岐を pin。 'paused' も
  // 型に無い未知 status も default → canceled に落ち plan=free になる現行挙動を
  // snapshot で固定する (後続 R phase で凍結対象)。
  it('paused → normalizeSubStatus default で subscriptionStatus=canceled, plan=free', async () => {
    setupSubUpdated('paused', PRICE.PRO_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })

  it('unknown status (型に無い値) → default 分岐で subscriptionStatus=canceled, plan=free', async () => {
    setupSubUpdated('future_status' as string, PRICE.PRO_MONTHLY)
    await POST(makeReq({}))
    expect(captureSubMutation()).toMatchSnapshot()
  })
})

// ── 3. Added events ───────────────────────────────────────────────────────────

describe('Stripe webhook: added events', () => {
  it('checkout.session.completed → plan/status synced via subscription retrieve (2nd update)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_co_contract',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_clerk_co',
          customer: 'cus_co',
          subscription: 'sub_co',
        },
      },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      sub({ priceId: PRICE.STANDARD_MONTHLY, status: 'active', customerId: 'cus_co' }),
    )
    // Step 1: stripeCustomerId link (no return value checked by route)
    // Step 2: plan/status sync with returning clerkId
    mockDbUpdate
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain([{ clerkId: 'user_clerk_co' }]))

    const res = await POST(makeReq({}))
    expect(res.status).toBe(200)
    // Capture 2nd update (index 1) — that's where plan/status are written
    expect({ status: res.status, mutation: captureSubMutation(1) }).toMatchSnapshot()
  })

  it('invoice.payment_failed → notifyOps fired, NO plan/status DB change', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_pf_contract',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_pf' } },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    const res = await POST(makeReq({}))
    expect(res.status).toBe(200)
    expect({
      dbUpdateCallCount: mockDbUpdate.mock.calls.length,
      notifyOpsSubject: (mockNotifyOps.mock.calls[0]?.[0] as string) ?? null,
    }).toMatchSnapshot()
  })

  it('subscription_schedule.released → 3 scheduled cols cleared to null', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_rel_contract',
      type: 'subscription_schedule.released',
      data: { object: { id: 'sched_test_contract_1' } },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    mockDbUpdate.mockReturnValueOnce(chain())

    const res = await POST(makeReq({}))
    expect(res.status).toBe(200)

    const c = mockDbUpdate.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> }
    const setArgs = c.set.mock.calls[0]?.[0] as Record<string, unknown>
    expect({
      status: res.status,
      // All 3 scheduled cols must be null (the clear operation)
      mutation: {
        scheduledDowngradeScheduleId: setArgs.scheduledDowngradeScheduleId,
        scheduledTargetPriceId: setArgs.scheduledTargetPriceId,
        scheduledChangeEffectiveAt: setArgs.scheduledChangeEffectiveAt,
      },
    }).toMatchSnapshot()
  })

  it('unknown event type → HTTP 200 ok, no DB update beyond idempotency', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_noop_contract',
      type: 'payment_intent.created',
      data: { object: {} },
    })
    stubIdempotencyInsertOnce(mockDbInsert)
    const res = await POST(makeReq({}))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({
      status: res.status,
      body,
      dbUpdateCallCount: mockDbUpdate.mock.calls.length,
    }).toMatchSnapshot()
  })
})
