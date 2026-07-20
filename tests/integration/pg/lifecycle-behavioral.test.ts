// RLS-P2 Task 10 (B): user lifecycle の behavioral 挙動を実 PG (RLS on) で pin。
//
// webhook handler は auth() 非経由 (署名検証済 event 由来) ゆえ auth mock 不要。getDb は
// real (RLS on) を掴み、handler 内 withTenantTx / definer 関数が本番と同じ配線で走る。
// 外部 I/O (Stripe / Clerk API / Discord) のみ mock し、「skip より前に外部副作用が
// 起きない」を not-called で pin する。
//
// mock 方針 (clerk-webhook.test.ts / stripe-webhook.test.ts の踏襲):
//   - @/lib/stripe/client  : subscriptions.list/retrieve + cancelWithRetry (実 Stripe 遮断)
//   - @/lib/auth/clerk-metadata : syncClerkPublicMetadata (実 Clerk API 遮断・呼分け観測)
//   - @/lib/ops            : notifyOps / notifyWebhookError (Discord 遮断・文言 assert)
//   - @/lib/integration-failures : recordIntegrationFailure (Discord+DB 遮断・happy path 未呼)
//   - logger.warn は spy (stripe skip log の観測)
// getDb は mock しない (real PG・RLS on)。module-cache 注意は lifecycle-null-contract.test.ts 参照。
import type Stripe from 'stripe'

import { eq, sql } from 'drizzle-orm'
import { Webhook } from 'svix'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  stripeListMock,
  stripeRetrieveMock,
  cancelWithRetryMock,
  syncMetadataMock,
  notifyOpsMock,
  notifyWebhookErrorMock,
  recordFailureMock,
} = vi.hoisted(() => ({
  stripeListMock: vi.fn(() => (async function* () {})()),
  stripeRetrieveMock: vi.fn(),
  cancelWithRetryMock: vi.fn().mockResolvedValue(undefined),
  syncMetadataMock: vi.fn().mockResolvedValue({ ok: true }),
  notifyOpsMock: vi.fn().mockResolvedValue(undefined),
  notifyWebhookErrorMock: vi.fn().mockResolvedValue(undefined),
  recordFailureMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/stripe/client', () => ({
  stripe: { subscriptions: { list: stripeListMock, retrieve: stripeRetrieveMock } },
  cancelWithRetry: cancelWithRetryMock,
}))
vi.mock('@/lib/auth/clerk-metadata', () => ({ syncClerkPublicMetadata: syncMetadataMock }))
vi.mock('@/lib/ops', () => ({
  notifyOps: notifyOpsMock,
  notifyWebhookError: notifyWebhookErrorMock,
}))
vi.mock('@/lib/integration-failures', () => ({ recordIntegrationFailure: recordFailureMock }))

import { closeDb } from '@/lib/db'
import { clerkEvents, users } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { handleEvent as handleClerkEvent } from '@/lib/clerk/handle-clerk-event'
import { handleEvent as handleStripeEvent } from '@/lib/stripe/handle-stripe-event'
import { POST as clerkWebhookPOST } from '@/app/api/webhooks/clerk/route'

import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  truncateAllUserTables,
} from './setup/fixture'

// svix 署名済 secret (base64 デコード可能な fake・clerk-webhook.test.ts と同値)。
const CLERK_SECRET = 'whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0'

