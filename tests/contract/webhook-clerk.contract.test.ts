/**
 * tests/contract/webhook-clerk.contract.test.ts
 *
 * Wire-contract snapshot for POST /api/webhooks/clerk.
 *
 * Frozen faces (spec §3.2 webhook row + P0 brief):
 * 1. 400-vs-200 separation (unambiguous):
 *    - missing svix headers → HTTP 400, body 'missing svix headers'
 *    - invalid signature (svix.verify throws) → HTTP 400, body 'invalid signature'
 *    - schema parse fail (unsupported event type) → HTTP 200, body 'ok'
 *    - duplicate event_id → HTTP 200, body 'duplicate'
 *    - handler error (outer catch) → HTTP 200, body 'handler error swallowed'
 * 2. user.created → users INSERT ON CONFLICT DO NOTHING + publicMetadata sync
 *    (captured: clerkId, email, dbUserId, plan=free)
 * 3. user.deleted → users soft delete (email=null, clerkId=null, deletedAt set,
 *    stripeCustomerId NOT touched) + exactly 10 child-table DELETEs
 *    NOTE: route header comment says "8 テーブル" but ACTUAL contract is 10.
 *    Freeze 10, not 8.
 *
 * NOT frozen: timing/ops payloads, logger calls, Stripe cancel sub calls,
 *             sql`now()` expression value (SQL chunk, AST-fragile).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks (must be before vi.mock calls) ─────────────────────────────
const {
  mockSvixVerify,
  mockDbInsert,
  mockDbUpdate,
  mockDbSelect,
  mockDbDelete,
  mockDbTransaction,
  mockStripeListIterator,
  mockCancelWithRetry,
  mockNotifyOps,
  mockNotifyWebhookError,
  mockSyncClerkMetadata,
} = vi.hoisted(() => ({
  mockSvixVerify: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbDelete: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockStripeListIterator: vi.fn(),
  mockCancelWithRetry: vi.fn().mockResolvedValue(undefined),
  mockNotifyOps: vi.fn().mockResolvedValue(undefined),
  mockNotifyWebhookError: vi.fn().mockResolvedValue(undefined),
  mockSyncClerkMetadata: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('svix', () => ({
  Webhook: class {
    verify = mockSvixVerify
  },
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    insert: mockDbInsert,
    update: mockDbUpdate,
    select: mockDbSelect,
    delete: mockDbDelete,
    transaction: mockDbTransaction,
  }),
}))

vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      list: (..._args: unknown[]) => mockStripeListIterator(),
    },
  },
  cancelWithRetry: mockCancelWithRetry,
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
  notifyWebhookError: mockNotifyWebhookError,
}))

vi.mock('@/lib/auth/clerk-metadata', () => ({
  syncClerkPublicMetadata: mockSyncClerkMetadata,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// ── Route under test ──────────────────────────────────────────────────────────
import { POST } from '../../app/api/webhooks/clerk/route'

// ── Fixtures ──────────────────────────────────────────────────────────────────
import { makeReq, asyncIterFrom } from '../fixtures/webhooks-clerk'

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
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_test_contract_clerk'
  mockNotifyOps.mockResolvedValue(undefined)
  mockCancelWithRetry.mockResolvedValue(undefined)
  mockSyncClerkMetadata.mockResolvedValue({ ok: true })
  // Transaction mock: execute callback with same db shape as tx
  mockDbTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: mockDbUpdate, delete: mockDbDelete }
      return await fn(tx)
    },
  )
})

// ── 1. 400-vs-200 separation ──────────────────────────────────────────────────

describe('Clerk webhook: 400-vs-200 separation', () => {
  it('missing svix headers → HTTP 400 (NOT in 200 group)', async () => {
    // Request without any svix-* headers → route returns 400 before verify
    const req = new Request('https://test/api/webhooks/clerk', {
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

  it('invalid signature (svix.verify throws) → HTTP 400 (NOT in 200 group)', async () => {
    // svix headers present but verify rejects
    mockSvixVerify.mockImplementation(() => {
      throw new Error('Invalid webhook signature')
    })
    const res = await POST(makeReq({}))
    const body = await res.text()
    // Hard assert: 400, distinct from the 200 'handler error swallowed' group
    expect(res.status).toBe(400)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('schema parse fail (unsupported event type) → HTTP 200, body=ok (200 group)', async () => {
    // Verify succeeds but clerkWebhookEventSchema rejects the event type
    // (e.g., 'session.created' is not a supported Clerk webhook event for this route)
    mockSvixVerify.mockReturnValue({ type: 'session.created', data: { id: 'sess_1' } })
    // schema fail happens before idempotency INSERT — no DB mock needed
    const res = await POST(makeReq({ type: 'session.created', data: { id: 'sess_1' } }))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('duplicate event_id → HTTP 200, body=duplicate (200 group)', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_dup_contract' } })
    // clerk_events INSERT ON CONFLICT DO NOTHING → returning [] = already processed
    mockDbInsert.mockReturnValueOnce(chain([]))
    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_dup_contract' } }))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({ status: res.status, body }).toMatchSnapshot()
  })

  it('handler error (outer catch swallows) → HTTP 200, body=handler error swallowed (200 group)', async () => {
    // user.created path: verify OK, clerk_events OK, users insert OK,
    // then syncClerkPublicMetadata rejects → handleEvent propagates → outer catch → 200
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_err_contract',
        email_addresses: [{ email_address: 'err@example.com' }],
      },
    })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_err_contract' }])) // clerk_events
      .mockReturnValueOnce(chain([{ id: '11111111-0000-4000-a000-000000000099' }])) // users INSERT → returns id → sync called
    // syncClerkPublicMetadata rejects → outer catch fires
    mockSyncClerkMetadata.mockRejectedValueOnce(new Error('Clerk API unavailable'))
    const res = await POST(
      makeReq({
        type: 'user.created',
        data: { id: 'user_err_contract', email_addresses: [{ email_address: 'err@example.com' }] },
      }),
    )
    const body = await res.text()
    expect(res.status).toBe(200)
    expect({ status: res.status, body }).toMatchSnapshot()
  })
})

// ── 2. user.created ───────────────────────────────────────────────────────────

describe('Clerk webhook: user.created', () => {
  it('happy path → users INSERT + publicMetadata sync (captured clerkId / email / dbUserId / plan)', async () => {
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_new_contract',
        email_addresses: [{ email_address: 'new@contract.example.com' }],
      },
    })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_new_contract' }])) // clerk_events
      .mockReturnValueOnce(chain([{ id: '00000000-0000-4000-a000-000000000001' }])) // users INSERT

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: { id: 'user_new_contract', email_addresses: [{ email_address: 'new@contract.example.com' }] },
      }),
    )
    expect(res.status).toBe(200)

    // Capture users INSERT values (2nd insert = index 1)
    const usersInsertChain = mockDbInsert.mock.results[1]?.value as {
      values: ReturnType<typeof vi.fn>
    }
    const usersInsertArgs = usersInsertChain.values.mock.calls[0]?.[0] as Record<string, unknown>

    // Capture publicMetadata sync args
    const syncArgs = mockSyncClerkMetadata.mock.calls[0]?.[0] as Record<string, unknown>

    expect({
      status: res.status,
      usersInsert: {
        clerkId: usersInsertArgs?.clerkId,
        email: usersInsertArgs?.email,
      },
      publicMetadataSync: {
        clerkId: syncArgs?.clerkId,
        dbUserId: syncArgs?.dbUserId,
        plan: syncArgs?.plan,
      },
    }).toMatchSnapshot()
  })
})

// ── 3. user.deleted ───────────────────────────────────────────────────────────

describe('Clerk webhook: user.deleted', () => {
  it('soft delete + 10 child-table DELETEs (NOT 8 — route comment is wrong, actual is 10)', async () => {
    // The 10 tables (Group I): exams, studyDays, contactMessages, aiUsageUsers,
    // uploadRecords, userSettings, studySessions, tombstones, entityMutations, tagCategories.
    // Hard assert count=10; snapshot the soft-delete SET shape.
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_del_contract' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_del_contract' }])) // clerk_events
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '22222222-0000-4000-a000-000000000001', stripeCustomerId: null }]),
    )
    // Free plan → no Stripe cancel loop. Transaction: update + 10 deletes.
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_del_contract' } }))
    expect(res.status).toBe(200)

    // Hard assert: exactly 10 child-table DELETEs — freeze this count explicitly
    expect(mockDbDelete).toHaveBeenCalledTimes(10)

    // Capture soft-delete SET args (scalar properties only)
    const updateChain = mockDbUpdate.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> }
    const setArgs = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>

    expect({
      status: res.status,
      softDelete: {
        emailNull: setArgs.email === null,
        clerkIdNull: setArgs.clerkId === null,
        // deletedAt is sql`now()` (a SQL chunk) — assert presence only, not value
        deletedAtSet: setArgs.deletedAt !== undefined,
        // stripeCustomerId is kept as audit correlation key — must NOT be in SET
        stripeCustomerIdTouched: 'stripeCustomerId' in setArgs,
      },
      // The critical contract: 10 tables, NOT 8
      childTableDeleteCount: mockDbDelete.mock.calls.length,
    }).toMatchSnapshot()
  })

  it('user.deleted with Stripe subs → cancel loop runs, then 10 child-table DELETEs', async () => {
    // Verify that the sub-cancel and 10-DELETE contract holds even with a Stripe customer.
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_del_stripe_contract' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_del_stripe' }])) // clerk_events
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '33333333-0000-4000-a000-000000000001', stripeCustomerId: 'cus_del_contract' }]),
    )
    // Stripe list: one active sub (should be canceled), one already-canceled (skip)
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_active_contract', status: 'active' },
        { id: 'sub_canceled_contract', status: 'canceled' },
      ]),
    )
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_del_stripe_contract' } }))
    expect(res.status).toBe(200)

    // Hard assert: 10 child-table DELETEs regardless of Stripe cancel activity
    expect(mockDbDelete).toHaveBeenCalledTimes(10)

    expect({
      childTableDeleteCount: mockDbDelete.mock.calls.length,
      cancelWithRetryCallCount: mockCancelWithRetry.mock.calls.length,
    }).toMatchSnapshot()
  })
})
