import Stripe from 'stripe'

// Stripe env prefix validation (CLAUDE.md §Stripe-1)。
//
// 環境依存 (lib/clerk.ts と同 pattern):
// - `VERCEL_ENV === 'production'` → SECRET_KEY = `rk_live_` / `sk_live_`、
//   PUBLISHABLE_KEY = `pk_live_` 必須、 test keys 拒否
// - それ以外 (preview / development / undefined) → SECRET_KEY = `rk_test_` /
//   `sk_test_`、 PUBLISHABLE_KEY = `pk_test_` 必須、 live keys 拒否
//
// 旧実装 (Sprint A-3.2 以前) は test keys 専用であったが、 本番デプロイで
// `rk_live_` が弾かれて Vercel build 失敗するため lib/clerk.ts と同形式の
// VERCEL_ENV-aware 検証に変更。 CLAUDE.md §Stripe 絶対ルールも同変更で env-aware
// 文言に書換済。

const key = process.env.STRIPE_SECRET_KEY
const pk = process.env.STRIPE_PUBLISHABLE_KEY
const isProd = process.env.VERCEL_ENV === 'production'

if (!key) {
  throw new Error('STRIPE_SECRET_KEY is not set')
}

if (!pk) {
  throw new Error('STRIPE_PUBLISHABLE_KEY is not set')
}

if (isProd) {
  if (!key.startsWith('rk_live_') && !key.startsWith('sk_live_')) {
    throw new Error(
      `STRIPE_SECRET_KEY must start with rk_live_ or sk_live_ when VERCEL_ENV=production. ` +
        `Test keys (rk_test_ / sk_test_) are not allowed in production. ` +
        `Got prefix: ${key.slice(0, 8)}...`,
    )
  }
  if (!pk.startsWith('pk_live_')) {
    throw new Error(
      `STRIPE_PUBLISHABLE_KEY must start with pk_live_ when VERCEL_ENV=production. ` +
        `Test keys (pk_test_) are not allowed in production. ` +
        `Got prefix: ${pk.slice(0, 8)}...`,
    )
  }
} else {
  if (!key.startsWith('rk_test_') && !key.startsWith('sk_test_')) {
    throw new Error(
      `STRIPE_SECRET_KEY must start with rk_test_ or sk_test_ in non-production environments. ` +
        `Live keys (rk_live_ / sk_live_) are only permitted when VERCEL_ENV=production. ` +
        `Got prefix: ${key.slice(0, 8)}...`,
    )
  }
  if (!pk.startsWith('pk_test_')) {
    throw new Error(
      `STRIPE_PUBLISHABLE_KEY must start with pk_test_ in non-production environments. ` +
        `Live keys (pk_live_) are only permitted when VERCEL_ENV=production. ` +
        `Got prefix: ${pk.slice(0, 8)}...`,
    )
  }
}

// Spec: docs/superpowers/specs/2026-04-27-account-deletion-redesign.md §8.3
// hybrid retry の SDK part。stripe-node v22 の RequestSender._shouldRetry は
// network error / 409 / 5xx のみ retry 対象 (HTTP 429 は SDK 対象外)。
// SDK の Idempotency-Key 自動付与で cancel 含む全 API を安全に retry。
//
// 注: `maxNetworkRetries: 2` は stripe-node v22 のデフォルト同値 (挙動変化ゼロ)。
// spec §8.3 への明示的紐付け + 将来 SDK default 変動への防御として明示固定。
//
// HTTP 429 は spec §8.3 の application 層 retry (`cancelWithRetry` 下記) で別経路。
// CLAUDE.md AI-5 (429 受信時即時停止) は Gemini 無料枠保護専用ルールで Stripe には
// 適用しない (Stripe は paid API、Idempotency-Key 自動付与で retry 安全)。
export const stripe = new Stripe(key, { maxNetworkRetries: 2 })

// Spec §8.3 hybrid retry の application 層 part。HTTP 429 (StripeRateLimitError)
// のみ 1 sec sleep + 1 retry の固定回数。指数バックオフは webhook handler の
// Vercel function timeout を圧迫するため不採用。それ以外 (4xx 確定 / network 等) は
// throw して呼び出し側 (Plan B webhook handler の per-sub catch) で recordFailure
// に流す。cancel が idempotent + Idempotency-Key 自動付与で retry 安全。
const RATE_LIMIT_RETRY_DELAY_MS = 1000

export async function cancelWithRetry(subId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subId)
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeRateLimitError)) throw err
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS))
    await stripe.subscriptions.cancel(subId)
  }
}
