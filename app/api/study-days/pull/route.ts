// GET /api/study-days/pull — S-perf-3 (dashboard 高速化、 streak / todayCount を
// Dexie 経由に切替)。 user の直近 90 日分の study_days を返却。 client は
// `lib/sync/study-days.ts` で Dexie にミラーする。
//
// 認可: middleware は /app(.*) のみ protect、 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す (`/api/cards/pull` と同 pattern)。
// Cache-Control: no-store で proxy/CDN キャッシュを抑止、 pull endpoint で stale を
// 返さないことを保証する。

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getAllStudyDaysForUser } from '@/lib/db/study-days-pull'
import { logger } from '@/lib/logger'
import type { User } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }

  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401, headers })
    }
    logger.warn({ event: 'api.study_days.pull.auth_failed', err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
  // Clerk session はあるが users 行が未 sync (sign-up race) → 200 で空配列を返す
  // (cards/pull / dashboard/stats と同 「安全側 0 件」 挙動)。
  if (!user) {
    return Response.json(
      { studyDays: [], now: new Date().toISOString() },
      { status: 200, headers },
    )
  }

  try {
    const studyDays = await getAllStudyDaysForUser(user.id)
    return Response.json(
      { studyDays, now: new Date().toISOString() },
      { status: 200, headers },
    )
  } catch (err) {
    logger.warn({ event: 'api.study_days.pull.failed', userId: user.id, err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
}
