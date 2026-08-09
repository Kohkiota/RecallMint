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
 * 2. user.created → 事前採番 UUID で users INSERT (id 明示・RLS-P2 spec §2.5、RETURNING /
 *    onConflict 非使用) + publicMetadata sync (captured: clerkId, email, plan=free。
 *    dbUserId は非決定 UUID ゆえ INSERT id との一致を boolean で凍結)
 * 3. user.deleted → scrub は app_scrub_deleted_user 関数呼出 (RLS-P2 spec §2.6、
 *    setTenantContext 先行・users を drizzle UPDATE しない = stripe_customer_id は関数側で
 *    保持) + exactly 10 child-table DELETEs + assets soft-delete (status='deleting'
 *    UPDATE, W2 image-GC-v2 spec §4.8)。実 PII NULL 化は iso (rls-functions.test.ts) が pin。
 *    NOTE: route header comment lists Group I テーブル (11 件)。 うち assets は W2 で
 *    物理 DELETE → deleting UPDATE に置換されたため、 ACTUAL DELETE contract is 10.
 *    Freeze 10 DELETE + 1 assets soft-delete.
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
  mockDbExecute,
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
  mockDbExecute: vi.fn(),
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

// RLS-P3 (Task 1): route.ts event dedup + handle-clerk-event.ts
// handleUserDeleted pre-tenant resolve now call getNonTenantDb() (same
// underlying connection as getDb() — mechanical mock-target alias,
// assertions/behavior unchanged). getDb() remains used by user.created's
// withTenantTx(db, ...) call site (handleEvent ~L39).
vi.mock('@/lib/db', () => {
  const fakeDb = {
    insert: mockDbInsert,
    update: mockDbUpdate,
    select: mockDbSelect,
    delete: mockDbDelete,
    execute: mockDbExecute,
    transaction: mockDbTransaction,
  }
  return {
    getDb: () => fakeDb,
    getNonTenantDb: () => fakeDb,
  }
})

vi.mock('@/lib/stripe/client', () => ({
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

// ②-4b §2: user.deleted は R2 の src/ prefix purge を伴う。実 R2 を叩かせない
// (listing 0 件 = 削除対象なし)。
vi.mock('@/lib/storage/r2', async (importOriginal) => {
  // 既定 timeout のみ実 module から取る (全 spread にすると未 override の export が
  // 実装のまま残り、実 R2 へ request が飛びうる)。
  const { LIST_TIMEOUT_MS, DELETE_TIMEOUT_MS } =
    await importOriginal<typeof import('@/lib/storage/r2')>()
  return {
    LIST_TIMEOUT_MS,
    DELETE_TIMEOUT_MS,
    listObjectsBounded: vi.fn().mockResolvedValue({ keys: [], truncated: false }),
    deleteObject: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
  }
})

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

// RLS-P2: drizzle SQL の静的 text + 補間値を平坦化して execute の SQL を判別する
// (app_bootstrap_user_from_clerk = created 存在チェック / deleted resolve、set_config =
// setTenantContext、app_scrub_deleted_user = scrub)。
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown })?.value
      if (Array.isArray(v)) return v.join('')
      if (typeof c === 'string') return c
      if (typeof v === 'string') return v
      return ''
    })
    .join('')
}

// bootstrap 関数の戻り行 (created 存在チェック / deleted resolve が共有)。
let bootstrapRows: unknown[] = []

function executeCallsMatching(substr: string): unknown[] {
  return mockDbExecute.mock.calls
    .map((c) => c[0])
    .filter((q) => sqlText(q).includes(substr))
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks()
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_test_contract_clerk'
  mockNotifyOps.mockResolvedValue(undefined)
  mockCancelWithRetry.mockResolvedValue(undefined)
  mockSyncClerkMetadata.mockResolvedValue({ ok: true })
  bootstrapRows = []
  // 既定 insert chain (clerk_events は各 test が mockReturnValueOnce で先に消費、
  // 後続の tx.insert(users) はこの default chain を返す)。
  mockDbInsert.mockReturnValue(chain(undefined))
  // db.execute / tx.execute の router: bootstrap は bootstrapRows、set_config /
  // app_scrub_deleted_user は no-op resolve。
  mockDbExecute.mockImplementation((q: unknown) =>
    sqlText(q).includes('app_bootstrap_user_from_clerk')
      ? Promise.resolve(bootstrapRows)
      : Promise.resolve(undefined),
  )
  // Transaction mock: execute callback with same db shape as tx (RLS-P2 で execute /
  // insert も受ける)。
  mockDbTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mockDbExecute,
        insert: mockDbInsert,
        update: mockDbUpdate,
        delete: mockDbDelete,
      }
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
  it('happy path → 事前採番 UUID で users INSERT (id 明示) + publicMetadata sync (dbUserId は採番 id と一致)', async () => {
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_new_contract',
        email_addresses: [{ email_address: 'new@contract.example.com' }],
      },
    })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_new_contract' }])) // clerk_events; bootstrapRows=[] 新規

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: { id: 'user_new_contract', email_addresses: [{ email_address: 'new@contract.example.com' }] },
      }),
    )
    expect(res.status).toBe(200)

    // users INSERT は withTenantTx 内の tx.insert (mockDbInsert 2 回目 = index 1)
    const usersInsertChain = mockDbInsert.mock.results[1]?.value as {
      values: ReturnType<typeof vi.fn>
    }
    const usersInsertArgs = usersInsertChain.values.mock.calls[0]?.[0] as Record<string, unknown>

    // Capture publicMetadata sync args
    const syncArgs = mockSyncClerkMetadata.mock.calls[0]?.[0] as Record<string, unknown>

    const insertId = usersInsertArgs?.id as string
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(insertId)

    expect({
      status: res.status,
      usersInsert: {
        clerkId: usersInsertArgs?.clerkId,
        email: usersInsertArgs?.email,
        // 事前採番: id が明示され UUID 形式 (RETURNING 非依存)
        idIsUuid: isUuid,
      },
      publicMetadataSync: {
        clerkId: syncArgs?.clerkId,
        // dbUserId は非決定 UUID ゆえ raw 値を snapshot せず、INSERT id と一致することを凍結
        dbUserIdMatchesInsertId: syncArgs?.dbUserId === insertId,
        plan: syncArgs?.plan,
      },
    }).toMatchSnapshot()
  })
})

