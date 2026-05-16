import type Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { stripe } from '@/lib/stripe'
import { getDb } from '@/lib/db'
import { users, stripeEvents } from '@/lib/db/schema'
import type { Plan } from '@/lib/auth/plan-limits'
import { logger } from '@/lib/logger'
import { notifyWebhookError } from '@/lib/ops'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    // Local dev tolerance (mirrors Clerk webhook pattern)
    if (process.env.NODE_ENV === 'production') {
      logger.error({ event: 'webhook.stripe.misconfig', secret: 'STRIPE_WEBHOOK_SECRET' })
      return new Response('misconfigured', { status: 500 })
    }
    return new Response('STRIPE_WEBHOOK_SECRET not set', { status: 200 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) return new Response('missing stripe-signature', { status: 400 })

  const body = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret)
  } catch (err) {
    logger.error({ event: 'webhook.stripe.bad_signature', err })
    return new Response('invalid signature', { status: 400 })
  }

  const db = getDb()

  // Idempotency: INSERT event_id with ON CONFLICT DO NOTHING RETURNING.
  // If RETURNING is empty, event was already processed → skip.
  const inserted = await db
    .insert(stripeEvents)
    .values({ eventId: event.id, type: event.type })
    .onConflictDoNothing({ target: stripeEvents.eventId })
    .returning({ id: stripeEvents.eventId })
  if (inserted.length === 0) {
    return new Response('duplicate', { status: 200 })
  }

  try {
    await handleEvent(event)
    return new Response('ok', { status: 200 })
  } catch (err) {
    // Spec §1: outer catch で notifyWebhookError 発火 (Phase 1 E-3 で missing call 補填)。
    // CLAUDE.md §Stripe-5 維持: エラー時も 200 を返し Stripe 再送ループを防ぐ。
    // recovery は OT 手動 (Discord 通知 → Vercel logs / DB 確認)。
    await notifyWebhookError({
      handler: 'stripe',
      eventId: event.id,
      eventType: event.type,
      err,
      customerId: extractCustomerId(event),
    })
    return new Response('handler error swallowed', { status: 200 })
  }
}

// 失敗時 notify の context 拡充用。event.data.object.customer を best-effort で
// 取り出す (event 種別によっては customer 不在、その場合 undefined → notify payload
// から省略される)。throw しない (notify path は handler を巻き込んではならない)。
function extractCustomerId(event: Stripe.Event): string | undefined {
  const obj = (event.data as { object?: unknown } | null | undefined)?.object
  if (!obj || typeof obj !== 'object') return undefined
  const customer = (obj as { customer?: unknown }).customer
  if (typeof customer === 'string') return customer
  if (customer && typeof customer === 'object' && 'id' in customer) {
    const id = (customer as { id?: unknown }).id
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}

// TODO(post-A-3.2): Standard plan 導入時に 'standard' 戻り値も追加。
// STRIPE_PRICE_STANDARD_* に対応する subscription を sub.items.data[].price.id
// で判定し 'standard' にマッピング。 現状は STRIPE_PRICE_PRO_* のみなので戻り値は
// 実質 'free' | 'pro' の subset に narrowing しておく (Plan 型を拡張しても本関数の
// 抜けに気付けるよう、 戻り値型を Extract で固定)。
function normalizeSubStatus(s: Stripe.Subscription.Status): {
  plan: Extract<Plan, 'free' | 'pro'>
  subscriptionStatus: 'active' | 'past_due' | 'canceled'
} {
  switch (s) {
    case 'active':
    case 'trialing':
      return { plan: 'pro', subscriptionStatus: 'active' }
    case 'past_due':
      return { plan: 'pro', subscriptionStatus: 'past_due' }
    case 'unpaid':
      return { plan: 'free', subscriptionStatus: 'past_due' }
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return { plan: 'free', subscriptionStatus: 'canceled' }
    case 'incomplete':
      return { plan: 'free', subscriptionStatus: 'past_due' }
    default:
      return { plan: 'free', subscriptionStatus: 'canceled' }
  }
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  const db = getDb()
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session
      const clerkId = s.client_reference_id
      const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id
      if (!clerkId || !customerId) return

      // Step 1: link customer to user (existing behavior)
      await db
        .update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.clerkId, clerkId))

      // Step 2 (Fix 3, Sprint 6.2 I-2 race defense): Stripe の webhook delivery は
      // 順序保証されないため、subscription.created が先に到達していると
      // stripe_customer_id 未設定で update が 0 行 match し、ユーザーが
      // 課金完了しても Free のまま取り残される。checkout.session.completed
      // 時点で session.subscription から直接 sub を fetch して plan/status を
      // 同期しておく。subscription.created/updated 側は冪等なので後着しても
      // 問題なし (後勝ち同じ値で上書き)。
      const subRef = s.subscription
      if (subRef) {
        const subId = typeof subRef === 'string' ? subRef : subRef.id
        const sub = await stripe.subscriptions.retrieve(subId)
        const norm = normalizeSubStatus(sub.status)
        // API 2025-03-31.basil 以降は items.data[].current_period_end に移動
        const itemPeriodEnd = sub.items.data[0]?.current_period_end
        const periodEnd =
          typeof itemPeriodEnd === 'number' ? new Date(itemPeriodEnd * 1000) : null
        const cancelAt =
          typeof sub.cancel_at === 'number' ? new Date(sub.cancel_at * 1000) : null
        await db
          .update(users)
          .set({
            plan: norm.plan,
            subscriptionStatus: norm.subscriptionStatus,
            currentPeriodEnd: periodEnd,
            cancelAt,
          })
          .where(eq(users.clerkId, clerkId))
      }
      return
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      const norm = normalizeSubStatus(sub.status)
      // API 2025-03-31.basil 以降は items.data[].current_period_end に移動
      const itemPeriodEnd = sub.items.data[0]?.current_period_end
      const periodEnd =
        typeof itemPeriodEnd === 'number' ? new Date(itemPeriodEnd * 1000) : null
      const cancelAt =
        typeof sub.cancel_at === 'number' ? new Date(sub.cancel_at * 1000) : null
      await db
        .update(users)
        .set({
          plan: norm.plan,
          subscriptionStatus: norm.subscriptionStatus,
          currentPeriodEnd: periodEnd,
          cancelAt,
        })
        .where(eq(users.stripeCustomerId, customerId))
      return
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      // subscription 削除時: plan/status をリセット、cancelAt をクリア。
      // currentPeriodEnd は billing 履歴の記録として残す (touch しない)。
      // cancelAtPeriodEnd は schema 廃止済み (cancel_at != null で解約予約判定)。
      await db
        .update(users)
        .set({
          plan: 'free',
          subscriptionStatus: 'canceled',
          cancelAt: null,
        })
        .where(eq(users.stripeCustomerId, customerId))
      return
    }
    default:
      // Unknown event — no-op. Caller still returns 200.
      return
  }
}
