import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Webhook } from 'svix'
import { logger } from '@/lib/logger'

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
vi.mock('@/lib/stripe/client', () => ({
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

  it('handles user.deleted → clerk_events INSERT + SELECT users + transaction (update + 11 delete) + 200', async () => {
    const db = vi.mocked(getDb)()
    vi.mocked(db.insert).mockReturnValueOnce(chain([{ id: 'msg_x' }]) as never)
    // SELECT users: customerId=null (Free プラン) → Stripe ループ skip
    vi.mocked(db.select).mockReturnValueOnce(
      chain([{ id: '00000000-0000-0000-0000-000000000001', stripeCustomerId: null }]) as never,
    )
    // transaction 内: update users (soft-delete + PII scrub) + delete Group I 11 子テーブル
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
    expect(db.update).toHaveBeenCalledTimes(1)  // users soft-delete + scrub (inside transaction)
    // Group I 11 件: exams + study_days + contact_messages + ai_usage_users +
    // upload_records + user_settings + study_sessions + tombstones + entity_mutations +
    // tag_categories + assets (assets = 画像フェーズ A)
    // (entity_mutations は S-sync-1 で entity_id FK を撤廃したため、 cards cascade chain が
    //  なくなり Group I に昇格)
    // (tag_categories は Tag-1 で新設、 試験横断 master のため親 chain なし → Group I)
    expect(db.delete).toHaveBeenCalledTimes(11)
  })

  it('unknown event type → safeParse fail で early return 200 (clerk_events INSERT 不到達、 T-A6)', async () => {
    // T-A6 (audit §10.3 (b) #10): payload は zod schema (user.created /
    // user.deleted の discriminated union) で safeParse、 未対応 type は
    // signature verify 後の受領段で fail → 200 + logger.warn で吸収する。
    // これにより `clerk_events` table が handler 対象外 event で汚染されない。
    // Clerk 側は 200 を受けて再送しないため再送ループの懸念なし。
    const db = vi.mocked(getDb)()
    const body = JSON.stringify({
      type: 'session.created',
      data: { id: 'sess_1' },
    })
    const req = signed(body)
    const res = await POST(req)
    expect(res.status).toBe(200)
    // safeParse fail で early return → DB insert に到達しない
    expect(db.insert).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('secret 未設定 × VERCEL_ENV=production → throw (T-A8 fail-fast、 Next.js handler で 500 に変換される)', async () => {
    // T-A8 (audit §10.3 (b) #17): production tier では requireWebhookSecret が
    // 起動時 throw する fail-fast 経路。 旧 NODE_ENV='production' 偽装 × 500
    // 期待は T-A8 helper が VERCEL_ENV 単独判定に統一されたため、 VERCEL_ENV
    // 偽装に書き換え。 throw 文言を assert することで fail-fast 強度を維持
    // (Next.js framework 内部の throw → 500 変換は handler test 範疇外、 throw
    // 到達 = wire-level 500 と等価)。
    delete process.env.CLERK_WEBHOOK_SECRET
    const origVE = process.env.VERCEL_ENV
    process.env.VERCEL_ENV = 'production'
    try {
      const req = new Request('http://localhost/api/webhooks/clerk', {
        method: 'POST',
        body: '{}',
      })
      await expect(POST(req)).rejects.toThrow(
        /CLERK_WEBHOOK_SECRET must be set in production/,
      )
    } finally {
      if (origVE === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = origVE
    }
  })

  it('secret 未設定 × VERCEL_ENV=preview → 400 + logger.warn (T-A8 preview tier)', async () => {
    // T-A8: preview tier では throw せず、 logger.warn('webhook.secret.missing_preview')
    // を 1 行残しつつ requireWebhookSecret は空文字を返す → svix 検証段で空文字
    // secret 起因 fail → 400 帰着。 missing-secret 状態を silent success 偽装
    // させない hardening (旧 200 silent → 新 400 fail-loud)。
    delete process.env.CLERK_WEBHOOK_SECRET
    const origVE = process.env.VERCEL_ENV
    process.env.VERCEL_ENV = 'preview'
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const req = new Request('http://localhost/api/webhooks/clerk', {
        method: 'POST',
        body: '{}',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'webhook.secret.missing_preview',
          envKey: 'CLERK_WEBHOOK_SECRET',
        }),
      )
    } finally {
      warnSpy.mockRestore()
      if (origVE === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = origVE
    }
  })
})