// ── 3. user.deleted ───────────────────────────────────────────────────────────

describe('Clerk webhook: user.deleted', () => {
  it('scrub via 関数 + assets deleting + 10 child-table DELETEs (W2: assets soft-delete 例外)', async () => {
    // Group I 11 テーブル: exams, studyDays, contactMessages, aiUsageUsers,
    // uploadRecords, userSettings, studySessions, tombstones, entityMutations, tagCategories,
    // assets. うち assets のみ W2 で物理 DELETE → status='deleting' UPDATE (soft-delete)。
    // RLS-P2: scrub は app_scrub_deleted_user 関数呼出に移行 (users を drizzle UPDATE しない)
    // ため drizzle update は assets deleting の 1 件のみ。物理 DELETE は 10 件。
    const internalUserId = '22222222-0000-4000-a000-000000000001'
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_del_contract' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_del_contract' }])) // clerk_events
    bootstrapRows = [{ id: internalUserId, stripe_customer_id: null }]
    // Free plan → no Stripe cancel loop. Transaction: setTenantContext + scrub 関数 +
    // 10 deletes + assets deleting UPDATE (drizzle update × 1)。
    mockDbUpdate.mockImplementation(() => chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_del_contract' } }))
    expect(res.status).toBe(200)

    // Hard assert: exactly 10 child-table DELETEs (assets excluded = soft-delete) — freeze
    expect(mockDbDelete).toHaveBeenCalledTimes(10)

    const scrubCalls = executeCallsMatching('app_scrub_deleted_user')
    const setConfigCalls = executeCallsMatching('set_config')
    // drizzle update は assets deleting のみ (results[0])
    const assetsUpdateChain = mockDbUpdate.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> }
    const assetsSetArgs = assetsUpdateChain.set.mock.calls[0]?.[0] as Record<string, unknown>

    expect({
      status: res.status,
      scrub: {
        // scrub は app_scrub_deleted_user(internalUserId) 関数呼出
        viaFunction:
          scrubCalls.length === 1 && sqlText(scrubCalls[0]).includes(internalUserId),
        // setTenantContext が internalUserId で先行
        tenantContextSet:
          setConfigCalls.length >= 1 && sqlText(setConfigCalls[0]).includes(internalUserId),
        // users を drizzle UPDATE しない (= stripe_customer_id は関数側で保持)。
        // drizzle update は assets deleting の 1 件のみ。
        drizzleUpdateCount: mockDbUpdate.mock.calls.length,
      },
      // W2: assets is soft-deleted to 'deleting' (not physically DELETEd)
      assetsSoftDelete: { status: assetsSetArgs.status },
      // The critical contract: 10 physical DELETEs (assets soft-deleted, W2)
      childTableDeleteCount: mockDbDelete.mock.calls.length,
    }).toMatchSnapshot()
  })

  it('user.deleted with Stripe subs → cancel loop runs, then 10 child-table DELETEs', async () => {
    // Verify that the sub-cancel and 10-DELETE contract holds even with a Stripe customer.
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_del_stripe_contract' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_del_stripe' }])) // clerk_events
    bootstrapRows = [
      { id: '33333333-0000-4000-a000-000000000001', stripe_customer_id: 'cus_del_contract' },
    ]
    // Stripe list: one active sub (should be canceled), one already-canceled (skip)
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_active_contract', status: 'active' },
        { id: 'sub_canceled_contract', status: 'canceled' },
      ]),
    )
    mockDbUpdate.mockImplementation(() => chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_del_stripe_contract' } }))
    expect(res.status).toBe(200)

    // Hard assert: 10 child-table DELETEs regardless of Stripe cancel activity
    // (assets is soft-deleted = deleting UPDATE, W2)
    expect(mockDbDelete).toHaveBeenCalledTimes(10)

    expect({
      childTableDeleteCount: mockDbDelete.mock.calls.length,
      cancelWithRetryCallCount: mockCancelWithRetry.mock.calls.length,
    }).toMatchSnapshot()
  })
})
