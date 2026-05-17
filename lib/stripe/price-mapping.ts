// Stripe price_id ↔ (plan, interval) 双方向 lookup。
//
// 設計:
// - 課金 plan は 'standard' | 'pro' の 2 値 (free は Stripe price を持たない)
// - cycle は 'month' | 'year' の 2 値
// - 4 つの env (STRIPE_PRICE_STANDARD_MONTHLY/YEARLY/PRO_MONTHLY/PRO_YEARLY)
//   から module load 時に 4 cell の双方向 map を構築
//
// fail-fast: env 欠落 / 重複価格 ID は module import 時に throw。 lib/stripe.ts の
// SECRET_KEY 検証と同じ pattern (config bug を runtime 末端まで持ち越さない)。
//
// usage:
// - webhook handler: sub.items.data[0].price.id → resolveFromPriceId(id)
//   不一致 (null) は呼び出し側で notifyOps + plan='free' fallback
// - upgrade page / pricing page: priceIdFor(plan, interval) で Stripe Checkout
//   line_items に渡す価格 ID を取得

export type PaidPlan = 'standard' | 'pro'
export type BillingInterval = 'month' | 'year'

export type PriceMapping = {
  plan: PaidPlan
  interval: BillingInterval
}

function readEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(`${name} is not set`)
  }
  return v
}

const STANDARD_MONTHLY = readEnv('STRIPE_PRICE_STANDARD_MONTHLY')
const STANDARD_YEARLY = readEnv('STRIPE_PRICE_STANDARD_YEARLY')
const PRO_MONTHLY = readEnv('STRIPE_PRICE_PRO_MONTHLY')
const PRO_YEARLY = readEnv('STRIPE_PRICE_PRO_YEARLY')

// 重複 price ID は inverse map で silent collision を生むため module load 時に
// 検出する (config bug detection)。 OT が誤って同じ price ID を 2 つ以上の
// STRIPE_PRICE_* env に設定した場合に webhook が誤分類するのを防ぐ。
const all = [STANDARD_MONTHLY, STANDARD_YEARLY, PRO_MONTHLY, PRO_YEARLY]
if (new Set(all).size !== all.length) {
  throw new Error(
    `STRIPE_PRICE_* env vars must all be distinct. Got: ${JSON.stringify({
      STANDARD_MONTHLY,
      STANDARD_YEARLY,
      PRO_MONTHLY,
      PRO_YEARLY,
    })}`,
  )
}

const PRICE_TO_PLAN: Readonly<Record<string, PriceMapping>> = Object.freeze({
  [STANDARD_MONTHLY]: { plan: 'standard', interval: 'month' },
  [STANDARD_YEARLY]: { plan: 'standard', interval: 'year' },
  [PRO_MONTHLY]: { plan: 'pro', interval: 'month' },
  [PRO_YEARLY]: { plan: 'pro', interval: 'year' },
})

export function resolveFromPriceId(priceId: string): PriceMapping | null {
  return PRICE_TO_PLAN[priceId] ?? null
}

export function priceIdFor(plan: PaidPlan, interval: BillingInterval): string {
  if (plan === 'standard' && interval === 'month') return STANDARD_MONTHLY
  if (plan === 'standard' && interval === 'year') return STANDARD_YEARLY
  if (plan === 'pro' && interval === 'month') return PRO_MONTHLY
  if (plan === 'pro' && interval === 'year') return PRO_YEARLY
  // exhaustive switch — TypeScript narrowing で到達不能だが defensive
  throw new Error(`Invalid plan/interval: ${plan}/${interval}`)
}
