// Webhook secret env-aware gate (audit §10.3 (b) #17、 T-A8 重要 fix = 認証系)。
//
// `STRIPE_WEBHOOK_SECRET` / `CLERK_WEBHOOK_SECRET` の取得を 3-tier env-aware に
// 統一する: production (= `VERCEL_ENV === 'production'`) は env 必須 (欠落で
// throw → Next.js route handler 内で 500 を返す)、 preview (`VERCEL_ENV === 'preview'`)
// は `logger.warn` で観測性を残しつつ空文字 fallback (signature verify は失敗するが
// 既存 wire format = 400 invalid signature 経路に自然に流れる)、 local / dev
// (`VERCEL_ENV` 未設定 = local Next.js dev) は silent skip (空文字 return)。
//
// 設計意図:
// - production の throw を「起動時 fail-fast」と表現しているが、 module import
//   時点ではなく POST request 到達時点 (= helper 呼び出し時点) で throw する。
//   Next.js App Router は route handler 内の throw を 500 へ変換するため、
//   既存の `process.env.NODE_ENV === 'production'` 早期 return 500 path と
//   wire format が一致する (= 既存挙動不変)。
// - preview で 500 ではなく warn fallback にする理由: preview env で誤って
//   webhook 構成漏れがあった場合に build 自体が落ちる不便を避けつつ、
//   `webhook.secret.missing_preview` log で OT が検知できる経路を残す。
// - local dev は webhook secret なしで開発できるよう silent skip (既存挙動踏襲)。
//
// server-only 不付: caller は server-side route handler 限定だが、 helper 自体は
// pure 関数で client bundle に入る経路は構造的にない (Y-1 T5 / T-A1〜T-A7 precedent
// と同方針)。 将来 webhook が増えても helper を触らず caller 側で
// `requireWebhookSecret('NEW_WEBHOOK_SECRET', 'label')` を呼べばよいよう、
// envKey は引数指定 (固定 list を helper 内に持たない)。

import { logger } from '@/lib/logger'

export function requireWebhookSecret(envKey: string, label: string): string {
  const value = process.env[envKey]
  if (value) return value

  const tier = process.env.VERCEL_ENV
  if (tier === 'production') {
    throw new Error(
      `${envKey} must be set in production (see audit §10.3 (b) #17)`,
    )
  }
  if (tier === 'preview') {
    logger.warn({
      event: 'webhook.secret.missing_preview',
      label,
      envKey,
    })
    return ''
  }
  // local / dev (VERCEL_ENV 未設定) = silent skip
  return ''
}
