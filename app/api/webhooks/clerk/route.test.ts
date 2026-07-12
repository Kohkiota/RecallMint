import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Stripe from 'stripe'

// --- hoisted mocks ---
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

import { POST } from './route'
import { integrationFailures } from '@/lib/db/schema'
import { INTEGRATION_FAILURE_CATALOG } from '@/lib/integration-failures'

const SECRET = 'whsec_test_for_unit'

/**
 * Drizzle chain mock: 全 method を return-this で連結、`.then` で await 可能化。
 * .values() / .onConflictDoNothing() / .returning() / .set() / .where() /
 * .from() / .limit() のどこを await しても resolveTo に解決する。
 * test ごとに insert/update/select/delete の戻り値を mockReturnValueOnce で順次設定する。
 */
function chain(resolveTo: unknown = undefined) {
  const c: Record<string, unknown> = {}
  c.values = vi.fn().mockReturnValue(c)
  c.onConflictDoNothing = vi.fn().mockReturnValue(c)
  c.returning = vi.fn().mockReturnValue(c)
  c.set = vi.fn().mockReturnValue(c)
  c.where = vi.fn().mockReturnValue(c)
  c.from = vi.fn().mockReturnValue(c)
  c.limit = vi.fn().mockReturnValue(c)
  c.then = (onFulfilled: (v: unknown) => void) =>
    Promise.resolve(resolveTo).then(onFulfilled)
  return c
}

// Sprint 2 dual-write: recordFailure が recordIntegrationFailure 経由で
// getDb().insert(integrationFailures).values({...}) を呼ぶ。mockDbInsert は
// clerk_events (idempotency) と integration_failures (ledger) の両方で呼ばれるため、
// 第 1 引数が integrationFailures の call だけを対象に row を拾う。
function integrationInsertRow(): Record<string, unknown> | undefined {
  const idx = mockDbInsert.mock.calls.findIndex((c) => c[0] === integrationFailures)
  if (idx === -1) return undefined
  const chainObj = mockDbInsert.mock.results[idx].value as {
    values: ReturnType<typeof vi.fn>
  }
  return chainObj.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CLERK_WEBHOOK_SECRET = SECRET
  mockNotifyOps.mockResolvedValue(undefined)
  mockCancelWithRetry.mockResolvedValue(undefined)
  mockSyncClerkMetadata.mockResolvedValue({ ok: true })
  // ledger INSERT の default chain。idempotency INSERT の mockReturnValueOnce 消費後に
  // helper の integration_failures INSERT が undefined を返して throw-safe path
  // (ledgerWriteError) へ落ちないよう default を敷く。各 test は clerk_events を
  // mockReturnValueOnce で先に消費する。
  mockDbInsert.mockReturnValue(chain(undefined))
  // デフォルト: transaction は callback をそのまま実行する (tx は db と同 shape)
  mockDbTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: mockDbUpdate,
        delete: mockDbDelete,
      }
      return await fn(tx)
    },
  )
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

