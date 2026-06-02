// プラン変更判定の純粋ロジック / error 型 と、それを使う Stripe API 呼出関数群。
// rankPlan の算出は lib/plan-catalog.ts に委譲し、本 file は rank 数値のみ受け取る (DRY)。

import type Stripe from 'stripe'

import { stripe } from '@/lib/stripe'
import type { User } from '@/lib/db/schema'

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

// ---------------------------------------------------------------------------
// Stripe API 呼出関数群 (Task 3)
// ---------------------------------------------------------------------------

// 採用可能な subscription status。canceled / incomplete_expired などは in-place
// 変更の起点として不正なため除外し、AmbiguousSubscriptionError で弾く。
const RESOLVABLE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'active',
  'trialing',
  'past_due',
])

// sub.customer は SDK が展開していない場合 string id、展開済みは object で来うる。
function customerIdOf(customer: Stripe.Subscription['customer']): string {
  return typeof customer === 'string' ? customer : customer.id
}

/**
 * user の active subscription を解決し、変更対象の item id とともに返す。
 *
 * stripeSubscriptionId が有る通常経路では retrieve して status / customer 一致を
 * 検証する (DB と Stripe 実体の矛盾を早期に弾く)。id が無い clean slate の保険
 * fallback では list で 1 本に確定できる場合のみ採用し、0 本 / 複数本は自動選択せず
 * error にする (誤った subscription を触らないため)。
 */
export async function resolveActiveSubscription(
  user: Pick<User, 'stripeSubscriptionId' | 'stripeCustomerId'>,
): Promise<{ sub: Stripe.Subscription; itemId: string }> {
  if (user.stripeSubscriptionId) {
    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId)
    if (!RESOLVABLE_STATUSES.has(sub.status)) {
      throw new AmbiguousSubscriptionError(
        `subscription ${sub.id} status=${sub.status} is not resolvable`,
      )
    }
    if (customerIdOf(sub.customer) !== user.stripeCustomerId) {
      throw new AmbiguousSubscriptionError(
        `subscription ${sub.id} customer mismatch with user record`,
      )
    }
    const item = sub.items.data[0]
    if (!item) throw new AmbiguousSubscriptionError('subscription has no items: ' + sub.id)
    return { sub, itemId: item.id }
  }

  if (!user.stripeCustomerId) {
    throw new NoSubscriptionError('user has no stripeCustomerId')
  }

  const { data } = await stripe.subscriptions.list({
    customer: user.stripeCustomerId,
    status: 'active',
  })
  if (data.length === 0) {
    throw new NoSubscriptionError('no active subscription found for customer')
  }
  if (data.length > 1) {
    throw new AmbiguousSubscriptionError('multiple active subscriptions for customer')
  }
  const sub = data[0]
  const item = sub.items.data[0]
  if (!item) throw new AmbiguousSubscriptionError('subscription has no items: ' + sub.id)
  return { sub, itemId: item.id }
}

/**
 * 即時アップグレード。proration を即時請求し、支払成功時のみ新 price が反映される。
 * payment_behavior: 'pending_if_incomplete' により支払失敗時は pending_update に
 * 保持され旧 price が維持される (Stripe 挙動、Context7 で確認済)。
 */
export async function applyUpgrade(
  subId: string,
  itemId: string,
  targetPriceId: string,
  idempotencyKey: string,
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(
    subId,
    {
      items: [{ id: itemId, price: targetPriceId }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    },
    { idempotencyKey },
  )
}

/**
 * 期末ダウングレード。現請求期間は現 price を維持し、次期間から target price へ
 * proration なしで切り替える subscription schedule を作る。
 *
 * 防御注記: 既存 schedule / pending / cancel のブロックは呼出側 (Task 5、
 * getPendingState で事前判定) の責務。本関数は schedule 未存在を前提とし特別扱い
 * しない。
 *
 * idempotency: create と update で別 key (':create' / ':update' suffix) を使う。
 * 同一 key を別リクエストに使うと Stripe が前回レスポンスを replay してしまうため。
 */
export async function scheduleDowngrade(
  sub: Stripe.Subscription,
  targetPriceId: string,
  idempotencyKey: string,
): Promise<Stripe.SubscriptionSchedule> {
  const item = sub.items.data[0]
  if (!item) throw new AmbiguousSubscriptionError('subscription has no items: ' + sub.id)
  const currentPriceId = item.price.id

  // from_subscription は他 param を同時指定できないため、create と update を分ける。
  const schedule = await stripe.subscriptionSchedules.create(
    { from_subscription: sub.id },
    { idempotencyKey: idempotencyKey + ':create' },
  )

  // 現 phase は from_subscription 由来 phase[0] の請求期間を引き継ぐ。次 phase は
  // start_date 省略で前 phase の end_date に自動接続する。
  const currentPhase = schedule.phases[0]
  return stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: 'release',
      phases: [
        {
          // 現 price を維持するだけで金額変動がないため proration_behavior 不要。
          // proration は次 phase への切替時のみ 'none' を明示する。
          start_date: currentPhase.start_date,
          end_date: currentPhase.end_date,
          items: [{ price: currentPriceId, quantity: 1 }],
        },
        {
          items: [{ price: targetPriceId, quantity: 1 }],
          proration_behavior: 'none',
        },
      ],
    },
    { idempotencyKey: idempotencyKey + ':update' },
  )
}

/**
 * 予約済みダウングレードの取消。release で schedule を解除し現 price を継続させる。
 * subscriptionSchedules.cancel は subscription 自体を cancel しうるため使わない。
 */
export async function cancelScheduledDowngrade(
  scheduleId: string,
  idempotencyKey: string,
): Promise<Stripe.SubscriptionSchedule> {
  // release(id, params, options) — idempotencyKey は params ではなく options 側。
  return stripe.subscriptionSchedules.release(scheduleId, {}, { idempotencyKey })
}
