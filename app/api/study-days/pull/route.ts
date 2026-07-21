// GET /api/study-days/pull — S-perf-3 (dashboard 高速化、 streak / todayCount を
// Dexie 経由に切替)。 user の直近 90 日分の study_days を返却。 client は
// `lib/sync/study-days.ts` で Dexie にミラーする。
//
// 認可: middleware は /app(.*) のみ protect、 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す (`/api/cards/pull` と同 pattern)。
// Cache-Control: no-store で proxy/CDN キャッシュを抑止、 pull endpoint で stale を
// 返さないことを保証する。

import { withReadOnlyAuth } from '@/lib/auth/with-read-only-auth'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getAllStudyDaysForUser } from '@/lib/db/study-days-pull'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

export const GET = withReadOnlyAuth(
  {
    // Clerk session はあるが users 行が未 sync (sign-up race) → 200 で空配列を返す
    // (cards/pull / dashboard/stats と同 「安全側 0 件」 挙動)。
    emptyBody: { studyDays: [] },
    authFailEvent: 'api.study_days.pull.auth_failed',
  },
  async (user, headers) => {
    try {
      const studyDays = await withTenantTx(user.id, (tx) =>
        getAllStudyDaysForUser(user.id, tx),
      )
      return Response.json({ studyDays }, { status: 200, headers })
    } catch (err) {
      logger.warn({
        event: 'api.study_days.pull.failed',
        userId: user.id,
        err,
      })
      return Response.json({ error: 'internal' }, { status: 500, headers })
    }
  },
)
