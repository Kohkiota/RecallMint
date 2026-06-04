// Clerk webhook handler。設計: tech-spec §6 (アカウント削除フロー) / §5 (認証同期)。
//
// Architecture:
// 1. Svix 検証
// 2. clerk_events idempotency INSERT (svix-id PK、duplicate なら 200 即 return)
// 3. user.created → users INSERT ON CONFLICT DO NOTHING (既存挙動維持)
//    user.deleted → Stripe sub cancel + soft delete + 子データ物理削除 (retry 付)
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
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'

export const runtime = 'nodejs'

type ClerkEvent =
  | {
      type: 'user.created'
      data: { id: string; email_addresses?: { email_address: string }[] }
    }
  | { type: 'user.deleted'; data: { id: string } }
  | { type: string; data: unknown }

// cancel 対象 status。canceled / incomplete* / unpaid / paused は skip。
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

  // clerk_events idempotency. svix-id を PK として INSERT、
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
  // 通知に含めて切り分け (Vercel logs / Neon SELECT) を簡素化。
  const userId = (evt.data as { id?: string } | null | undefined)?.id

  try {
    await handleEvent(evt)
    return new Response('ok', { status: 200 })
  } catch (err) {
    // outer catch で notifyWebhookError 経由 (Stripe 側
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
    // .returning({id}) で INSERT 成立 (新規) と conflict (既存) を区別する。
    // 新規時のみ Clerk publicMetadata を初期 sync (dbUserId + plan='free')。
    // conflict 時 (= webhook re-fire 等で既に users 行が存在) は metadata sync を
    // skip — 既存 metadata の plan 値を 'free' に上書きする race を防ぐ。
    // 復旧経路: conflict path で metadata が欠落した user は (a) 次の user 由来
    // webhook (Stripe subscription 系) で publicMetadata.plan が補填される、
    // (b) consumer 側の getAuthContext() が dbUserId 未設定時に getCurrentUser()
    // へ fallback する設計、 の 2 段で degraded mode を吸収する。 一斉復旧は
    // 別途 backfill (後続 sprint の chore commit) で実施予定。
    const inserted = await db
      .insert(users)
      .values({ clerkId: data.id, email })
      .onConflictDoNothing({ target: users.clerkId })
      .returning({ id: users.id })
    const dbUserId = inserted?.[0]?.id
    if (dbUserId) {
      await syncClerkPublicMetadata({
        clerkId: data.id,
        dbUserId,
        plan: 'free',
      })
    }
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

  // §6: customerId があれば Stripe sub cancel ループを実行する
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

  // §6 / T3: DB transaction — soft-delete users + GDPR PII scrub + hard-delete child tables。
  // exams DELETE cascades to cards / source_documents / reviews via FK ON DELETE CASCADE。
  // study_days / contact_messages have FK only to users.id and users is not hard-deleted,
  // so they require explicit DELETE here.
  // GDPR PII scrub: users 行は audit / correlation のため残置するが、 PII 列
  // (email, clerk_id) を NULL に上書きする。 stripe_customer_id は cus_xxx 単体で
  // 個人特定不能なため correlation key として保持。 NULL 上書きは値レベルで冪等、
  // webhook 再送は上位の clerk_events.event_id dedup で 1 回に絞られる。
  // T3: transient DB error (deadlock / serialization / connection 切断) に対し最大 3 retry。
  // permanent error (整合性違反等) は即中断。両者とも最終失敗時は recordFailure(data_deletion)。
  await runTransactionWithRetry(
    db,
    async (tx) => {
      await tx
        .update(users)
        .set({ deletedAt: sql`now()`, email: null, clerkId: null })
        .where(eq(users.id, internalUserId))
      await tx.delete(exams).where(eq(exams.userId, internalUserId))
      await tx.delete(studyDays).where(eq(studyDays.userId, internalUserId))
      await tx.delete(contactMessages).where(eq(contactMessages.userId, internalUserId))
    },
    async (errorMessage) => {
      await recordFailure({
        internalUserId,
        clerkUserId,
        subId: null,
        kind: 'data_deletion',
        errorMessage,
      })
    },
  )
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

// customer 削除済み判定。Stripe SDK の error code で narrow。
function isCustomerMissing(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeInvalidRequestError &&
    err.code === 'resource_missing'
  )
}

// §6 / T3: transient DB error 判定 (postgres-js / pg SQLSTATE ベース)。
// transient = 再試行で回復しうるエラー (deadlock / serialization / connection 切断など)。
// permanent = 整合性違反 (23xxx 等) は retry しても無意味なので即中断。
// lib/ai/ocr.ts の isTransientError と同じ「local 非 export 関数」思想で実装。
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (!code) {
    // code を持たない error = connection 切断系とみなして transient 扱い。
    // pg driver が code を付けない場合があるため、code 不在 = transient が安全側。
    return true
  }
  return (
    code === '40001' || // serialization failure
    code === '40P01' || // deadlock detected
    code.startsWith('08') || // connection exception class
    code === '57P01' || // admin shutdown
    code === '57P02' || // crash shutdown
    code === '57P03'   // cannot connect now
  )
}

// §6 / T3: DB transaction を最大 3 retry (= 合計 4 試行) でラップする local 関数。
// transient error (isTransientDbError=true) のときのみ retry、permanent は即中断。
// backoff: retry1 前 500ms / retry2 前 1000ms / retry3 前 2000ms (ocr.ts callWithRetry と同値構造)。
// transaction は idempotent (UPDATE deleted_at + PII scrub (email/clerkId NULL → NULL = no-op) /
// DELETE WHERE は再実行安全) なので retry 安全。
// Stripe cancel ループと recordFailure 本体はこの wrap 対象外。
const MAX_DB_RETRIES = 3 // 初回 + 3 retries = 合計 4 試行

async function runTransactionWithRetry(
  db: ReturnType<typeof getDb>,
  fn: Parameters<ReturnType<typeof getDb>['transaction']>[0],
  onFailure: (errorMessage: string) => Promise<void>,
): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await db.transaction(fn)
      return // 成功
    } catch (err) {
      lastErr = err
      const isTransient = isTransientDbError(err)
      if (!isTransient || attempt === MAX_DB_RETRIES) {
        // permanent error または retry 上限到達 → failure を記録して終了
        const totalAttempts = attempt + 1
        const code = (err as { code?: string } | null)?.code
        const diagnosis = code
          ? `pg error code ${code}: ${String(err)}`
          : String(err)
        await onFailure(
          `data deletion failed after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'} (${attempt} ${attempt === 1 ? 'retry' : 'retries'}): ${diagnosis}`,
        )
        return
      }
      const backoffMs = 500 * Math.pow(2, attempt) // 500 / 1000 / 2000
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  // ここには到達しないが TypeScript の exhaustiveness 対応
  throw lastErr
}