function signedClerk(body: string, svixId: string): Request {
  const ts = Math.floor(Date.now() / 1000).toString()
  const wh = new Webhook(CLERK_SECRET)
  const sig = wh.sign(svixId, new Date(Number(ts) * 1000), body)
  return new Request('http://localhost/api/webhooks/clerk', {
    method: 'POST',
    headers: new Headers({ 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': sig }),
    body,
  })
}

let warnSpy: ReturnType<typeof vi.spyOn>

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

beforeEach(async () => {
  await truncateAllUserTables()
  // clerk_events は global 表 (user_id 無・RLS 対象外) ゆえ truncateAllUserTables で
  // 掃かれない。owner で明示 truncate (app role は TRUNCATE 権限を持たない)。
  await getFixtureOwnerDb().execute(sql.raw('TRUNCATE TABLE clerk_events'))
  vi.clearAllMocks()
  // clearAllMocks は impl を消さないが (resetAllMocks でない)、明示再設定で堅牢化。
  stripeListMock.mockImplementation(() => (async function* () {})())
  cancelWithRetryMock.mockResolvedValue(undefined)
  syncMetadataMock.mockResolvedValue({ ok: true })
  notifyOpsMock.mockResolvedValue(undefined)
  notifyWebhookErrorMock.mockResolvedValue(undefined)
  recordFailureMock.mockResolvedValue(undefined)
  process.env.CLERK_WEBHOOK_SECRET = CLERK_SECRET
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('clerk lifecycle behavioral (real PG, RLS on)', () => {
  it('re-delete is a neutral no-op: second user.deleted → notifyOps neutral wording, no throw', async () => {
    const owner = getFixtureOwnerDb()
    const clerkId = 'clerk_redelete_1'

    await handleClerkEvent({
      type: 'user.created',
      data: { id: clerkId, email_addresses: [{ email_address: 'rd@example.test' }] },
    })
    // 1st delete: resolve OK → scrub (deleted_at set + clerk_id NULL) + cascade。
    await handleClerkEvent({ type: 'user.deleted', data: { id: clerkId } })

    const afterFirst = await owner
      .select({ id: users.id, deletedAt: users.deletedAt, clerkId: users.clerkId })
      .from(users)
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.deletedAt).not.toBeNull()
    expect(afterFirst[0]?.clerkId).toBeNull()

    // 2nd delete (別 event): clerk_id NULL 化済 → bootstrap 0 行 → 中立文言 no-op。
    await expect(
      handleClerkEvent({ type: 'user.deleted', data: { id: clerkId } }),
    ).resolves.toBeUndefined()

    expect(notifyOpsMock).toHaveBeenCalledWith(
      'user.deleted received but users row not found (not-synced or already-deleted)',
      expect.objectContaining({ clerkUserId: clerkId }),
    )
  })

  it('user.created after deletion creates a NEW row; the old scrubbed row is left intact', async () => {
    const owner = getFixtureOwnerDb()
    // 旧 scrub 済み行 (別テナントの退会跡)。
    const [old] = await owner
      .insert(users)
      .values({ deletedAt: new Date('2026-06-01T00:00:00.000Z'), email: null, clerkId: null })
      .returning({ id: users.id })

    const newClerkId = 'clerk_recreated_1'
    await handleClerkEvent({
      type: 'user.created',
      data: { id: newClerkId, email_addresses: [{ email_address: 'again@example.test' }] },
    })

    const all = await owner
      .select({ id: users.id, clerkId: users.clerkId, deletedAt: users.deletedAt })
      .from(users)
    expect(all).toHaveLength(2) // 旧行残置 + 新規行

    const created = all.find((r) => r.clerkId === newClerkId)
    expect(created).toBeDefined()
    expect(created?.deletedAt).toBeNull()
    expect(created?.id).not.toBe(old!.id)

    const oldAfter = all.find((r) => r.id === old!.id)
    expect(oldAfter?.deletedAt).not.toBeNull()
    expect(oldAfter?.clerkId).toBeNull()

    // 新規作成時のみ metadata sync (created gate)。
    expect(syncMetadataMock).toHaveBeenCalledWith(
      expect.objectContaining({ clerkId: newClerkId, plan: 'free' }),
    )
  })

  it('dedupe precedes resolver: duplicate svix-id → 200 "duplicate" + handleEvent NOT re-invoked', async () => {
    const svixId = `msg_dedupe_${Math.random().toString(36).slice(2)}`
    const body = JSON.stringify({
      type: 'user.created',
      data: { id: 'clerk_dedupe_1', email_addresses: [{ email_address: 'dd@example.test' }] },
    })

    const res1 = await clerkWebhookPOST(signedClerk(body, svixId))
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe('ok')
    // handler 実行 (user.created) → 新規作成 → metadata sync 1 回。
    expect(syncMetadataMock).toHaveBeenCalledTimes(1)

    const res2 = await clerkWebhookPOST(signedClerk(body, svixId))
    expect(res2.status).toBe(200)
    // clerk_events dedupe が handleEvent より前で short-circuit。
    expect(await res2.text()).toBe('duplicate')
    // handler 不再実行 → sync は依然 1 回 (resolver が dedupe の後段ゆえ再走しない)。
    expect(syncMetadataMock).toHaveBeenCalledTimes(1)

    // ground-truth: clerk_events は 1 行のみ (重複 INSERT は onConflictDoNothing で skip)。
    const evRows = await getFixtureOwnerDb()
      .select({ id: clerkEvents.eventId })
      .from(clerkEvents)
      .where(eq(clerkEvents.eventId, svixId))
    expect(evRows).toHaveLength(1)
  })
})

describe('stripe lifecycle behavioral (real PG, RLS on)', () => {
  it('subscription.updated for a deleted (scrubbed) user → log + skip; no users write, no external I/O', async () => {
    const owner = getFixtureOwnerDb()
    const customerId = 'cus_deleted_stripe_1'
    // scrub 済み user (deleted_at set・clerk_id NULL・stripe_customer_id は correlation で保持)。
    const [deleted] = await owner
      .insert(users)
      .values({
        deletedAt: new Date('2026-07-01T00:00:00.000Z'),
        email: null,
        clerkId: null,
        stripeCustomerId: customerId,
        plan: 'pro', // 変化しないことを pin するための distinctive 値。
      })
      .returning({ id: users.id })

    const event = {
      id: 'evt_skip_deleted_1',
      type: 'customer.subscription.updated',
      data: {
        object: { id: 'sub_x', customer: customerId, status: 'active', items: { data: [] } },
      },
    } as unknown as Stripe.Event

    await handleStripeEvent(event)

    // red 検証の帰属注記 (subscription.updated 限定):
    // この event 種別で Task-7 の skipIfDeleted 判定に**唯一 discriminate される**のは
    // 下の warn (log-emission) assertion のみ。skipIfDeleted を除去すると warn 0 で fail
    // する (red 済)。残る 3 assertion は true だが skip 由来でなく別レイヤーの多層防御:
    //   - stripeRetrieveMock 未呼: retrieve は checkout.session.completed 分岐のみが呼ぶ
    //     (handle-stripe-event.ts ~:122)。subscription.updated は元々 retrieve を呼ばない
    //     ため、この event では**構造的に vacuous** (skip の有無に無関係)。退会 user への
    //     retrieve-not-called の load-bearing 証明は retrieve が実際に到達する checkout 経路
    //     の test = `tests/integration/stripe-webhook.test.ts` の「checkout.session.completed
    //     → 退会済み」2 本 (Task 7 追加。fallback なしで retrieve が走り warn 0 = red) が担う。
    //   - syncMetadata 未呼: project-subscription.ts の既存 A-4 gate (`result.matched &&
    //     result.clerkId`) が保証。scrub 行は clerkId null ゆえ skip の有無に無関係に sync skip。
    //   - users write なし (plan/deletedAt 不変): RLS users_update policy
    //     (USING id=ctx AND deleted_at IS NULL → 0 行) が app 層 skip と独立に保証。
    // Vitest は最初の失敗 expect で停止するため、red 走行は warn assertion で fail し
    // 下 3 者は mutation 下で実行されない。ゆえに report の red 検証 matrix ではこの行を
    // 「log-emission のみ discriminate・残りは defense-in-depth」と注記する (blanket ✅ でない)。
    expect(warnSpy).toHaveBeenCalledWith({
      event: 'stripe.event.skipped_deleted_user',
      type: 'customer.subscription.updated',
    })
    // 以下 3 者は defense-in-depth の現挙動 document (上記のとおり skip 非帰属)。
    expect(syncMetadataMock).not.toHaveBeenCalled()
    expect(stripeRetrieveMock).not.toHaveBeenCalled()

    // users write が起きない: plan は 'pro' のまま・deleted のまま (RLS policy が担保)。
    const [after] = await owner
      .select({ plan: users.plan, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, deleted!.id))
    expect(after?.plan).toBe('pro')
    expect(after?.deletedAt).not.toBeNull()
  })
})
