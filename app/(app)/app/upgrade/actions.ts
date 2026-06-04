'use server'

import { redirect } from 'next/navigation'
import { stripe } from '@/lib/stripe'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { users, type User } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { rankPlan } from '@/lib/plan-catalog'
import { notifyOps } from '@/lib/ops'
import {
  classifyChange,
  getPendingState,
  resolveActiveSubscription,
  applyUpgrade,
  scheduleDowngrade,
  cancelScheduledDowngrade,
  NoSubscriptionError,
  AmbiguousSubscriptionError,
} from '@/lib/stripe/subscription'
import { priceIdFor, type PaidPlan, type BillingInterval } from '@/lib/stripe/price-mapping'

// 4 種類 (Standard×month/year × Pro×month/year) すべての Checkout 起動に対応。
// 旧 createCheckoutSession (Pro monthly hardcode) は廃止、 form action から
// hidden input で plan + interval を受け取る pattern に統一。
export async function createCheckoutSession(formData: FormData): Promise<void> {
  const user = await getCurrentUser()
  if (!user) {
    // webhook race: DB row not yet synced. Throw with stable code so the
    // caller's error boundary surfaces (the `<form>` action path has no
    // ActionResult channel since this function ends in redirect()).
    throw new Error('USER_NOT_SYNCED')
  }

  const plan = formData.get('plan')
  const interval = formData.get('interval')
  if (plan !== 'standard' && plan !== 'pro') {
    throw new Error(`Invalid plan: ${String(plan)}`)
  }
  if (interval !== 'month' && interval !== 'year') {
    throw new Error(`Invalid interval: ${String(interval)}`)
  }

  // priceIdFor は env 起点で fail-fast 検証済 (lib/stripe/price-mapping.ts)、
  // 4 cell exhaustive なので runtime throw は到達しない想定。
  const priceId = priceIdFor(plan as PaidPlan, interval as BillingInterval)

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    // user.clerkId / user.email は GDPR PII scrub で nullable 化された
    // (`lib/db/schema.ts` users)。 active な user (このルートに到達する) では
    // 必ず非 null だが、 Stripe SDK signature が `string | undefined` を要求する
    // ため null → undefined に narrow する。
    client_reference_id: user.clerkId ?? undefined,
    // If the user already has a Stripe customer ID (e.g., from a prior upgrade
    // attempt or a cancelled sub), reuse it. Otherwise let Stripe create one
    // from the email on Checkout.
    customer: user.stripeCustomerId ?? undefined,
    customer_email: user.stripeCustomerId ? undefined : (user.email ?? undefined),
    // R1: 成功 banner の entry を ?billing=new に統合 (旧 ?checkout=success を廃止)。
    success_url: `${base}/app?billing=new`,
    cancel_url: `${base}/app/upgrade`,
  })

  if (!session.url) throw new Error('Stripe Checkout session has no url')
  redirect(session.url)
}

