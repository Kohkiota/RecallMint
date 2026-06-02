// プラン変更判定の純粋ロジックと error 型。
// Stripe API 呼出は含まない (Task 3 の範囲)。
// rankPlan の算出は lib/plan-catalog.ts に委譲し、本 file は rank 数値のみ受け取る (DRY)。

import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// classifyChange
// ---------------------------------------------------------------------------
// 月→年は rank 増 = upgrade、年→月や tier 下げは rank 減 = downgrade。
// rank の出どころは lib/plan-catalog.ts の rankPlan(plan, interval)
// (free=0 / standard月=1 / standard年=2 / pro月=3 / pro年=4)。
// 呼出側が rankPlan で算出して渡すため、本関数は数値のみ扱う純関数。
export function classifyChange(
  currentRank: number,
  targetRank: number,
): 'upgrade' | 'downgrade' | 'same' {
  if (targetRank > currentRank) return 'upgrade'
  if (targetRank < currentRank) return 'downgrade'
  return 'same'
}

// ---------------------------------------------------------------------------
// getPendingState
// ---------------------------------------------------------------------------
// Stripe Subscription の保留・スケジュール・キャンセル状態を一度に取り出す。
// schedule は string id か展開済み object のどちらでも来うるため両対応。
export type PendingState = {
  hasPendingUpdate: boolean
  scheduleId: string | null
  cancelScheduled: boolean
}

export function getPendingState(sub: Stripe.Subscription): PendingState {
  const hasPendingUpdate = sub.pending_update != null

  // schedule は Stripe が展開していない場合は string id、展開済みの場合は object
  const scheduleId =
    (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id) ?? null

  // cancel_at は Unix timestamp (秒)、cancel_at_period_end は boolean
  const cancelScheduled = sub.cancel_at != null || sub.cancel_at_period_end === true

  return { hasPendingUpdate, scheduleId, cancelScheduled }
}

// ---------------------------------------------------------------------------
// error 型
// ---------------------------------------------------------------------------
// active subscription が 0 本 (新規契約前 / webhook 受信前の一時空窓 など)。
// Task 3/5 で subscriptions.list の結果を判定する際に throw される。
export class NoSubscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoSubscriptionError'
  }
}

// active subscription が複数、または保存 id と Stripe の実体が矛盾する場合。
// 同上、Task 3/5 で throw される。
export class AmbiguousSubscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousSubscriptionError'
  }
}
