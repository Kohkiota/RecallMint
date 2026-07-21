'use server'

import { headers } from 'next/headers'
import { auth } from '@clerk/nextjs/server'
import { sql } from 'drizzle-orm'
import { contactSchema } from '@/lib/validation/contact'
import { getNonTenantDb } from '@/lib/db'
import { contactMessages } from '@/lib/db/schema'
import { notifyOps } from '@/lib/ops'
import { logger } from '@/lib/logger'
import { checkContactRateLimit } from '@/lib/rate-limit/contact-action'
import type { ActionResult } from '@/lib/actions/result'

// 認証外 contact form の submit 処理。
// Sprint A-3.2 で validation-only stub → contact_messages INSERT 実装に拡張。
//
// 認証済 user は Clerk session → users lookup → user_id を保存、 未認証は
// user_id = null。 status は schema default 'open' に任せ明示指定しない。
// DB 書き込み失敗時は notifyOps (Discord) で escalate しつつ user には
// 汎用エラーを返す (内部 error を bot に漏らさない)。
export async function submitContact(input: unknown): Promise<ActionResult> {
  const parsed = contactSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message }
  }

  // Rate limit gate (audit §10.3 (b) #15、 T-A7): IP / userId 単位 5 req/h。
  // key 優先順位 = signed-in userId > IP。 Clerk auth() 失敗時は IP のみで
  // 抑止継続 (DB insert 側の auth lookup と分離 — auth 障害で rate limit を
  // 無効化すると bot に悪用される)。 IP 取得失敗 (dev / 直 invoke 等) は
  // `'unknown'` bucket に集約 (= anonymous 全体で 5 req/h 共有、 dev では
  // 通常許容範囲)。
  let rateLimitUserId: string | null = null
  try {
    const { userId } = await auth()
    rateLimitUserId = userId
  } catch {
    // 匿名扱いで rate limit gate を続行 (詳細 log は DB insert 側の auth
    // 再試行で記録される)。
  }
  // I-2 (review): signed-in userId が取れたら IP は不要、 headers() の async
  // 呼出を skip (cheap optimization + headers() error 経路の縮減)。
  const rateKey = rateLimitUserId
    ? `userId:${rateLimitUserId}`
    : `ip:${await getRequestIp()}`
  if (!checkContactRateLimit(rateKey).allowed) {
    return { ok: false, error: 'rate_limited' }
  }

  // honeypot: website field に値があれば silent reject (bot に成功を装う)。
  // DB 書き込みもスキップ — bot 由来データを保存しない。
  // 注: rate limit gate は honeypot より前に置く (bot に枠を消費させて
  // 同一 IP からの正規 user を保護)。
  if (parsed.data.website && parsed.data.website.length > 0) {
    return { ok: true }
  }

  const { email, category, subject, body } = parsed.data

  try {
    // RLS-P3 (Task 1): 匿名 contact — user_id は nullable、認証済でも SECURITY
    // DEFINER bootstrap 解決前は tenant context を張れないため非 tenant handle を使う。
    const db = getNonTenantDb()

    // 認証済 user は内部 user.id を解決 (clerk_id → 内部 id、 SECURITY DEFINER
    // 関数 app_bootstrap_user_from_clerk 経由で RLS 迂回。id 列だけ射影)。
    // 未認証 / users 未同期 / Clerk SDK 一時障害は user_id = null で受付
    // (schema 上 nullable)。 auth() 失敗を DB insert 失敗と混同すると
    // notifyOps の subject を誤って "contact_messages insert failed" に
    // させ、 ops に偽信号を送る (DB は健全のまま)。 そのため auth() は
    // 独立した try/catch で囲み、 失敗時は warn log + 匿名扱いに落とす。
    let userId: string | null = null
    try {
      const { userId: clerkId } = await auth()
      if (clerkId) {
        const idRows = await db.execute<{ id: string }>(
          sql`SELECT id FROM public.app_bootstrap_user_from_clerk(${clerkId})`,
        )
        userId = idRows[0]?.id ?? null
      }
    } catch (authErr) {
      logger.warn({ event: 'contact.auth_lookup.failed', err: authErr })
      // userId = null のまま続行 (匿名問い合わせとして受付)
    }

    await db.insert(contactMessages).values({
      userId,
      email,
      category,
      subject,
      body,
      // status は default 'open' に任せて明示指定しない。
    })

    return { ok: true }
  } catch (err) {
    // 書き込み失敗 (DB 接続断 / 制約違反 等) は ops に escalate。
    // notifyOps は fetch error を内部で呑む (best-effort)、 通常時は二重 throw
    // にならない。 例外: T-A5 以降、 production で OPS_DISCORD_WEBHOOK_URL 未設定
    // (= deployment misconfig) なら notifyOps が throw し、 本 catch を escape
    // して Server Action 境界へ 500 propagate する。 deploy 直後に operator が
    // Vercel logs で即時検知する fail-fast 意図 (audit §10.3 (b) #14、 T-A5)。
    // prod env 設定済を前提とするため runtime では発生しない。
    logger.error({ event: 'contact.insert.failed', err })
    await notifyOps('contact_messages insert failed', {
      error: err,
      email,
      category,
      subject,
      timestamp: new Date().toISOString(),
    })
    return {
      ok: false,
      error: '送信に失敗しました。時間をおいて再度お試しください。',
    }
  }
}

// Next.js Vercel pattern: client IP は `x-forwarded-for` の先頭 token、
// fallback で `x-real-ip`。 いずれも欠落時は `'unknown'` で anonymous bucket
// 集約 (dev / 直 invoke / proxy header 剥がし等)。 Next.js 15+ で headers()
// は async。
async function getRequestIp(): Promise<string> {
  try {
    const h = await headers()
    const xff = h.get('x-forwarded-for')
    if (xff) {
      const first = xff.split(',')[0]?.trim()
      if (first) return first
    }
    const real = h.get('x-real-ip')?.trim()
    if (real) return real
  } catch {
    // headers() が Server Action 経路外で呼ばれた等の例外 — anonymous fallback
  }
  // I-3 (review): production 環境で proxy header config regression が起きると
  // 全 anonymous traffic が `'unknown'` bucket に集約され、 5 req/h 上限で site
  // 全体の silent DoS になる。 prod でこの fallback が発火したら 1 行 warn 出力で
  // Vercel logs に surface (sampling = anonymous request の希少性で実用範囲、
  // log spam にはならない)。 dev / test env は VERCEL_ENV 未設定で skip。
  if (process.env.VERCEL_ENV === 'production') {
    logger.warn({ event: 'contact.rate_limit.ip_missing' })
  }
  return 'unknown'
}