// 既存契約者 (paid) のプラン変更を Checkout を介さず in-place で行う。free user の
// 新規契約は createCheckoutSession 経路のまま (本 action は対象外)。
// upgrade は即時課金 (applyUpgrade)、downgrade は期末予約 (scheduleDowngrade) に
// orchestrate する。Stripe 直接呼出は持たず、判定 / API は Task 2/3 の関数経由。
export async function changePlan(formData: FormData): Promise<void> {
  const user = await getCurrentUser()
  if (!user) {
    // webhook race: DB row not yet synced。createCheckoutSession と同じ stable code。
    throw new Error('USER_NOT_SYNCED')
  }

  const plan = formData.get('plan')
  const interval = formData.get('interval')
  if (plan !== 'standard' && plan !== 'pro') {
    throw new Error(`Invalid plan: ${String(plan)}`)
  }
  if (interval !== 'month' && interval !== 'year') {
    throw new Error(`Invalid interval: ${String(interval)}`)
  }

  // operationId は 1 回の confirm/submit ごとに client 生成する UUID (§5.4)。
  // idempotency key の操作単位識別子であり、未送信は呼出元の bug なので弾く。
  const operationId = formData.get('operationId')
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new Error('MISSING_OPERATION_ID')
  }

  // resolve の失敗 (0 本 / 複数 / 矛盾) は自動で 1 本選ばず、観測のため notifyOps し
  // 汎用エラーで停止する (§8)。try/catch は resolve に限定し、後段の redirect
  // (内部で throw する) を握り潰さないようにする。
  const resolved = await resolveActiveSubscriptionOrNotify(user)
  const { sub, itemId } = resolved

  // 二重 submit / 同時変更 / 解約予約中は受け付けない (§5.5)。
  // ダウングレード予約中かどうかは DB 列 (scheduledDowngradeScheduleId) で判定する。
  // sub.schedule (pending.scheduleId) 単独をブロック条件にしてはいけない — DB 列が
  // 真実 source で、Stripe schedule が存在しても DB 列が null なら続行する。
  const pending = getPendingState(sub)
  if (
    pending.hasPendingUpdate ||
    user.scheduledDowngradeScheduleId != null ||
    pending.cancelScheduled
  ) {
    throw new Error('CHANGE_BLOCKED')
  }

  const currentRank = rankPlan(user.plan, user.billingInterval)
  const targetRank = rankPlan(plan, interval)
  const direction = classifyChange(currentRank, targetRank)
  if (direction === 'same') {
    // UI が現プランを選択不可にする前提の防御。
    throw new Error('NO_CHANGE')
  }

  const targetPriceId = priceIdFor(plan as PaidPlan, interval as BillingInterval)
  // deterministic key (subId+price) は使わない (§5.4)。operation 単位 UUID で一意化。
  const idempotencyKey = `changePlan:${user.id}:${operationId}`

  if (direction === 'upgrade') {
    await applyUpgrade(sub.id, itemId, targetPriceId, idempotencyKey)
    redirect('/app?billing=upgrade')
  } else {
    const schedule = await scheduleDowngrade(sub, targetPriceId, idempotencyKey, {
      userId: user.id,
      operationId,
    })
    // §5.3: schedule 成功後すぐ DB 3 列を set してブロックを即時有効化する。
    // redirect より前に書く (redirect は throw でフローを終了させるため、後に書くと
    // DB write が実行されない)。end_date は Unix 秒 → Date 変換が必要。
    const db = getDb()
    await db.update(users).set({
      scheduledDowngradeScheduleId: schedule.id,
      scheduledTargetPriceId: targetPriceId,
      scheduledChangeEffectiveAt: new Date(schedule.phases[0].end_date * 1000),
    }).where(eq(users.id, user.id))
    redirect('/app?billing=downgrade')
  }
}

// 予約済みダウングレードの取消 (§5.5 例外)。release で schedule を解除し現 price を
// 継続させ、プラン変更ページに戻す。
export async function cancelDowngrade(formData: FormData): Promise<void> {
  const user = await getCurrentUser()
  if (!user) {
    throw new Error('USER_NOT_SYNCED')
  }

  const operationId = formData.get('operationId')
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new Error('MISSING_OPERATION_ID')
  }

  const { sub } = await resolveActiveSubscriptionOrNotify(user)

  const pending = getPendingState(sub)
  if (pending.scheduleId === null) {
    // 取消対象が無い (既に release 済 / そもそも未予約)。
    throw new Error('NO_SCHEDULE')
  }

  const idempotencyKey = `cancelDowngrade:${user.id}:${operationId}`
  await cancelScheduledDowngrade(pending.scheduleId, idempotencyKey)
  // §5.5 例外: release 成功後 DB 3 列を clear (null に set) する。
  // redirect より前に書く (redirect は throw でフローを終了させる)。
  const db = getDb()
  await db.update(users).set({
    scheduledDowngradeScheduleId: null,
    scheduledTargetPriceId: null,
    scheduledChangeEffectiveAt: null,
  }).where(eq(users.id, user.id))
  redirect('/app/upgrade')
}

// resolve 失敗時の共通ハンドリング。NoSubscription / Ambiguous は notifyOps して
// 汎用エラーに正規化 (自動で subscription を 1 本選ばない、§8)。それ以外の error は
// そのまま伝播させる。redirect の throw を巻き込まないよう resolve のみを包む。
async function resolveActiveSubscriptionOrNotify(
  user: User,
): Promise<Awaited<ReturnType<typeof resolveActiveSubscription>>> {
  try {
    return await resolveActiveSubscription(user)
  } catch (err) {
    if (
      err instanceof NoSubscriptionError ||
      err instanceof AmbiguousSubscriptionError
    ) {
      const environment =
        process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'
      await notifyOps('plan change: subscription unresolved', {
        userId: user.id,
        clerkId: user.clerkId,
        kind: err.name,
        environment,
        timestamp: new Date().toISOString(),
      })
      throw new Error('SUBSCRIPTION_UNRESOLVED')
    }
    throw err
  }
}
