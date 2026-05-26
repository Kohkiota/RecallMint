// GET /api/cards/pull — S-local-2 Task 2 (§14.11 local-first MVP)。
// user の全 cards を full snapshot で返却。 Phase α では since cursor は受信
// するが無視 (全件返却)、 Δ pull は Phase β 以降。
//
// 認可: middleware は /app(.*) のみ protect、 /api は素通しのため、 ここで
// Clerk session 不在は 401 を返す (`/api/dashboard/stats` と同 pattern)。
// Cache-Control: no-store で proxy/CDN キャッシュを抑止、 pull endpoint で stale を
// 返さないことを保証する。

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getAllCardsForUser } from '@/lib/db/cards-pull'
import { logger } from '@/lib/logger'
import type { User } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function GET(_req: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }

  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401, headers })
    }
    logger.warn({ event: 'api.cards.pull.auth_failed', err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
  // Clerk session はあるが users 行が未 sync (sign-up race) → 200 で空 cards
  // (dashboard / api.dashboard.stats と同 「安全側 0 件」 挙動)。
  if (!user) {
    return Response.json(
      { cards: [], now: new Date().toISOString() },
      { status: 200, headers },
    )
  }

  try {
    const cards = await getAllCardsForUser(user.id)
    return Response.json(
      { cards, now: new Date().toISOString() },
      { status: 200, headers },
    )
  } catch (err) {
    logger.warn({ event: 'api.cards.pull.failed', userId: user.id, err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
}
