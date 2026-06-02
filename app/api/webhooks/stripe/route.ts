import type Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { stripe } from '@/lib/stripe'
import { getDb } from '@/lib/db'
import { users, stripeEvents } from '@/lib/db/schema'
import type { Plan } from '@/lib/auth/plan-limits'
import { resolveFromPriceId } from '@/lib/stripe/price-mapping'
import { logger } from '@/lib/logger'
import { notifyOps, notifyWebhookError } from '@/lib/ops'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'

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

// Stripe.Subscription.Status (10 種) → 内部 subscriptionStatus (3 種) への純粋
// マッピング。 plan / billingInterval は本関数では扱わない (price_id 解決と
// 分離するため)。
function normalizeSubStatus(
  s: Stripe.Subscription.Status,
): 'active' | 'past_due' | 'canceled' {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due'
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled'
    default:
      return 'canceled'
  }
}

// status × price_id から (plan, billingInterval) を決定する一段高い resolver。
// 「課金 active 系 (active/trialing/past_due) なら price_id から plan + interval、
// それ以外 (unpaid/incomplete/canceled/incomplete_expired/paused) は free + NULL」
// を表現する。
//
// 不明 price_id (env 設定漏れ / Stripe Dashboard 不一致) は notifyOps + free
// fallback。 throw しない (Stripe 再送ループを起こさず、 OT 観測性のみ確保)。
//
// 注: 'past_due' は plan を維持する設計 (初回支払失敗 retry 期間中はユーザー
// アクセスを保持、 'unpaid' = max retry 後にようやく downgrade)。 Sprint A-3.2
// 以前の normalizeSubStatus 既存 mapping を踏襲。
async function resolvePlanFromSub(
  status: Stripe.Subscription.Status,
  priceId: string | null,
  ctx: { eventId: string; customerId: string },
): Promise<{ plan: Plan; billingInterval: 'month' | 'year' | null }> {
  const sub = normalizeSubStatus(status)
  // canceled 相当 (canceled / incomplete_expired / paused) は plan=free 確定
  if (sub === 'canceled') {
    return { plan: 'free', billingInterval: null }
  }
  // unpaid / incomplete は past_due に正規化されるが downgrade 対象。
  // (active/trialing/past_due のうち unpaid/incomplete だけは plan='free')。
  // 元の status をもう一度見て判定 (normalizeSubStatus の単純化を維持するため
  // ここで再分岐)。
  if (status === 'unpaid' || status === 'incomplete') {
    return { plan: 'free', billingInterval: null }
  }
  // active / trialing / past_due: price_id から plan + interval を解決
  if (!priceId) {
    await notifyOps('stripe sub missing price_id', {
      ...ctx,
      status,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    return { plan: 'free', billingInterval: null }
  }
  const mapping = resolveFromPriceId(priceId)
  if (!mapping) {
    await notifyOps('stripe sub unknown price_id', {
      ...ctx,
      status,
      priceId,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    return { plan: 'free', billingInterval: null }
  }
  return { plan: mapping.plan, billingInterval: mapping.interval }
}

// subscription object から price_id / current_period_end / cancel_at を取り出す
// 共通 helper。 API 2025-03-31.basil 以降は items.data[].current_period_end に
// 移動している点に注意。
function extractSubFields(sub: Stripe.Subscription): {
  priceId: string | null
  periodEnd: Date | null
  cancelAt: Date | null
} {
  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const itemPeriodEnd = item?.current_period_end
  const periodEnd =
    typeof itemPeriodEnd === 'number' ? new Date(itemPeriodEnd * 1000) : null
  const cancelAt =
    typeof sub.cancel_at === 'number' ? new Date(sub.cancel_at * 1000) : null
  return { priceId, periodEnd, cancelAt }
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  const db = getDb()
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session
      const clerkId = s.client_reference_id
      const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id
      if (!clerkId || !customerId) return

      // Step 1: link customer to user (既存挙動)
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
        // retrieve() が throw した場合 (Stripe 5xx / timeout)、 outer try に
        // 流れて notifyWebhookError + 200 で完結する。 customerId link は
        // Step 1 で既に成功しているので、 plan/status の同期は次に届く
        // customer.subscription.created/.updated webhook で recover される
        // (両 path とも独立 idempotent、 race defense の degraded mode)。
        const sub = await stripe.subscriptions.retrieve(subId)
        const { priceId, periodEnd, cancelAt } = extractSubFields(sub)
        const { plan, billingInterval } = await resolvePlanFromSub(sub.status, priceId, {
          eventId: event.id,
          customerId,
        })
        // RETURNING で UPDATE matched 行数を判定する。 user.created webhook が
        // checkout.session.completed より遅延した race では Step 1 link で
        // 0 行 match → Step 2 でも 0 行 match。 この場合 Clerk publicMetadata
        // を fire させない (= user.created 後着で plan='free' で clobber され、
        // 結果的に "Clerk=standard / DB=free" の整合崩壊を防ぐ)。
        const updated = await db
          .update(users)
          .set({
            plan,
            billingInterval,
            subscriptionStatus: normalizeSubStatus(sub.status),
            currentPeriodEnd: periodEnd,
            cancelAt,
            stripeSubscriptionId: sub.id,
          })
          .where(eq(users.clerkId, clerkId))
          .returning({ clerkId: users.clerkId })
        if (updated?.[0]?.clerkId) {
          await syncClerkPublicMetadata({ clerkId, plan })
        }
      }
      return
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      const { priceId, periodEnd, cancelAt } = extractSubFields(sub)
      const { plan, billingInterval } = await resolvePlanFromSub(sub.status, priceId, {
        eventId: event.id,
        customerId,
      })
      // RETURNING で clerkId を取得し、 続けて Clerk publicMetadata sync。
      // UPDATE が 0 行 match (= checkout.session.completed が先着していない race)
      // のときは returning 空 → metadata sync skip。
      const updated = await db
        .update(users)
        .set({
          plan,
          billingInterval,
          subscriptionStatus: normalizeSubStatus(sub.status),
          currentPeriodEnd: periodEnd,
          cancelAt,
          stripeSubscriptionId: sub.id,
        })
        .where(eq(users.stripeCustomerId, customerId))
        .returning({ clerkId: users.clerkId })
      const clerkId = updated?.[0]?.clerkId
      if (clerkId) {
        await syncClerkPublicMetadata({ clerkId, plan })
      } else if (event.type === 'customer.subscription.updated') {
        // .created の unlinked race は checkout.session.completed が後追いで救済
        // するため alert 不要 (新規 sign-up の自然な ordering)。 .updated で
        // unlinked は user operation 由来 (Portal 経由 plan 変更等) で stripeCustomerId
        // 紐付き欠落 = OT 介入対象の anomaly なので notifyOps する。
        await notifyOps('stripe sub event for unlinked customer', {
          eventId: event.id,
          customerId,
          eventType: event.type,
          environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
          timestamp: new Date().toISOString(),
        })
      }
      return
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
      // subscription 削除時: plan/status/billingInterval をリセット、cancelAt を
      // クリア。 currentPeriodEnd は billing 履歴の記録として残す (touch しない)。
      // cancelAtPeriodEnd は schema 廃止済み (cancel_at != null で解約予約判定)。
      const updated = await db
        .update(users)
        .set({
          plan: 'free',
          billingInterval: null,
          subscriptionStatus: 'canceled',
          cancelAt: null,
          stripeSubscriptionId: null,
        })
        .where(eq(users.stripeCustomerId, customerId))
        .returning({ clerkId: users.clerkId })
      const clerkId = updated?.[0]?.clerkId
      if (clerkId) {
        await syncClerkPublicMetadata({ clerkId, plan: 'free' })
      } else {
        // .deleted で unlinked は subscription を解約された user の row が消えて
        // いるなど整合崩壊 = OT 介入対象。 .created と違い recover の経路がない。
        await notifyOps('stripe sub event for unlinked customer', {
          eventId: event.id,
          customerId,
          eventType: event.type,
          environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
          timestamp: new Date().toISOString(),
        })
      }
      return
    }
    case 'invoice.payment_failed': {
      // DB の plan/status は変更しない: plan/status は customer.subscription.updated
      // が最終正。upgrade 即時課金失敗時は subscription が pending_update のまま旧
      // price を維持するので、DB 据え置きで Stripe 側 actual current price と整合する。
      const customerId = extractCustomerId(event)
      await notifyOps('stripe invoice.payment_failed', {
        eventId: event.id,
        customerId,
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
        timestamp: new Date().toISOString(),
      })
      return
    }
    default:
      // Unknown event — no-op. Caller still returns 200.
      return
  }
}
