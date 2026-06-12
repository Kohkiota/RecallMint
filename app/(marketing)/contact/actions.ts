'use server'

import { auth } from '@clerk/nextjs/server'
import { eq } from 'drizzle-orm'
import { contactSchema } from '@/lib/validation/contact'
import { getDb } from '@/lib/db'
import { users, contactMessages } from '@/lib/db/schema'
import { notifyOps } from '@/lib/ops'
import { logger } from '@/lib/logger'
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

  // honeypot: website field に値があれば silent reject (bot に成功を装う)。
  // DB 書き込みもスキップ — bot 由来データを保存しない。
  if (parsed.data.website && parsed.data.website.length > 0) {
    return { ok: true }
  }

  const { email, category, subject, body } = parsed.data

  try {
    const db = getDb()

    // 認証済 user は内部 user.id を解決 (users.clerkId → users.id)。
    // 未認証 / users 未同期 / Clerk SDK 一時障害は user_id = null で受付
    // (schema 上 nullable)。 auth() 失敗を DB insert 失敗と混同すると
    // notifyOps の subject を誤って "contact_messages insert failed" に
    // させ、 ops に偽信号を送る (DB は健全のまま)。 そのため auth() は
    // 独立した try/catch で囲み、 失敗時は warn log + 匿名扱いに落とす。
    let userId: string | null = null
    try {
      const { userId: clerkId } = await auth()
      if (clerkId) {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1)
        userId = rows[0]?.id ?? null
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
