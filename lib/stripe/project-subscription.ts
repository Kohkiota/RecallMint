import 'server-only'
import type Stripe from 'stripe'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import { resolveFromPriceId } from '@/lib/stripe/price-mapping'
import {
  derivePlanFromStripe,
  extractPriceId,
} from '@/lib/stripe/domain/subscription-values'
import { projectStripeSnapshot } from '@/lib/stripe/domain/subscription-aggregate'
import { saveProjection, type SubKey, type SaveResult } from '@/lib/stripe/subscription-repository'
import { notifyOps } from '@/lib/ops'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'
import { runtimeEnv } from '@/lib/env/runtime-env'

// Stripe subscription snapshot を users 行の plan slice へ射影する use-case
// (controller 層)。 純粋 domain (derivePlanFromStripe / projectStripeSnapshot) が
// 判断を担い、 本関数が infra 副作用 (anomaly notifyOps / DB 書込 / Clerk sync) を
// 束ねる唯一の境界。 domain aggregate/VO は infra を持ち込まないまま保つ。
//
// 挙動不変制約 (旧 resolvePlanFromSub + 各 write site verbatim):
//   - anomaly 通知は DB 書込前 (missing=priceId 含めない / unknown=priceId 含める)。
//   - RETURNING gate 付き Clerk sync: 行 match かつ clerkId 非 null のときのみ
//     (A-4 scrub 行 = matched・clerkId null は silent)。
export async function projectStripeSubscription(
  tx: DbExecutor,
  key: SubKey, // checkout=clerkId / created・updated=stripeCustomerId
  sub: Stripe.Subscription,
  ctx: { eventId: string; customerId: string },
): Promise<SaveResult> {
  const priceId = extractPriceId(sub)
  const { plan, billingInterval, anomaly } = derivePlanFromStripe(
    sub.status,
    priceId,
    resolveFromPriceId,
  )

  // anomaly 通知は DB 書込前 (旧 resolvePlanFromSub と同順序)。 missing は priceId を
  // 含めず、 unknown は priceId を含む (G2 + contract unknown golden が pin)。
  if (anomaly === 'missing_price') {
    await notifyOps('stripe sub missing price_id', {
      eventId: ctx.eventId,
      customerId: ctx.customerId,
      status: sub.status,
      environment: runtimeEnv(),
      timestamp: new Date().toISOString(),
    })
  } else if (anomaly === 'unknown_price') {
    await notifyOps('stripe sub unknown price_id', {
      eventId: ctx.eventId,
      customerId: ctx.customerId,
      status: sub.status,
      priceId,
      environment: runtimeEnv(),
      timestamp: new Date().toISOString(),
    })
  }

  const update = projectStripeSnapshot(sub, { plan, billingInterval })
  const result = await saveProjection(tx, key, update)

  // RETURNING gate 付き Clerk sync: 行 match かつ clerkId 非 null のときのみ。
  // 0 行 match (race) / scrub 行 (clerkId null) は sync skip。
  if (result.matched && result.clerkId) {
    await syncClerkPublicMetadata({ clerkId: result.clerkId, plan })
  }
  return result
}