describe('Clerk webhook user.created (publicMetadata sync)', () => {
  it('happy path: users INSERT returning {id} → syncClerkPublicMetadata が clerkId + dbUserId + plan=free で呼ばれる → 200', async () => {
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_new',
        email_addresses: [{ email_address: 'new@example.com' }],
      },
    })
    // 1st insert = clerk_events idempotency
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }]))
      // 2nd insert = users INSERT、 returning [{id: db-uuid}]
      .mockReturnValueOnce(
        chain([{ id: '00000000-0000-0000-0000-000000000abc' }]),
      )

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_new',
          email_addresses: [{ email_address: 'new@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(mockSyncClerkMetadata).toHaveBeenCalledTimes(1)
    expect(mockSyncClerkMetadata).toHaveBeenCalledWith({
      clerkId: 'user_new',
      dbUserId: '00000000-0000-0000-0000-000000000abc',
      plan: 'free',
    })
  })

  it('conflict path (returning []): users 行が既に存在 → syncClerkPublicMetadata は呼ばれない (re-fire 安全)', async () => {
    // Clerk webhook の re-fire (同 svix-id ではないが users 行が他経路で先に作られた等)。
    // 既存 publicMetadata が新規 webhook によって上書きされて plan が free に戻る race を防ぐ。
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_dup',
        email_addresses: [{ email_address: 'dup@example.com' }],
      },
    })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_dup' }]))
      // users INSERT ON CONFLICT DO NOTHING → returning []
      .mockReturnValueOnce(chain([]))

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_dup',
          email_addresses: [{ email_address: 'dup@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(mockSyncClerkMetadata).not.toHaveBeenCalled()
  })

  it('syncClerkPublicMetadata が ok:false でも webhook は 200 を返す (notifyOps は helper 側で発火)', async () => {
    mockSvixVerify.mockReturnValue({
      type: 'user.created',
      data: {
        id: 'user_meta_fail',
        email_addresses: [{ email_address: 'mf@example.com' }],
      },
    })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_2' }]))
      .mockReturnValueOnce(
        chain([{ id: '00000000-0000-0000-0000-000000000def' }]),
      )
    mockSyncClerkMetadata.mockResolvedValueOnce({ ok: false })

    const res = await POST(
      makeReq({
        type: 'user.created',
        data: {
          id: 'user_meta_fail',
          email_addresses: [{ email_address: 'mf@example.com' }],
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(mockSyncClerkMetadata).toHaveBeenCalledOnce()
    // helper 内で notifyOps が発火 (本 file の mock は helper を mock しているので
    // notifyOps は webhook handler 側からは呼ばれない)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })
})

describe('Clerk webhook user.deleted (Webhook 駆動再設計)', () => {
  it('正常系: clerk_events INSERT → SELECT users → Stripe sub cancel × N → DB transaction (update + 11 delete) → 200 + scrub payload 含む', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    // 1st insert = clerk_events idempotency (returning [{id}])
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }]))
    // select = users (returning [{id, stripeCustomerId}])
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: 'cus_1' }]),
    )
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_a', status: 'active' },
        { id: 'sub_t', status: 'trialing' },
        { id: 'sub_c', status: 'canceled' },
      ]),
    )
    // transaction 内: update users + delete exams + delete study_days + delete contact_messages
    const updateChain = chain(undefined)
    mockDbUpdate.mockReturnValueOnce(updateChain)
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockDbInsert).toHaveBeenCalledTimes(1) // clerk_events のみ (失敗 0)
    expect(mockDbSelect).toHaveBeenCalledTimes(1)
    expect(mockCancelWithRetry).toHaveBeenCalledTimes(2)
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_a')
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_t')
    expect(mockCancelWithRetry).not.toHaveBeenCalledWith('sub_c')
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    // transaction 内で update × 1 + delete × 11 (Group I 全件)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockDbDelete).toHaveBeenCalledTimes(11)
    expect(mockNotifyOps).not.toHaveBeenCalled()
    // 正常系でも scrub payload (email/clerkId NULL) が users UPDATE に乗ることを
    // defense-in-depth で確認 — 専用 test (下) が削除された場合の二重保険。
    expect(updateChain.set).toHaveBeenCalledTimes(1)
    expect(updateChain.where).toHaveBeenCalledTimes(1)
    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.email).toBeNull()
    expect(setArg.clerkId).toBeNull()
  })

  it('GDPR PII scrub: tx.update(users) の SET に email=null + clerkId=null + deletedAt set、 stripeCustomerId は触らない、 同 transaction で Group I 11 子テーブル DELETE も発火', async () => {
    // GDPR 要件: users 行は監査 (integration_failures user_id 相関 / stripe correlation) の
    // ため残置するが PII 列 (email, clerk_id) は退会と同じ transaction で NULL に
    // 書き換える。 stripe_customer_id (cus_xxx) は個人特定不能で監査 correlation key
    // のため保持 — SET 引数に含めない。
    // 加えて、 scrub と Group I の 11 子テーブル DELETE (exams / studyDays /
    // contactMessages / aiUsageUsers / uploadRecords / userSettings /
    // studySessions / tombstones / entityMutations / tagCategories / assets) は同一 transaction 内で
    // atomic に走る (= 部分 commit の漏れ無し) ことも本 test で確認する。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_scrub' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_scrub' }])) // clerk_events
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000cc', stripeCustomerId: 'cus_keep' }]),
    )
    mockStripeListIterator.mockReturnValue(asyncIterFrom([])) // no subs
    const updateChain = chain(undefined)
    mockDbUpdate.mockReturnValueOnce(updateChain)
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_scrub' } }))

    expect(res.status).toBe(200)
    // scrub payload 検証
    expect(updateChain.set).toHaveBeenCalledTimes(1)
    expect(updateChain.where).toHaveBeenCalledTimes(1)
    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.email).toBeNull()
    expect(setArg.clerkId).toBeNull()
    // deletedAt は sql`now()` (SQL chunk) — 値の存在のみ確認
    expect(setArg.deletedAt).toBeDefined()
    // stripe_customer_id は監査 correlation key として保持。 SET payload に
    // 載せない (= キー自体不在)。
    expect('stripeCustomerId' in setArg).toBe(false)
    // atomicity: 同一 transaction 内で Group I の 11 子テーブル DELETE も発火している
    // こと (= 「scrub だけ通って子データが残る」 部分 commit を防ぐ)。
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(mockDbDelete).toHaveBeenCalledTimes(11)
  })

  it('GDPR scrub 冪等性: 同 svix-id 再送は clerk_events dedup で handler 不到達 → 二重 scrub 起きない', async () => {
    // scrub は UPDATE SET email=null/clerkId=null で値レベルでは冪等だが、
    // 二重実行自体が clerk_events.event_id (svix-id) PK の ON CONFLICT DO NOTHING
    // で抑止される。 1 回目で returning [{id}]、 2 回目 (returning []) で early
    // return = handler / tx.update に到達しない。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_scrub_dup' } })
    mockDbInsert.mockReturnValueOnce(chain([])) // 2 回目: returning [] = dedup hit

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_scrub_dup' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('duplicate')
    expect(mockDbSelect).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('users 未同期 (SELECT 0 行): notifyOps で観測性確保 + Stripe loop 不到達 + transaction 不到達 + 200', async () => {
    // F-5 fix-up (review M-1): user.created 未到達で user.deleted 受信 = 順序逆転
    // edge case。internalUserId が undefined になる → silent skip させず notifyOps
    // で OT 通知。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_orphan' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
    mockDbSelect.mockReturnValueOnce(chain([])) // 0 rows (users 行なし)

    const res = await POST(
      makeReq({ type: 'user.deleted', data: { id: 'user_orphan' } }),
    )

    expect(res.status).toBe(200)
    expect(mockDbSelect).toHaveBeenCalledTimes(1)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockDbInsert).toHaveBeenCalledTimes(1) // clerk_events のみ、integration_failures に書かない
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'user.deleted received but users row not synced',
    )
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.clerkUserId).toBe('user_orphan')
  })

  it('customerId なし (Free プラン): Stripe ループ skip → transaction のみ実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_free' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
    // SELECT users: customerId = null (Free プラン)
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000b1', stripeCustomerId: null }]),
    )
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_free' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockDbDelete).toHaveBeenCalledTimes(11)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('transaction 失敗 (permanent error): integration_failures (deletion_data) → notifyOps subject="user data deletion failure", retry なし', async () => {
    // I-2 realistic harness: tx.update が permanent pg error (23505 = unique violation)
    // を throw する。transaction callback が reject → retry せず即 recordFailure。
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures INSERT
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: null }]),
    )
    // tx.update が permanent error を throw (callback 内 statement reject = realistic)
    const permanentErr = Object.assign(new Error('unique constraint violation'), { code: '23505' })
    mockDbTransaction.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          update: vi.fn().mockImplementation(() => { throw permanentErr }),
          delete: mockDbDelete,
        }
        return await fn(tx)
      },
    )

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    // permanent → retry なし = transaction は 1 回のみ
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    // integration_failures INSERT が呼ばれる
    expect(mockDbInsert).toHaveBeenCalledTimes(2)
    // Discord notify は byte 不変 (subject 別文言 + context の kind は旧 'data_deletion')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe('user data deletion failure')
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.kind).toBe('data_deletion')
    // dual-write: ledger 行に catalog の 4 軸 (deletion_data) + 型付き ref。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_data
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a1',
      clerkId: 'user_1',
    })
    expect(row!.stripeSubscriptionId).toBeUndefined() // subId=null → helper が undefined 化 (ref 列を省略 = DB は NULL)
  })

  it('重複 svix-id (idempotency skip): 2 回目は handler 未到達で 200 "duplicate"', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    // returning [] = ON CONFLICT で skip
    mockDbInsert.mockReturnValueOnce(chain([]))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('duplicate')
    expect(mockDbSelect).not.toHaveBeenCalled()
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('個別 cancel 失敗: integration_failures (deletion_cancel) + notifyOps を per-sub で呼び loop 継続 + transaction 実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures (sub_a 失敗)
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: 'cus_1' }]),
    )
    mockStripeListIterator.mockReturnValue(
      asyncIterFrom([
        { id: 'sub_a', status: 'active' },
        { id: 'sub_b', status: 'active' },
      ]),
    )
    mockCancelWithRetry
      .mockRejectedValueOnce(new Error('stripe error mid-cancel'))
      .mockResolvedValueOnce(undefined)
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).toHaveBeenCalledTimes(2)
    expect(mockDbInsert).toHaveBeenCalledTimes(2) // clerk_events + integration_failures × 1
    // Discord notify は byte 不変 (subject / context 不変。context の kind は旧 'cancel')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
    expect(mockNotifyOps.mock.calls[0]![1]).toMatchObject({ kind: 'cancel' })
    // dual-write: ledger 行に catalog の 4 軸 (deletion_cancel) + 型付き ref。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_cancel
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a1',
      clerkId: 'user_1',
      stripeSubscriptionId: 'sub_a',
      errorMessage: 'Error: stripe error mid-cancel',
    })
    // Stripe 失敗後も transaction が走る (forward-only)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })

  it('list 失敗 (customer_missing): integration_failures (deletion_customer_missing) で recordFailure + transaction 実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000a2', stripeCustomerId: 'cus_gone' }]),
    )
    const customerMissing = new Stripe.errors.StripeInvalidRequestError({
      message: 'No such customer',
      code: 'resource_missing',
      type: 'invalid_request_error',
    })
    mockStripeListIterator.mockImplementation(() => {
      throw customerMissing
    })
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).not.toHaveBeenCalled()
    // Discord notify は byte 不変 (context の kind は旧 'customer_missing')
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
    expect(mockNotifyOps.mock.calls[0]![1]).toMatchObject({
      kind: 'customer_missing',
    })
    // dual-write: ledger 行に catalog の 4 軸 (deletion_customer_missing) + 型付き ref。
    // subId=null ゆえ stripeSubscriptionId は null。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_customer_missing
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a2',
      clerkId: 'user_1',
    })
    expect(row!.stripeSubscriptionId).toBeUndefined() // subId=null → helper が undefined 化 (ref 列を省略 = DB は NULL)
    // customer_missing 後も transaction は実行される (forward-only)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
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

  // ---- T3 retry テスト ----

  describe('DB transaction retry (T3)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    // beforeEach でセットアップする共通の select / stripe ヘルパー
    function setupUserAndNoStripe(userId = '00000000-0000-0000-0000-000000000099') {
      mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      mockDbSelect.mockReturnValueOnce(chain([{ id: userId, stripeCustomerId: null }]))
    }

    it('① transient error (40P01 = deadlock) → 1 回失敗 → retry で成功', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r1' } })
      setupUserAndNoStripe()

      const transientErr = Object.assign(new Error('deadlock detected'), { code: '40P01' })
      let callCount = 0
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          callCount++
          if (callCount === 1) {
            // 1 回目: tx.update が transient error で throw
            const tx = {
              update: vi.fn().mockImplementation(() => { throw transientErr }),
              delete: mockDbDelete,
            }
            return await fn(tx)
          }
          // 2 回目 (retry): 成功
          const tx = { update: mockDbUpdate, delete: mockDbDelete }
          mockDbUpdate.mockReturnValueOnce(chain(undefined))
          mockDbDelete.mockReturnValue(chain(undefined))
          return await fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r1' } }))
      // retry1 前の 500ms backoff を進める
      await vi.advanceTimersByTimeAsync(500)
      const res = await promise

      expect(res.status).toBe(200)
      expect(mockDbTransaction).toHaveBeenCalledTimes(2) // 初回 + 1 retry
      expect(mockNotifyOps).not.toHaveBeenCalled() // 成功したので recordFailure なし
    })

    it('② transient error (40P01) で 4 回全失敗 → recordFailure(data_deletion), errorMessage に試行回数 + code', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r2' } })
      setupUserAndNoStripe()
      mockDbInsert.mockReturnValueOnce(chain(undefined)) // integration_failures INSERT

      const transientErr = Object.assign(new Error('deadlock detected'), { code: '40P01' })
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            update: vi.fn().mockImplementation(() => { throw transientErr }),
            delete: mockDbDelete,
          }
          return await fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r2' } }))
      // 3 回の retry backoff: 500ms + 1000ms + 2000ms
      await vi.advanceTimersByTimeAsync(500 + 1000 + 2000)
      const res = await promise

      expect(res.status).toBe(200)
      expect(mockDbTransaction).toHaveBeenCalledTimes(4) // 初回 + 3 retries
      expect(mockNotifyOps).toHaveBeenCalledOnce()
      expect(mockNotifyOps.mock.calls[0]![0]).toBe('user data deletion failure')
      const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
      expect(ctx.kind).toBe('data_deletion')
      // errorMessage に試行回数と pg code が含まれる (I-3)
      const errMsg = String(ctx.error)
      expect(errMsg).toMatch(/4\s*(attempts|回)/)
      expect(errMsg).toMatch(/40P01/)
    })

    it('③ permanent error (23505 = unique violation) → retry せず即 recordFailure', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r3' } })
      setupUserAndNoStripe()
      mockDbInsert.mockReturnValueOnce(chain(undefined)) // integration_failures INSERT

      const permanentErr = Object.assign(new Error('unique constraint'), { code: '23505' })
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            update: vi.fn().mockImplementation(() => { throw permanentErr }),
            delete: mockDbDelete,
          }
          return await fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r3' } }))
      // permanent は即中断 — timer を進めても retry が走らないことを確認
      await vi.advanceTimersByTimeAsync(5000)
      const res = await promise

      expect(res.status).toBe(200)
      expect(mockDbTransaction).toHaveBeenCalledTimes(1) // retry なし
      expect(mockNotifyOps).toHaveBeenCalledOnce()
      const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
      expect(ctx.kind).toBe('data_deletion')
      // errorMessage に pg code が含まれる (I-3)
      expect(String(ctx.error)).toMatch(/23505/)
    })

    it.each([
      ['40001 (serialization failure)', Object.assign(new Error('serialization failure'), { code: '40001' })],
      ['08006 (connection failure)', Object.assign(new Error('connection failure'), { code: '08006' })],
      ['57P01 (admin shutdown)', Object.assign(new Error('admin shutdown'), { code: '57P01' })],
      ['code なし (connection 切断系)', new Error('connection closed unexpectedly')],
    ])('④ transient code %s が retry される', async (_label, transientErr) => {
      // 代表 transient codes が isTransientDbError=true → retry が発生し成功することを確認。
      // vi.clearAllMocks を loop 内で呼ばず it.each で独立テストにする (fake timer との競合回避)。
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r4' } })
      setupUserAndNoStripe()

      let callCount = 0
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          callCount++
          if (callCount === 1) {
            // 1 回目: tx.update が transient error で throw
            const tx = {
              update: vi.fn().mockImplementation(() => { throw transientErr }),
              delete: mockDbDelete,
            }
            return await fn(tx)
          }
          // 2 回目 (retry): 成功
          mockDbUpdate.mockReturnValueOnce(chain(undefined))
          mockDbDelete.mockReturnValue(chain(undefined))
          const tx = { update: mockDbUpdate, delete: mockDbDelete }
          return await fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r4' } }))
      await vi.advanceTimersByTimeAsync(500)
      const res = await promise

      expect(res.status).toBe(200)
      // retry が 1 回発生 = 合計 2 回呼ばれる
      expect(mockDbTransaction).toHaveBeenCalledTimes(2)
      expect(mockNotifyOps).not.toHaveBeenCalled() // 成功したので recordFailure なし
    })

    it('⑤ errorMessage に試行回数 + pg code が含まれる (I-3 診断値検証)', async () => {
      mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_r5' } })
      setupUserAndNoStripe()
      mockDbInsert.mockReturnValueOnce(chain(undefined)) // integration_failures INSERT

      // permanent error で即停止 → errorMessage を検証
      const pgErr = Object.assign(new Error('FK violation'), { code: '23503', detail: 'foreign key constraint' })
      mockDbTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            update: vi.fn().mockImplementation(() => { throw pgErr }),
            delete: mockDbDelete,
          }
          return await fn(tx)
        },
      )

      const promise = POST(makeReq({ type: 'user.deleted', data: { id: 'user_r5' } }))
      await vi.advanceTimersByTimeAsync(0)
      const res = await promise

      expect(res.status).toBe(200)
      const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
      const errMsg = String(ctx.error)
      // I-3: pg code が明示されていること
      expect(errMsg).toMatch(/23503/)
      // I-3: 試行回数 1 (initial, no retries for permanent) が含まれること
      expect(errMsg).toMatch(/1\s*(attempt|回)/)
    })
  })

  it('page-level partial 失敗 (deletion_list): canceledIds + offset を error_message に詰める + transaction 実行', async () => {
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_1' } })
    mockDbInsert
      .mockReturnValueOnce(chain([{ id: 'msg_test_1' }])) // clerk_events
      .mockReturnValueOnce(chain(undefined)) // integration_failures (list 失敗)
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000a1', stripeCustomerId: 'cus_1' }]),
    )
    async function* failingIter(): AsyncGenerator<{
      id: string
      status: Stripe.Subscription.Status
    }> {
      yield { id: 'sub_a', status: 'active' }
      throw new Error('network reset on next page')
    }
    mockStripeListIterator.mockReturnValue(failingIter())
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockReturnValue(chain(undefined))

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_1' } }))

    expect(res.status).toBe(200)
    expect(mockCancelWithRetry).toHaveBeenCalledWith('sub_a')
    // Discord notify は byte 不変 (context の kind は旧 'list'・error 文言不変)
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps.mock.calls[0]![0]).toBe(
      'stripe sub cancel failure during deletion',
    )
    const ctx = mockNotifyOps.mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.kind).toBe('list')
    expect(String(ctx.error)).toMatch(/page fetch failed at offset 1/)
    expect(String(ctx.error)).toMatch(/Canceled before failure: \[sub_a\]/)
    // dual-write: ledger 行に catalog の 4 軸 (deletion_list) + 型付き ref。
    // subId=null ゆえ stripeSubscriptionId は null。errorMessage = notify context.error と同一。
    const row = integrationInsertRow()
    expect(row).toBeDefined()
    const axes = INTEGRATION_FAILURE_CATALOG.deletion_list
    expect(row).toMatchObject({
      service: axes.service,
      operation: axes.operation,
      workflow: axes.workflow,
      failureCode: axes.failureCode,
      userId: '00000000-0000-0000-0000-0000000000a1',
      clerkId: 'user_1',
    })
    expect(row!.stripeSubscriptionId).toBeUndefined() // subId=null → helper が undefined 化 (ref 列を省略 = DB は NULL)
    expect(String(row!.errorMessage)).toMatch(/page fetch failed at offset 1/)
    // list 失敗後も transaction は実行される (forward-only)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 削除網羅性 invariant test
