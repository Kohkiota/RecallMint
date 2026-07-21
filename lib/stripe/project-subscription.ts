import 'server-only'
import type Stripe from 'stripe'
import { withTenantTx } from '@/lib/db/tenant-tx'
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

// 0 行 match (unlinked = 紐付く users 行なし) を表す SaveResult。RLS-P2 では tenant
// context を張れる内部 id が無い (userId=null) と saveProjection を発行できないため、
// DB を触らず「0 行 match」相当の結果を返して呼出側の unlinked 分岐に合流させる。
// Object.freeze: 参照共有される module-level の shared 定数ゆえ、 呼出側の偶発
// mutation を型 (SaveResult は mutable) の外側でも実行時に封じる (防御的不変性)。
const UNMATCHED_RESULT: SaveResult = Object.freeze({
  matched: false,
  clerkId: null,
  scheduledDowngradeScheduleId: null,
  scheduledTargetPriceId: null,
})

// Stripe subscription snapshot を users 行の plan slice へ射影する use-case
// (controller 層)。 純粋 domain (derivePlanFromStripe / projectStripeSnapshot) が
// 判断を担い、 本関数が infra 副作用 (anomaly notifyOps / DB 書込 / Clerk sync) を
// 束ねる唯一の境界。 domain aggregate/VO は infra を持ち込まないまま保つ。
//
// 挙動不変制約 (旧 resolvePlanFromSub + 各 write site verbatim):
//   - anomaly 通知は DB 書込前 (missing=priceId 含めない / unknown=priceId 含める)。
//   - RETURNING gate 付き Clerk sync: 行 match かつ clerkId 非 null のときのみ
//     (A-4 scrub 行 = matched・clerkId null は silent)。
//
// RLS-P2 (Task 7): DB 書込 (saveProjection) のみ withTenantTx で 1 tx に包み、tx 内に
// 外部 I/O を入れない (spec §0.2)。anomaly notifyOps は tx 前、Clerk sync は tx 後で
// 発火 (どちらも順序不変)。userId=null (resolve で紐付く行なし = unlinked) のときは
// context を張れないため DB を触らず UNMATCHED_RESULT を返す (0 行 match と等価)。
export async function projectStripeSubscription(
  userId: string | null, // resolve 済み内部 id (tenant context)。null = unlinked
  key: SubKey, // checkout=clerkId / created・updated=stripeCustomerId / upgrade=id
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

  // unlinked (紐付く行なし) は DB を触らず 0 行 match 相当を返す (Clerk sync も skip)。
  if (userId === null) return UNMATCHED_RESULT

  const update = projectStripeSnapshot(sub, { plan, billingInterval })
  const result = await withTenantTx(userId, (tx) => saveProjection(tx, key, update))

  // RETURNING gate 付き Clerk sync: 行 match かつ clerkId 非 null のときのみ。tx 外で
  // 発火 (外部 I/O)。0 行 match (race) / scrub 行 (clerkId null) は sync skip。
  if (result.matched && result.clerkId) {
    await syncClerkPublicMetadata({ clerkId: result.clerkId, plan })
  }
  return result
}
