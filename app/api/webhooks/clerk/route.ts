// Spec §6.2 / §8.1-§8.5 / §6.3
// Clerk webhook handler。Webhook 駆動再設計の主体 (Plan B B2)。
//
// Architecture:
// 1. Svix 検証
// 2. clerk_events idempotency INSERT (svix-id PK、duplicate なら 200 即 return)
// 3. user.created → users INSERT ON CONFLICT DO NOTHING (既存挙動維持)
//    user.deleted → DB deletedAt set + Stripe sub auto-pagination cancel
// 4. outer catch で notifyOps explicit (Next.js onRequestError は uncaught 限定 fire)
// 5. 200 強制 return (Clerk リトライ抑止、recovery は deletion_failures + 手動)

import { Webhook } from 'svix'
import { eq, sql } from 'drizzle-orm'
import Stripe from 'stripe'
import { getDb } from '@/lib/db'
import { users, clerkEvents, deletionFailures, exams, studyDays, contactMessages } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { stripe, cancelWithRetry } from '@/lib/stripe'
import { notifyOps, notifyWebhookError } from '@/lib/ops'

export const runtime = 'nodejs'

type ClerkEvent =
  | {
      type: 'user.created'
      data: { id: string; email_addresses?: { email_address: string }[] }
    }
  | { type: 'user.deleted'; data: { id: string } }
  | { type: string; data: unknown }

// Spec §8.4: cancel 対象 status。canceled / incomplete* / unpaid / paused は skip。
const CANCEL_TARGETS = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
])

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error({ event: 'webhook.clerk.misconfig', secret: 'CLERK_WEBHOOK_SECRET' })
      return new Response('misconfigured', { status: 500 })
    }
    return new Response('CLERK_WEBHOOK_SECRET not set', { status: 200 })
  }

  const svixId = req.headers.get('svix-id')
  const svixTs = req.headers.get('svix-timestamp')
  const svixSig = req.headers.get('svix-signature')
  if (!svixId || !svixTs || !svixSig) {
    return new Response('missing svix headers', { status: 400 })
  }

  const payload = await req.text()

  let evt: ClerkEvent
  try {
    const wh = new Webhook(secret)
    evt = wh.verify(payload, {
      'svix-id': svixId,
      'svix-timestamp': svixTs,
      'svix-signature': svixSig,
    }) as ClerkEvent
  } catch {
    return new Response('invalid signature', { status: 400 })
  }

  const db = getDb()

  // Spec §8.1 layer 0: clerk_events idempotency. svix-id を PK として INSERT、
  // duplicate なら 200 即 return (Clerk が同一 message を再配信した場合の skip)。
  const inserted = await db
    .insert(clerkEvents)
    .values({ eventId: svixId, type: evt.type })
    .onConflictDoNothing({ target: clerkEvents.eventId })
    .returning({ id: clerkEvents.eventId })
  if (inserted.length === 0) {
    return new Response('duplicate', { status: 200 })
  }

  // user.deleted / user.created は evt.data.id を持つ。outer catch で userId を
  // 通知に含めて切り分け (Vercel logs / Neon SELECT) を簡素化 — spec §8.2。
  const userId = (evt.data as { id?: string } | null | undefined)?.id

  try {
    await handleEvent(evt)
    return new Response('ok', { status: 200 })
  } catch (err) {
    // Spec §8.2 + Phase 1 E-3 spec: outer catch で notifyWebhookError 経由 (Stripe 側
    // と payload shape 統一、env/timestamp 自動付与)。
    await notifyWebhookError({
      handler: 'clerk',
      eventId: svixId,
      eventType: evt.type,
      err,
      userId,
    })
    return new Response('handler error swallowed', { status: 200 })
  }
}

async function handleEvent(evt: ClerkEvent): Promise<void> {
  const db = getDb()
  if (evt.type === 'user.created') {
    const data = evt.data as { id: string; email_addresses?: { email_address: string }[] }
    const email = data.email_addresses?.[0]?.email_address ?? 'unknown@example.com'
    await db
      .insert(users)
      .values({ clerkId: data.id, email })
      .onConflictDoNothing({ target: users.clerkId })
    return
  }
  if (evt.type === 'user.deleted') {
    const data = evt.data as { id: string }
    await handleUserDeleted(data.id)
    return
  }
  // Other event types: no-op (200 が後で返る)
}

