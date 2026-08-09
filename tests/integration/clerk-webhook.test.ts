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
  const execute = vi.fn()
  // transaction: callback をそのまま実行する (RLS-P2 で tx は execute (setTenantContext /
  // scrub) と insert (created の users INSERT) も受ける)
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return await fn({ execute, insert, update, delete: del })
  })
  const fakeDb = {
    insert,
    update,
    select,
    delete: del,
    execute,
    transaction,
  }
  // RLS-P3 (Task 1): route.ts event dedup + handle-clerk-event.ts
  // handleUserDeleted pre-tenant resolve now call getNonTenantDb() (same
  // underlying connection as getDb() — mechanical mock-target alias,
  // assertions/behavior unchanged). getDb() remains used by user.created's
  // withTenantTx(db, ...) call site (handleEvent ~L39).
  return {
    getDb: vi.fn(() => fakeDb),
    getNonTenantDb: vi.fn(() => fakeDb),
  }
})

// RLS-P2: created path が新規時に呼ぶ metadata sync は外部 I/O (Clerk API) ゆえ mock。
vi.mock('@/lib/auth/clerk-metadata', () => ({
  syncClerkPublicMetadata: vi.fn().mockResolvedValue({ ok: true }),
}))

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

// ②-4b §2: user.deleted は R2 の src/ prefix purge を伴う。実 R2 を叩かせない
// (listing 0 件 = 削除対象なし) — 他の外部 I/O stub と同じ扱い。
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

import { POST } from '@/app/api/webhooks/clerk/route'
import { getDb } from '@/lib/db'

// RLS-P2: created 存在チェック / deleted resolve は共に app_bootstrap_user_from_clerk を
// db/tx.execute で叩く。SQL text で判別して bootstrapRows を返す router を beforeEach で敷く。
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

let bootstrapRows: unknown[] = []

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
  bootstrapRows = []
  // clearAllMocks 後に execute router を再設定 (bootstrap は bootstrapRows、set_config /
  // app_scrub_deleted_user は no-op)。transaction 実装は factory 由来で clearAllMocks では
  // 消えない (impl 保持)。
  const db = vi.mocked(getDb)()
  vi.mocked(db.execute as ReturnType<typeof vi.fn>).mockImplementation((q: unknown) =>
    sqlText(q).includes('app_bootstrap_user_from_clerk')
      ? Promise.resolve(bootstrapRows)
      : Promise.resolve(undefined),
  )
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

  it('handles user.deleted → clerk_events INSERT + bootstrap resolve + transaction (scrub 関数 + assets deleting UPDATE + 10 delete) + 200', async () => {
    const db = vi.mocked(getDb)()
    vi.mocked(db.insert).mockReturnValueOnce(chain([{ id: 'msg_x' }]) as never)
    // resolve (app_bootstrap_user_from_clerk): stripe_customer_id=null (Free) → Stripe skip
    bootstrapRows = [
      { id: '00000000-0000-0000-0000-000000000001', stripe_customer_id: null },
    ]
    // transaction 内: setTenantContext + scrub 関数 (tx.execute) + assets deleting UPDATE
    // (drizzle update × 1) + delete Group I 10 子テーブル
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
    expect(db.select).not.toHaveBeenCalled() // resolve は db.select → db.execute に移行
    expect(db.transaction).toHaveBeenCalledTimes(1)
    // RLS-P2: drizzle update は assets deleting の 1 件のみ (users scrub は
    // app_scrub_deleted_user 関数呼出 = tx.execute に移行)。
    expect(db.update).toHaveBeenCalledTimes(1)
    // Group I 11 件のうち assets のみ soft-delete (deleting UPDATE) ゆえ物理 DELETE は 10 件:
    // exams + study_days + contact_messages + ai_usage_users + upload_records +
    // user_settings + study_sessions + tombstones + entity_mutations + tag_categories
    // (assets は W2 で明示 DELETE → deleting UPDATE に置換・R2 手掛かり保全 + GC 合流)
    // (entity_mutations は S-sync-1 で entity_id FK を撤廃したため、 cards cascade chain が
    //  なくなり Group I に昇格)
    // (tag_categories は Tag-1 で新設、 試験横断 master のため親 chain なし → Group I)
    expect(db.delete).toHaveBeenCalledTimes(10)
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
