// Subscription value objects (pure). Stripe I/O・notifyOps・DB からは切り離した
// 純粋 domain module。 runtime import ゼロ (許可は `import type` のみ) — price 解決は
// 引数注入 (derivePlanFromStripe の resolvePrice) で受け、 anomaly 検出時も notifyOps は
// 呼ばず anomaly 値を返すだけ (副作用は呼出側 = controller の責務)。
//
// 挙動不変制約: 元の handle-stripe-event.ts / subscription-changes.ts の分岐順序・
// mapping を verbatim 保存する (F1 golden G1-G7 が pin)。

import type Stripe from 'stripe'
import type { Plan } from '@/lib/auth/plan-limits'

// Stripe.Subscription.Status (10 種) → 内部 subscriptionStatus (3 種) への純粋
// マッピング。 plan / billingInterval は本関数では扱わない (price_id 解決と
// 分離するため)。
export function normalizeSubStatus(
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

// status × price_id から (plan, billingInterval) を決定する純粋 core。
// 「課金 active 系 (active/trialing/past_due) なら price_id から plan + interval、
// それ以外 (unpaid/incomplete/canceled/incomplete_expired/paused) は free + NULL」
// を表現する。
//
// price 解決は resolvePrice に注入 (本 module は price-mapping を値 import しない)。
// 不明 / 欠落 price_id は anomaly を返すのみ (notifyOps は呼出側が anomaly を見て発火)。
//
// 注: 'past_due' は plan を維持する設計 (初回支払失敗 retry 期間中はユーザー
// アクセスを保持、 'unpaid' = max retry 後にようやく downgrade)。
//
// 分岐順序を verbatim 保存 (canceled 判定 → unpaid/incomplete → !priceId → mapping null
// → mapping 有)。
export function derivePlanFromStripe(
  status: Stripe.Subscription.Status,
  priceId: string | null,
  resolvePrice: (priceId: string) => { plan: Plan; interval: 'month' | 'year' } | null,
): {
  plan: Plan
  billingInterval: 'month' | 'year' | null
  anomaly: null | 'missing_price' | 'unknown_price'
} {
  const sub = normalizeSubStatus(status)
  // canceled 相当 (canceled / incomplete_expired / paused) は plan=free 確定
  if (sub === 'canceled') {
    return { plan: 'free', billingInterval: null, anomaly: null }
  }
  // unpaid / incomplete は past_due に正規化されるが downgrade 対象。
  // 元の status をもう一度見て判定 (normalizeSubStatus の単純化を維持するため
  // ここで再分岐)。
  if (status === 'unpaid' || status === 'incomplete') {
    return { plan: 'free', billingInterval: null, anomaly: null }
  }
  // active / trialing / past_due: price_id から plan + interval を解決
  if (!priceId) {
    return { plan: 'free', billingInterval: null, anomaly: 'missing_price' }
  }
  const mapping = resolvePrice(priceId)
  if (!mapping) {
    return { plan: 'free', billingInterval: null, anomaly: 'unknown_price' }
  }
  return { plan: mapping.plan, billingInterval: mapping.interval, anomaly: null }
}

// scheduled downgrade (予約) の値。 後続 task で使用。
export type ScheduledChange = {
  scheduleId: string
  targetPriceId: string
  effectiveAt: Date
} | null

// cancel 予約の合成 predicate。 cancel_at は Unix timestamp (秒)、
// cancel_at_period_end は boolean — どちらかが立てば cancel 予約中。
export function isCancelScheduled(sub: Stripe.Subscription): boolean {
  return sub.cancel_at != null || sub.cancel_at_period_end === true
}