async function handleUserDeleted(clerkUserId: string): Promise<void> {
  const db = getDb()

  // §6: SELECT users by clerkId to get internal id and Stripe customer.
  // Using SELECT-first (instead of UPDATE-RETURNING) so Stripe cancel can run
  // before the DB transaction, and unsynced users (SELECT 0 rows) are detected
  // without issuing an UPDATE that would have no effect.
  const rows = await db
    .select({ id: users.id, stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.clerkId, clerkUserId))
    .limit(1)
  const internalUserId = rows[0]?.id
  const customerId = rows[0]?.stripeCustomerId

  // F-5 fix-up (review M-1): users 未同期 (user.created webhook が user.deleted より
  // 遅れて到達した順序逆転 edge case) は deletion_failures.user_id uuid NOT NULL に
  // 書けず audit 不可。silent skip させず notifyOps で観測性を確保し、OT が Clerk
  // webhook 配送順序の異常を検知できるようにする。
  if (!internalUserId) {
    await notifyOps('user.deleted received but users row not synced', {
      clerkUserId,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    return
  }

  // §6 / §8.4 / §8.5: customerId があれば Stripe sub cancel ループを実行する
  // (transaction 外。Stripe 失敗が記録されても DB transaction は forward-only で実行)。
  // customerId なし = Free プラン user → Stripe ループを skip して transaction へ進む。
  if (customerId) {
    // canceledIds と offset を function スコープで保持し、list 失敗時の
    // error_message に詰める (admin が Stripe Dashboard で残 sub を grep するため)
    const canceledIds: string[] = []
    let offset = 0
    try {
      for await (const sub of stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
      })) {
        offset++
        if (!CANCEL_TARGETS.has(sub.status)) continue
        try {
          await cancelWithRetry(sub.id)
          canceledIds.push(sub.id)
        } catch (err) {
          await recordFailure({
            internalUserId,
            clerkUserId,
            subId: sub.id,
            kind: 'cancel',
            errorMessage: String(err),
          })
        }
      }
    } catch (err) {
      const kind = isCustomerMissing(err) ? 'customer_missing' : 'list'
      const errorMessage =
        kind === 'list'
          ? `page fetch failed at offset ${offset}: ${String(err)}. Canceled before failure: [${canceledIds.join(', ')}]`
          : String(err)
      await recordFailure({
        internalUserId,
        clerkUserId,
        subId: null,
        kind,
        errorMessage,
      })
    }
  }

  // §6: DB transaction — soft-delete users + hard-delete child tables.
  // exams DELETE cascades to cards / source_documents / reviews via FK ON DELETE CASCADE.
  // study_days / contact_messages have FK only to users.id and users is not hard-deleted,
  // so they require explicit DELETE here.
  // retry なし (T3 で追加)。
  try {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ deletedAt: sql`now()` }).where(eq(users.id, internalUserId))
      await tx.delete(exams).where(eq(exams.userId, internalUserId))
      await tx.delete(studyDays).where(eq(studyDays.userId, internalUserId))
      await tx.delete(contactMessages).where(eq(contactMessages.userId, internalUserId))
    })
  } catch (err) {
    await recordFailure({
      internalUserId,
      clerkUserId,
      subId: null,
      kind: 'data_deletion',
      errorMessage: String(err),
    })
  }
}

/**
 * §6: deletion_failures 書き込み + notifyOps の合成。
 * DB 書き込み (audit、真実) → notifyOps (人通知、best-effort) の順。
 * notifyOps 自身が throw しない設計なので順序による副作用なし。
 *
 * F-5: deletion_failures が Option A (uuid user_id + clerk_id text) に切替済。
 *   internalUserId (users.id 内部 UUID、grouping/template 一貫性) と
 *   clerkUserId (Clerk Dashboard で grep 用) を別 column に書く。
 *
 * kind='data_deletion': DB transaction 失敗 (subId=null)。subject は別文言。
 * kind∈{list,cancel,customer_missing}: Stripe cancel 失敗。subject は既存文言 (byte 不変)。
 */
async function recordFailure(args: {
  internalUserId: string
  clerkUserId: string
  subId: string | null
  kind: 'list' | 'cancel' | 'customer_missing' | 'data_deletion'
  errorMessage: string
}): Promise<void> {
  const db = getDb()
  await db.insert(deletionFailures).values({
    userId: args.internalUserId,
    clerkId: args.clerkUserId,
    subId: args.subId,
    failureKind: args.kind,
    errorMessage: args.errorMessage,
  })
  // Phase 1 E-3 spec: recordFailure は subject が webhook error と異なる (削除フロー
  // 専用の per-sub cancel 失敗) ため notifyWebhookError には乗せない。代わりに
  // environment + timestamp を inline 注入し、payload baseline を揃える。
  const subject =
    args.kind === 'data_deletion'
      ? 'user data deletion failure'
      : 'stripe sub cancel failure during deletion'
  await notifyOps(subject, {
    userId: args.internalUserId,
    clerkId: args.clerkUserId,
    subId: args.subId,
    kind: args.kind,
    error: args.errorMessage,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    timestamp: new Date().toISOString(),
  })
}

// Spec §8.5: customer 削除済み判定。Stripe SDK の error code で narrow。
function isCustomerMissing(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError &&
    err.code === 'resource_missing'
  )
}