// ---------------------------------------------------------------------------
// schema を真実 source として、 「user_id を direct FK で users.id に cascade
// するテーブル」 のうち、 親 cascade chain (exams / cards 経由など) で間接削除
// されない「Group I」 を機械的に列挙し、 handler の tx.delete(...) 集合と一致する
// ことを検証する。
//
// 目的: 将来 schema に user_id direct FK の新テーブルが追加されたとき、 handler
// (route.ts の handleUserDeleted の transaction body) に明示 DELETE を加え忘れたら
// このテストが落ちて気づける (handler 集約コメント参照)。
//
// 判定式 (handler 集約コメントと同じ):
//   table T は Group I (= 明示 DELETE 対象) ⟺
//     T.userId が users.id に references({ onDelete: 'cascade' }) を持ち、
//     かつ T の他の FK の中に、 onDelete='cascade' で parent が user cascade chain
//     を持つ (direct or transitive) ものが存在しない
//
describe('Clerk webhook user.deleted: 削除網羅性 invariant', () => {
  it('handler の tx.delete 集合 = schema 由来の Group I 集合 (新規 user_id FK テーブル追加検知)', async () => {
    // schema を読み Group I を機械算出
    const expected = computeGroupITables()
    expect(expected.length).toBeGreaterThan(0) // sanity

    // handler を 1 回走らせて tx.delete(...) の引数 (= table 識別子) を捕捉
    mockSvixVerify.mockReturnValue({ type: 'user.deleted', data: { id: 'user_inv' } })
    mockDbInsert.mockReturnValueOnce(chain([{ id: 'msg_inv' }])) // clerk_events
    mockDbSelect.mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-0000000000ff', stripeCustomerId: null }]),
    )
    mockStripeListIterator.mockReturnValue(asyncIterFrom([]))

    const deleteCallTargets: unknown[] = []
    mockDbUpdate.mockReturnValue(chain(undefined))
    mockDbDelete.mockImplementation((table: unknown) => {
      deleteCallTargets.push(table)
      return chain(undefined)
    })

    const res = await POST(makeReq({ type: 'user.deleted', data: { id: 'user_inv' } }))
    expect(res.status).toBe(200)

    // 防御: handler が DELETE を 1 件も呼ばずに throughpath で抜けた regression
    // (e.g. tx.delete を別 API に書き換え) を「漏れ N 件」 でなく 「DELETE 自体ゼロ」 で
    // 明示検知する (M1 defense-in-depth)。
    expect(deleteCallTargets.length).toBeGreaterThan(0)
    const actual = new Set(deleteCallTargets)
    const expectedSet = new Set(expected)
    // 集合一致を name ベースで diff してエラー時に何が漏れ/余剰かわかるようにする
    const actualNames = new Set([...actual].map(tableName))
    const expectedNames = new Set([...expectedSet].map(tableName))
    const missing = [...expectedNames].filter((n) => !actualNames.has(n))
    const surplus = [...actualNames].filter((n) => !expectedNames.has(n))
    expect({ missing, surplus }).toEqual({ missing: [], surplus: [] })
  })
})

