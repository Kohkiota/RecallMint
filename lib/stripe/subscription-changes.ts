// プラン変更判定の純粋ロジック。Stripe API I/O からは切り離した pure module。
// rankPlan の算出は lib/plan-catalog.ts に委譲し、本 file は rank 数値のみ受け取る (DRY)。
// Stripe 型は import type のみ、値 import は cancel predicate VO
// (isCancelScheduled — 純粋 VO、実行時に Stripe を引かない) のみ。

import type Stripe from 'stripe'
import { isCancelScheduled } from '@/lib/stripe/domain/subscription-values'

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

  // cancel 予約の合成 predicate は VO (isCancelScheduled) に一本化 (I-7)。
  const cancelScheduled = isCancelScheduled(sub)

  return { hasPendingUpdate, scheduleId, cancelScheduled }
}
