import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Webhook } from 'svix'

// Universal drizzle chain mock: `.values() / .onConflictDoNothing() / .returning() / .set() /
// .where()` のどこを await しても resolveTo に解決する。test ごとに insert/update の戻り値を
// mockReturnValueOnce で順次設定する (Webhook handler の B2 改造で chain shape が増えたため)。
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

vi.mock('@/lib/db', () => {
  const insert = vi.fn()
  const update = vi.fn()
  const select = vi.fn()
  const del = vi.fn()
  // transaction: callback をそのまま実行する (tx は db と同 shape)
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return await fn({ update, delete: del })
  })
  return {
    getDb: vi.fn(() => ({ insert, update, select, delete: del, transaction })),
  }
})

// Spec §6.2: webhook handler が Stripe sub cancel を引き受ける。integration test
// では実 Stripe API を叩かないため、empty iterator + cancelWithRetry no-op で stub。
vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      list: () => (async function* () {})(),
    },
  },
  cancelWithRetry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ops', () => ({
  notifyOps: vi.fn().mockResolvedValue(undefined),
  notifyWebhookError: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from '@/app/api/webhooks/clerk/route'
import { getDb } from '@/lib/db'

// Must be a Svix-compatible secret: must start with "whsec_" and decode as base64.
// "whsec_" + base64("testtesttesttesttesttest") is a valid fake.
const SECRET = 'whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0'

function signed(body: string, overrides: Record<string, string> = {}) {
  const svixId = overrides['svix-id'] ?? `msg_${Math.random().toString(36).slice(2)}`
  const ts =
    overrides['svix-timestamp'] ?? Math.floor(Date.now() / 1000).toString()
  let sig = overrides['svix-signature']
  if (!sig) {
    const wh = new Webhook(SECRET)
    sig = wh.sign(svixId, new Date(Number(ts) * 1000), body)
  }
  const headers = new Headers({
    'svix-id': svixId,
    'svix-timestamp': ts,
    'svix-signature': sig,
  })
  return new Request('http://localhost/api/webhooks/clerk', {
    method: 'POST',
    headers,
    body,
  })
}

beforeEach(() => {
  process.env.CLERK_WEBHOOK_SECRET = SECRET
  vi.clearAllMocks()
})

describe('POST /api/webhooks/clerk (real svix sign + verify)', () => {
  it('rejects bad signature with 400', async () => {
    const body = JSON.stringify({ type: 'user.created', data: { id: 'u1' } })
    const req = signed(body, { 'svix-signature': 'v1,bad' })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('handles user.created → clerk_events INSERT + users INSERT, 200', async () => {
    const db = vi.mocked(getDb)()
    // 1st insert = clerk_events idempotency, 2nd insert = users
    vi.mocked(db.insert)
      .mockReturnValueOnce(chain([{ id: 'msg_x' }]) as never)
      .mockReturnValueOnce(chain(undefined) as never)
    const body = JSON.stringify({
      type: 'user.created',
      data: {
        id: 'user_abc',
        email_addresses: [{ email_address: 'a@example.com' }],
      },
    })
    const req = signed(body)
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(db.insert).toHaveBeenCalledTimes(2)
  })

  it('handles user.deleted → clerk_events INSERT + SELECT users + transaction (update + 3 delete) + 200', async () => {
    const db = vi.mocked(getDb)()
    vi.mocked(db.insert).mockReturnValueOnce(chain([{ id: 'msg_x' }]) as never)
    // SELECT users: customerId=null (Free プラン) → Stripe ループ skip
    vi.mocked(db.select).mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-000000000001', stripeCustomerId: null }]) as never,
    )
    // transaction 内: update users + delete exams + delete study_days + delete contact_messages
    vi.mocked(db.update).mockReturnValue(chain(undefined) as never)
    vi.mocked(db.delete).mockReturnValue(chain(undefined) as never)
    const body = JSON.stringify({
      type: 'user.deleted',
      data: { id: 'user_abc' },
    })
    const req = signed(body)
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(db.insert).toHaveBeenCalledTimes(1) // clerk_events のみ (Stripe skip, 失敗 0)
    expect(db.select).toHaveBeenCalledTimes(1)  // users SELECT
    expect(db.transaction).toHaveBeenCalledTimes(1)
    expect(db.update).toHaveBeenCalledTimes(1)  // users soft-delete (inside transaction)
    expect(db.delete).toHaveBeenCalledTimes(3)  // exams + study_days + contact_messages
  })

  it('unknown event type → clerk_events INSERT のみで no-op 200', async () => {
    const db = vi.mocked(getDb)()
    vi.mocked(db.insert).mockReturnValueOnce(chain([{ id: 'msg_x' }]) as never)
    const body = JSON.stringify({
      type: 'session.created',
      data: { id: 'sess_1' },
    })
    const req = signed(body)
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(db.insert).toHaveBeenCalledTimes(1) // clerk_events idempotency のみ
    expect(db.update).not.toHaveBeenCalled()
  })

  it('secret 未設定 × NODE_ENV=production → 500 (misconfigured)', async () => {
    delete process.env.CLERK_WEBHOOK_SECRET
    const origEnv = process.env.NODE_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    try {
      const req = new Request('http://localhost/api/webhooks/clerk', {
        method: 'POST',
        body: '{}',
      })
      const res = await POST(req)
      expect(res.status).toBe(500)

      // 既存の「非 production × unset → 200」挙動も同じテスト内で両立確認
      ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
      const res2 = await POST(
        new Request('http://localhost/api/webhooks/clerk', {
          method: 'POST',
          body: '{}',
        }),
      )
      expect(res2.status).toBe(200)
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = origEnv
    }
  })
})
