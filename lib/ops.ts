// 運用通知 helper。設計: tech-spec §6 (アカウント削除フローの失敗通知を含む)。
// Operational notification helper. Posts a structured message to the Discord
// channel configured via OPS_DISCORD_WEBHOOK_URL.
//
// Phase 1 F (Sentry) 導入時は本ファイルの notifyOps の中身を
// `Sentry.captureException(err, { extra: context })` 等に差し替えるだけで移行可能な
// 構造で実装している (signature を維持、呼び出し側無変更)。
//
// 設計上の保証:
// - OPS_DISCORD_WEBHOOK_URL 未設定環境 (local dev / preview) では no-op
// - production (VERCEL_ENV='production') で URL 未設定なら notifyOps 呼出時に throw
//   (audit §10.3 (b) #14: silent fallback で ops 通知が黙って失敗する経路を解消、
//   遅延 fail-fast — module load 時 eager throw は test 困難なため呼出時に throw)
// - fetch 失敗時は logger.warn (既存) に加え production のみ logger.error も発火
//   (warn が log filter で消える可能性に備え stderr に必須残し、 audit §10.3 (b) #14)
// - Discord content の 2000 char 制限を考慮して 1900 char で truncate

import { logger } from '@/lib/logger'

const MAX_CONTENT_LEN = 1900

export async function notifyOps(
  subject: string,
  context: Record<string, unknown>,
): Promise<void> {
  const url = process.env.OPS_DISCORD_WEBHOOK_URL
  if (!url) {
    // audit §10.3 (b) #14: production で URL 未設定は deployment misconfig なので
    // silent no-op せず throw (operator に即時気付かせる)。
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error(
        'OPS_DISCORD_WEBHOOK_URL must be set in production (see audit §10.3 (b) #14)',
      )
    }
    return
  }

  let contextStr: string
  try {
    contextStr = JSON.stringify(context, makeReplacer(), 2)
  } catch (err) {
    // makeReplacer が Error / Circular を吸収するので通常 throw しないが、
    // 未知の serialize edge case (BigInt 等) への defensive
    contextStr = `<failed to serialize context: ${String(err)}>`
  }

  const raw = `**${subject}**\n\`\`\`json\n${contextStr}\n\`\`\``
  const content =
    raw.length > MAX_CONTENT_LEN
      ? `${raw.slice(0, MAX_CONTENT_LEN)}...[truncated]`
      : raw

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      // I-baseline-2 (Phase 1 G-baseline-1): cap Discord fetch at 3000ms.
      // If Discord hangs, AbortSignal aborts the request and the AbortError
      // falls into the catch below. Without this, a hung Discord call could
      // consume the surrounding Vercel function budget (Hobby 10s / Pro 60s).
      // 3000ms = ~3x Discord's typical sub-second response (best-effort upper
      // bound, not a tight SLA).
      signal: AbortSignal.timeout(3000),
    })
    // Discord は 204 を返す。non-2xx も escalate しない:
    // notifyOps 自身の失敗が呼び出し元を巻き込んではならない。
  } catch (err) {
    logger.warn({ event: 'ops.notify.fetch_failed', err })
    // audit §10.3 (b) #14: production で fetch 失敗 (Discord 到達不可) は
    // 単発失敗 (warn) より重い事象として error にも残す (stderr 必須残し、
    // log filter で warn が消える可能性に備える)。 url は webhook secret なので
    // payload に含めず redact。
    if (process.env.VERCEL_ENV === 'production') {
      logger.error({ event: 'ops.notify.unreachable', err, url: '<redacted>' })
    }
  }
}

/**
 * Webhook handler の outer catch 専用 helper。
 *
 * notifyOps を内側で呼び、payload shape を 4 callsite (Clerk / Stripe webhook)
 * で統一する。`environment` / `timestamp` は helper 内部で自動付与し、callsite に
 * 載せない (callsite で書く field を最小化)。
 *
 * `userId` / `customerId` は省略可能。`undefined` field は JSON.stringify で
 * payload から消える。
 *
 * **T-A5 以降の throw 条件** (audit §10.3 (b) #14): production で
 * `OPS_DISCORD_WEBHOOK_URL` 未設定の場合、 内部の notifyOps が throw する
 * (deployment misconfig 即時検知の fail-fast)。 webhook handler は本 helper の
 * throw を outer catch で受け、 HTTP 500 を返す → Clerk / Stripe が retry。
 * Sentry-swap-ready interface としては、 Phase 1 F (Sentry) 移行時にも同 throw
 * semantics を維持する (= operator に misconfig を運用早期発見させる契約)。
 */
export async function notifyWebhookError(args: {
  handler: 'clerk' | 'stripe'
  eventId: string
  eventType: string
  err: unknown
  userId?: string
  customerId?: string
}): Promise<void> {
  const environment =
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'
  await notifyOps(`${args.handler} webhook handler error`, {
    handler: args.handler,
    eventId: args.eventId,
    eventType: args.eventType,
    userId: args.userId,
    customerId: args.customerId,
    error: args.err,
    environment,
    timestamp: new Date().toISOString(),
  })
}

// Error instance を name/message/stack に展開、循環参照を [Circular] で置換。
// 各 notifyOps 呼び出しごとに新しい seen set を作る。
function makeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}
