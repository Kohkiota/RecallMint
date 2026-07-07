// GET /api/dashboard/stats — dashboard の「今日の枚数 / 連続日数」 polling endpoint。
//
// S-perf-2 T4: dashboard `/app/page.tsx` の server SSR から streak.ts の 2 SELECT を
// 外し、 client 側 `<DashboardStats />` が mount 後に fetch する。 これにより
// `/app` の RSC body streaming が ~500 ms 短縮見込 (T5 で実測検証)。 dueCount は
// CTA (DashboardActions) の enable 判定に必要なので page.tsx の server SSR に残置。
//
// 認可: middleware は /app(.*) のみ protect、 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す (`/api/exams/status` 同 pattern)。
//
// Cache-Control: no-store で proxy/CDN キャッシュを抑止 (polling endpoint で
// stale 値を返さないことの保証)。

import { withReadOnlyAuth } from '@/lib/auth/with-read-only-auth'
import { getReviewStatsForUser } from '@/lib/db/streak'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

export const GET = withReadOnlyAuth(
  {
    // Clerk session はあるが users 行が未 sync (sign-up race) → 200 で空 stats を返す
    // (dashboard の既存挙動 = SyncingPage に倒れる前にも 0 表示の安全側)。
    emptyBody: { todayCardCount: 0, streak: 0 },
    authFailEvent: 'api.dashboard.stats.auth_failed',
  },
  async (user, headers) => {
    try {
      const stats = await getReviewStatsForUser(user.id)
      return Response.json(stats, { status: 200, headers })
    } catch (err) {
      logger.warn({ event: 'api.dashboard.stats.failed', userId: user.id, err })
      return Response.json({ error: 'internal' }, { status: 500, headers })
    }
  },
)
