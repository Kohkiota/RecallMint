// GET /api/stats/summary?exam_id=<uuid> — W4「優先して復習」(苦手タグ Top3) 用。
// Dash-1 Home v1 spec §10。v1 で唯一の server 集計 endpoint (他の widget は Dexie
// mirror からの client 計算)。
//
// 形は P-3 の read-only endpoint 慣例をそのまま踏襲する (study-days/pull と同型):
// withReadOnlyAuth (401 / sign-up race の空 200 / 500+no-store) + withTenantTx +
// owner echo + Cache-Control: no-store。
//
// exam_id echo: client (weak-tags.tsx) が試験切替時の遅着応答を捨てるための出所表明
// (owner echo が別 user の応答を弾くのと同じ役割を「別試験」に対して果たす — spec §4 W4)。
//
// 実在しない exam_id / 他 owner の exam_id は **404 ではなく空 200**。tenant tx の
// WHERE user_id で自然に 0 行になるだけで、存在有無を漏らさない (spec §10)。
// 400 になるのは「欠落 / uuid 形式でない」= client 側のバグだけ。

import { z } from 'zod'

import { withReadOnlyAuth } from '@/lib/auth/with-read-only-auth'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getWeakTagsSummary } from '@/lib/db/weak-tags-summary'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

const examIdSchema = z.uuid()

// 欠落 / 非 uuid → null (呼出側で 400)。素の文字列を uuid 比較に渡すと Postgres が
// 22P02 で落ち、client のバグが 500 として観測されてしまう。
function parseExamIdParam(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get('exam_id')
  if (raw === null) return null
  const parsed = examIdSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const GET = withReadOnlyAuth(
  {
    // Clerk session はあるが users 行が未 sync (sign-up race) → 空 200
    // (study-days/pull と同じ「安全側 0 件」)。静的リテラルなので owner/exam echo は
    // 載らない — client は echo 不在を「照合不能 = 表示しない」として扱う。
    emptyBody: { weak_tags: [] },
    authFailEvent: 'api.stats.summary.auth_failed',
  },
  async (user, headers, req) => {
    const examId = parseExamIdParam(req)
    if (examId === null) {
      return Response.json(
        { error: 'invalid_exam_id' },
        { status: 400, headers },
      )
    }

    // spec §10: 評価時刻は handler 冒頭で 1 回だけ取り、30 日窓と応答全体で同一の
    // instant を使う (集計の途中で窓の境界が動かない)。
    const receivedAt = new Date()

    try {
      const weakTags = await withTenantTx(user.id, (tx) =>
        getWeakTagsSummary(user.id, examId, tx, receivedAt),
      )
      return Response.json(
        { owner_user_id: user.id, exam_id: examId, weak_tags: weakTags },
        { status: 200, headers },
      )
    } catch (err) {
      logger.warn({ event: 'api.stats.summary.failed', userId: user.id, err })
      return Response.json({ error: 'internal' }, { status: 500, headers })
    }
  },
)
