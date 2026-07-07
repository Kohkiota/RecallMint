import type Stripe from 'stripe'
import { stripe } from '@/lib/stripe/client'
import { getDb } from '@/lib/db'
import { stripeEvents } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { notifyWebhookError } from '@/lib/ops'
import { requireWebhookSecret } from '@/lib/env/webhook-secret-gate'
import { handleEvent, extractCustomerId } from '@/lib/stripe/handle-stripe-event'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // T-A8 (audit §10.3 (b) #17): 3-tier env-aware gate に統一。
  // production = env 必須 (helper throw → Next.js 500、 既存 wire format と一致)、
  // preview = logger.warn + '' fallback (既存 stripe.webhooks.constructEvent が
  // 空文字 secret で fail → 400 invalid signature)、 local / dev = silent ''
  // (同上、 400)。 clerk webhook route と同 pattern (T-A8 helper 経由化)。
  const secret = requireWebhookSecret('STRIPE_WEBHOOK_SECRET', 'Stripe webhook')

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

