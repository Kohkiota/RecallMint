// error 型 と、それを使う Stripe API 呼出関数群。
// プラン変更判定の純粋ロジック (classifyChange / getPendingState / PendingState) は
// pure module lib/stripe/subscription-changes.ts へ抽出済 (P1)。呼出側はそちらを import する。
// rankPlan の算出は lib/plan-catalog.ts に委譲し、本 file は rank 数値のみ受け取る (DRY)。

import Stripe from 'stripe'

import { stripe } from '@/lib/stripe'
import type { User } from '@/lib/db/schema'
import { notifyOps } from '@/lib/ops'

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
  opts: { userId: string; operationId: string },
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
      // metadata は release gate (§6.4) の必須条件ではなく Stripe Dashboard 上で
      // この schedule を識別するためのデバッグ補助情報。gate の主役は DB の
      // scheduledDowngradeScheduleId 照合 (#1)。from_subscription の create は他
      // param を同時指定できないため metadata は update 側にのみ付与する。
      metadata: {
        kind: 'recallmint_downgrade',
        userId: opts.userId,
        targetPriceId,
        operationId: opts.operationId,
      },
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
 * subscription schedule の release を冪等に行う共通 helper。
 *
 * 位置づけ: releaseCompletedDowngrade の冪等性の**主判定は status gate** (同関数で
 * retrieve→status 分岐)。本 helper の message regex / resource_missing 握りは
 * retrieve〜release 呼出**間の race** (別処理が先に release/削除した) を吸収する
 * **保険**であって、正常系の主判定ではない。ユーザー取消 (cancelScheduledDowngrade)
 * では status gate を課さないため、こちらは本 helper を直接の冪等経路として使う。
 *
 * 「既に release/complete 済」や「schedule が消えている (resource_missing)」は
 * 「目的 (schedule が release 済) が既に達成された」状態なので throw せず正常
 * return とし、それ以外の error のみ rethrow する (§6.4.1)。
 *
 * release(id, params, options) — idempotencyKey は params ではなく options 側。
 */
async function releaseScheduleIdempotent(
  scheduleId: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    await stripe.subscriptionSchedules.release(scheduleId, {}, { idempotencyKey })
  } catch (err) {
    if (isAlreadyReleasedOrMissing(err)) return
    throw err
  }
}

// 「既に release/complete 済」「schedule not found」を冪等成功として握る判定。
// resource_missing は削除済 schedule、message の already released/completed は
// 終端状態の schedule への再 release を表す (Stripe はこれらを 400 で返す)。
function isAlreadyReleasedOrMissing(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false
  if (err.code === 'resource_missing') return true
  const msg = err.message ?? ''
  return /already\s+(been\s+)?(released|completed)/i.test(msg)
}

/**
 * 予約済みダウングレードの取消 (期末発効**前**、ユーザー操作)。release で schedule を
 * 解除し現 price を継続させる。subscriptionSchedules.cancel は subscription 自体を
 * cancel しうるため使わない。冪等成功扱いは releaseScheduleIdempotent に委譲。
 */
export async function cancelScheduledDowngrade(
  scheduleId: string,
  idempotencyKey: string,
): Promise<void> {
  await releaseScheduleIdempotent(scheduleId, idempotencyKey)
}

/**
 * 切替**発効後**の能動 release (方針C, §6.4 / §4.4)。schedule の end_behavior は
 * 'release' だが、確実に通常 subscription へ戻すため webhook gate から能動的に
 * release する。gate は複数の .updated で繰り返し評価されうるため冪等性が要件。
 *
 * 冪等性の位置づけ (§4.4):
 * - **主判定 = status gate**: release 前に retrieve し schedule.status で分岐する。
 *   release 可能な status は `active` / `not_started` のみ (公式)。2 回目以降は
 *   status が `released`/`completed` になっているため 'already_terminal' no-op に
 *   落ち、release の副作用は 1 回分に収束する。
 * - **短期 retry = idempotencyKey** (`autorelease:{scheduleId}`): ~24h で prune
 *   されうるため永続的二重防止には使えない。短期 retry の重複吸収のみ。
 * - **保険 = releaseScheduleIdempotent 内の message regex + resource_missing**:
 *   retrieve〜release 呼出間の race 吸収のみ。正常系の主判定ではない。
 *
 * 戻り値:
 * - 'released': active かつ current_phase 非 null で release を実行 (or race 保険で
 *   既 release を吸収) した。
 * - 'already_terminal': completed/released/canceled = 既に外れている (release せず)。
 * - 'skipped': not_started (切替前で予約維持) / active だが current_phase null
 *   (異常、notifyOps 後 release せず)。
 */
export async function releaseCompletedDowngrade(
  scheduleId: string,
  idempotencyKey: string,
): Promise<'released' | 'already_terminal' | 'skipped'> {
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)

  switch (schedule.status) {
    case 'active': {
      // current_phase は active 時のみ存在 (nullable)。null は異常状態のため
      // 誤って release せず ops に通知して skip (予約を消さない安全側)。
      if (schedule.current_phase == null) {
        await notifyOps('autorelease: schedule active but current_phase null', {
          scheduleId,
          status: schedule.status,
          environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
          timestamp: new Date().toISOString(),
        })
        return 'skipped'
      }
      // release + race 保険 (regex/resource_missing) は helper に委譲。
      await releaseScheduleIdempotent(scheduleId, idempotencyKey)
      return 'released'
    }
    case 'completed':
    case 'released':
    case 'canceled':
      // 既に autorelease 対象外。release を呼ばず no-op 成功扱い。
      return 'already_terminal'
    case 'not_started':
      // 切替前の予約。誤消去しないよう release せず維持。
      return 'skipped'
    default:
      // status は上記 5 値で網羅だが、SDK の将来追加に備え安全側 (release しない)。
      return 'skipped'
  }
}
