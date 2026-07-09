// Subscription aggregate (純粋 domain)。 users 行の subscription slice への
// 書込値を Stripe snapshot / VO から組み立てる純関数群。 runtime import ゼロ
// (許可は `import type` のみ) — drizzle / db / ops / next の値 import 禁止。
//
// 責務分担:
//   - plan / billingInterval の解決 (price_id → plan) は use-case 側 (controller)
//     が derivePlanFromStripe で算出し derived として渡す。 aggregate はローカル
//     計算した plan を Stripe に逆流させない (ProjectionUpdate が Stripe オブジェクト
//     必須 = 唯一の書込入口、判断3)。
//   - status / periodEnd / cancelAt / subId の抽出・整形は aggregate が担う。
//
// 挙動不変制約: handle-stripe-event.ts の extractSubFields (period/cancel) /
// normalizeSubStatus 経路と verbatim (F1 golden が pin)。 period/cancel 抽出が
// extractSubFields と 2 箇所になるのは許容 (配線 task で整理判断)。

import type Stripe from 'stripe'
import type { Plan } from '@/lib/auth/plan-limits'
import type { PendingState } from '@/lib/stripe/subscription-changes'
import type { ScheduledChange } from './subscription-values'
import { normalizeSubStatus } from './subscription-values'

// plan 6 列の射影。 唯一の書込入口 (判断3): Stripe オブジェクト必須で
// ローカル計算値の逆流を型で禁止する。
export type ProjectionUpdate = {
  plan: Plan
  billingInterval: 'month' | 'year' | null
  subscriptionStatus: 'active' | 'past_due' | 'canceled'
  currentPeriodEnd: Date | null
  cancelAt: Date | null
  stripeSubscriptionId: string
}

// sub から status / periodEnd / cancelAt / subId を抽出し、 derived の plan /
// billingInterval と合わせて ProjectionUpdate を組む。 period/cancel 抽出は
// extractSubFields (handle-stripe-event.ts) と同ロジックを inline で保持する。
export function projectStripeSnapshot(
  sub: Stripe.Subscription,
  derived: { plan: Plan; billingInterval: 'month' | 'year' | null },
): ProjectionUpdate {
  const item = sub.items.data[0]
  const itemPeriodEnd = item?.current_period_end
  const currentPeriodEnd =
    typeof itemPeriodEnd === 'number' ? new Date(itemPeriodEnd * 1000) : null
  const cancelAt =
    typeof sub.cancel_at === 'number' ? new Date(sub.cancel_at * 1000) : null
  return {
    plan: derived.plan,
    billingInterval: derived.billingInterval,
    subscriptionStatus: normalizeSubStatus(sub.status),
    currentPeriodEnd,
    cancelAt,
    stripeSubscriptionId: sub.id,
  }
}

// customer.subscription.deleted の reset。 currentPeriodEnd は含めない
// (現行は billing 履歴として保持し touch しない)。
export type DeletedReset = {
  plan: 'free'
  billingInterval: null
  subscriptionStatus: 'canceled'
  cancelAt: null
  stripeSubscriptionId: null
  scheduledDowngradeScheduleId: null
  scheduledTargetPriceId: null
  scheduledChangeEffectiveAt: null
}

export function applyDeleted(): DeletedReset {
  return {
    plan: 'free',
    billingInterval: null,
    subscriptionStatus: 'canceled',
    cancelAt: null,
    stripeSubscriptionId: null,
    scheduledDowngradeScheduleId: null,
    scheduledTargetPriceId: null,
    scheduledChangeEffectiveAt: null,
  }
}

// 予約 3 列 (I-9 atomicity: 常に 3 列一括 set/clear。 個別列 update を作らない)。
export type ReservationUpdate = {
  scheduledDowngradeScheduleId: string | null
  scheduledTargetPriceId: string | null
  scheduledChangeEffectiveAt: Date | null
}

export function reserveDowngrade(change: NonNullable<ScheduledChange>): ReservationUpdate {
  return {
    scheduledDowngradeScheduleId: change.scheduleId,
    scheduledTargetPriceId: change.targetPriceId,
    scheduledChangeEffectiveAt: change.effectiveAt,
  }
}

export function clearReservation(): ReservationUpdate {
  return {
    scheduledDowngradeScheduleId: null,
    scheduledTargetPriceId: null,
    scheduledChangeEffectiveAt: null,
  }
}

// I-6 gating (DB 列 = 真実 source)。 block 条件 = actions.ts:110-116 の OR 3 条件
// verbatim: hasPendingUpdate || dbScheduleId != null || cancelScheduled。
export function canChangePlan(
  pending: PendingState,
  dbScheduleId: string | null,
): { ok: true } | { ok: false; reason: 'CHANGE_BLOCKED' } {
  if (pending.hasPendingUpdate || dbScheduleId != null || pending.cancelScheduled) {
    return { ok: false, reason: 'CHANGE_BLOCKED' }
  }
  return { ok: true }
}

// I-8 release gate 判定 (pure・副作用なし)。 予約が存在する (dbScheduleId != null)
// 時のみ呼ぶ前提。 判定順は evaluateReleaseGate (handle-stripe-event.ts:334-403)
// verbatim:
//   subScheduleId == null           → 'clear_direct' (方向2 保険)
//   subScheduleId !== dbScheduleId  → 'mismatch'     (OT 介入・書かない)
//   priceId !== dbTargetPriceId     → 'skip'         (予約維持)
//   else                            → 'delegate'     (releaseCompletedDowngrade 委譲)
export function evaluateRelease(args: {
  subScheduleId: string | null
  dbScheduleId: string
  priceId: string | null
  dbTargetPriceId: string | null
}): 'clear_direct' | 'mismatch' | 'skip' | 'delegate' {
  const { subScheduleId, dbScheduleId, priceId, dbTargetPriceId } = args
  if (subScheduleId == null) return 'clear_direct'
  if (subScheduleId !== dbScheduleId) return 'mismatch'
  if (priceId !== dbTargetPriceId) return 'skip'
  return 'delegate'
}
