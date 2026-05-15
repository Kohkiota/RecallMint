import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'

// --- hoisted mocks ---
const {
  mockSvixVerify,
  mockDbInsert,
  mockDbUpdate,
  mockStripeListIterator,
  mockCancelWithRetry,
  mockNotifyOps,
  mockNotifyWebhookError,
} = vi.hoisted(() => ({
  mockSvixVerify: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockStripeListIterator: vi.fn(),
  mockCancelWithRetry: vi.fn().mockResolvedValue(undefined),
  mockNotifyOps: vi.fn().mockResolvedValue(undefined),
  mockNotifyWebhookError: vi.fn().mockResolvedValue(undefined),
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

import { POST } from './route'

const SECRET = 'whsec_test_for_unit'

/**
 * Drizzle chain mock: 全 method を return-this で連結、`.then` で await 可能化。
 * .values() / .onConflictDoNothing() / .returning() / .set() / .where() の
 * どこを await しても resolveTo に解決する。test ごとに insert/update の戻り値を
 * mockReturnValueOnce で順次設定する。
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
  process.env.CLERK_WEBHOOK_SECRET = SECRET
  mockNotifyOps.mockResolvedValue(undefined)
  mockCancelWithRetry.mockResolvedValue(undefined)
})

function makeReq(body: unknown): Request {
  return new Request('https://test/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_test_1',
      'svix-timestamp': '0',
      'svix-signature': 'v1,sig',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function* asyncIterFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

describe('Clerk webhook user.deleted (Webhook 駆動再設計)', () => {
  it('正常系: clerk_events INSERT → DB deletedAt set → Stripe sub cancel × N → 200', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    // 1st insert = clerk_events idempotency (returning [{id}])
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }]))
    // 1st update = users (returning [{stripeCustomerId}])
    mockDbUpdate.mockReturnValueOnce(chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: 'cus_1' }]))
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_a', status: 'active' },
        { id: 'sub_t', status: 'trialing' },
        { id: 'sub_c', status: 'canceled' },
      ]),
    )

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockDbInsert).toHaveBeenCalledTimes(1) // clerk_events のみ (失敗 0 → deletion_failures 0)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockCancelWithRetry).toHaveBeenCalledTimes(2)
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_a')
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_t')
    expect(mockCancelWithRetry).not.toHaveBeenCalledWith('sub_c')
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('users 未同期 (UPDATE 0 row match): notifyOps で観測性確保 + Stripe loop 不到達 + 200', async () => {
    // F-5 fix-up (review M-1): user.created 未到達で user.deleted 受信 = 順序逆転
    // edge case。internalUserId が undefined になる → silent skip させず notifyOps
    // で OT 通知。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_orphan' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
    mockDbUpdate.mockReturnValueOnce(chain([])) // 0 row match (users 行なし)

    const res = await POST(
      makeReq({ type: 'user.deleted', data: { id: 'user_orphan' } }),
    )

    expect(res.status).toBe(200)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockDbInsert).toHaveBeenCalledTimes(1) // clerk_events のみ、deletion_failures に書かない
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'user.deleted received but users row not synced',
    )
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.clerkUserId).toBe('user_orphan')
  })

  it('重複 svix-id (idempotency skip): 2 回目は handler 未到達で 200 "duplicate"', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    // returning [] = ON CONFLICT で skip
    mockDbInsert.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('duplicate')
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('個別 cancel 失敗: deletion_failures + notifyOps を per-sub で呼び loop 継続', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // deletion_failures (sub_a 失敗)
    mockDbUpdate.mockReturnValueOnce(chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: 'cus_1' }]))
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_a', status: 'active' },
        { id: 'sub_b', status: 'active' },
      ]),
    )
    mockCancelWithRetry
      .mockRejectedValueOnce(new Error('stripe error mid-cancel'))
      .mockResolvedValueOnce(undefined)

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).toHaveBeenCalledTimes(2)
    expect(mockDbInsert).toHaveBeenCalledTimes(2) // clerk_events + deletion_failures × 1
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
  })

  it('list 失敗 (customer_missing): kind=customer_missing で recordFailure', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // deletion_failures
    mockDbUpdate.mockReturnValueOnce(chain([{ id: '00000000-0000-0000-0000-0000000000a2', stripeCustomerId: 'cus_gone' }]))
    const customerMissing = new Stripe.errors.StripeInvalidRequestError({
      message: 'No such customer',
      code: 'resource_missing',
      type: 'invalid_request_error',
    })
    mockStripeListIterator.mockImplementation(() => {
      throw customerMissing
    })

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![1]).toMatchObject({
      kind: 'customer_missing',
    })
  })

  it('outer catch (handler 内 throw): notifyWebhookError(handler=clerk, eventId=svixId, eventType, err, userId) + 200 swallow', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.created', data: { id: 'user_x' } })
    // 1st insert = clerk_events idempotency OK, 2nd insert = users INSERT が throw
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }]))
      .mockImplementationOnce(() => {
        throw new Error('boom: users insert down')
      })

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_x',
          email_addresses: [{ email_address: 'x@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(mockNotifyWebhookError).toHaveBeenCalledTimes(1)
    const arg = mockNotifyWebhookError.mock.calls[0]![0] as {
      handler: string
      eventId: string
      eventType: string
      userId?: string
      err: unknown
    }
    expect(arg.handler).toBe('clerk')
    expect(arg.eventId).toBe('msg_test_1')
    expect(arg.eventType).toBe('user.created')
    expect(arg.userId).toBe('user_x')
    expect(arg.err).toBeInstanceOf(Error)
    expect((arg.err as Error).message).toBe('boom: users insert down')
    // Spec §2 invariant: environment / timestamp は callsite では渡さず helper 内部で
    // 自動付与する。callsite 引数に load されたら spec drift。
    expect(arg).not.toHaveProperty('environment')
    expect(arg).not.toHaveProperty('timestamp')
    // recordFailure path (notifyOps) は別経路、本ケースでは発火しない
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('page-level partial 失敗: canceledIds + offset を error_message に詰める', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // deletion_failures (list 失敗)
    mockDbUpdate.mockReturnValueOnce(chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: 'cus_1' }]))
    async function* failingIter(): AsyncGenerator<{
      id: string
      status: Stripe.Subscription.Status
    }> {
      yield { id: 'sub_a', status: 'active' }
      throw new Error('network reset on next page')
    }
    mockStripeListIterator.mockReturnValue(failingIter())

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_a')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.kind).toBe('list')
    expect(String(ctx.error)).toMatch(/page fetch failed at offset 1/)
    expect(String(ctx.error)).toMatch(/Canceled before failure: \[sub_a\]/)
  })
})