// schema 探索用 helper (test-scoped、 production code に染み出さない)
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import * as schemaModule from '@/lib/db/schema'

function isPgTable(v: unknown): v is PgTable {
  try {
    getTableConfig(v as PgTable)
    return true
  } catch {
    return false
  }
}

function tableName(t: unknown): string {
  try {
    return getTableConfig(t as PgTable).name
  } catch {
    return '<unknown>'
  }
}

function hasUserIdCascadeFK(table: PgTable): boolean {
  const cfg = getTableConfig(table)
  return cfg.foreignKeys.some((fk) => {
    const ref = fk.reference()
    const target = ref.foreignColumns[0]
    return target?.table === schemaModule.users && target.name === 'id' && fk.onDelete === 'cascade'
  })
}

// T の direct user_id FK 以外の FK が cascade で users 削除 chain に到達するか。
// 「親が user cascade chain を持つ」 = 親が hasUserIdCascadeFK (Group I/II のいずれか
// なら handler 流で親が消える) または 親自身がさらに別の親経由で chain を持つ。
function hasParentInUserCascadeChain(
  table: PgTable,
  visited: WeakSet<PgTable> = new WeakSet(),
): boolean {
  if (visited.has(table)) return false
  visited.add(table)
  const cfg = getTableConfig(table)
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference()
    const parent = ref.foreignColumns[0]?.table as PgTable | undefined
    if (!parent) continue
    if (parent === schemaModule.users) continue // direct user_id FK は precondition、 chain には数えない
    if (fk.onDelete !== 'cascade') continue
    if (hasUserIdCascadeFK(parent)) return true
    if (hasParentInUserCascadeChain(parent, visited)) return true
  }
  return false
}

function computeGroupITables(): PgTable[] {
  return Object.values(schemaModule)
    .filter(isPgTable)
    .filter((t) => t !== schemaModule.users)
    .filter((t) => hasUserIdCascadeFK(t) && !hasParentInUserCascadeChain(t))
}
