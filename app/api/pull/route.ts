// GET /api/pull — 統合 delta pull endpoint。
// cards / exams / tombstone / tag_categories / tag_options の 5 ストリームを 1 レスポンスに
// 集約し、ストリーム別 next-cursor (maxUpdatedAt / maxDeletedAt) を返す。
//
// query params (snake_case):
//   since_cards / since_exams / since_tombstone /
//   since_tag_categories / since_tag_options
//   - 有効 ISO8601 → その Date 以降の差分のみ返す (since inclusive)
//   - 欠落 / 不正値 → undefined = 全件 fallback
//
// 認可: middleware は /app(.*) のみ protect。/api は素通しのため、ここで
// Clerk session 不在は 401 を返す (app/api/cards/pull/route.ts と同 pattern)。

import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { getCategoriesDelta } from '@/lib/db/tag-categories-pull'
import { getOptionsDelta } from '@/lib/db/tag-options-pull'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// safeParse で例外を投げない。不正値 / null は undefined (全件 fallback)。
function parseSince(raw: string | null): Date | undefined {
  if (raw === null) return undefined
  const result = z.iso.datetime().safeParse(raw)
  if (!result.success) return undefined
  return new Date(raw)
}

export async function GET(req: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }

  let user: Awaited<ReturnType<typeof getCurrentUser>>
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401, headers })
    }
    logger.warn({ event: 'api.pull.auth_failed', err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }

  // Clerk session はあるが users 行が未 sync (sign-up race) → 200 で空レスポンス
  if (!user) {
    return Response.json(
      {
        cards: [],
        exams: [],
        tombstones: [],
        tag_categories: [],
        tag_options: [],
        cursors: {
          cards: null,
          exams: null,
          tombstone: null,
          tag_categories: null,
          tag_options: null,
        },
      },
      { status: 200, headers },
    )
  }

  const u = new URL(req.url).searchParams
  const sc = parseSince(u.get('since_cards'))
  const se = parseSince(u.get('since_exams'))
  const st = parseSince(u.get('since_tombstone'))
  const stc = parseSince(u.get('since_tag_categories'))
  const sto = parseSince(u.get('since_tag_options'))

  try {
    const [c, e, t, tc, to] = await Promise.all([
      getCardsDelta(user.id, sc),
      getExamsDelta(user.id, se),
      getTombstonesDelta(user.id, st),
      getCategoriesDelta(user.id, stc),
      getOptionsDelta(user.id, sto),
    ])
    return Response.json(
      {
        cards: c.rows,
        exams: e.rows,
        tombstones: t.rows,
        tag_categories: tc.rows,
        tag_options: to.rows,
        cursors: {
          cards: c.maxUpdatedAt,
          exams: e.maxUpdatedAt,
          tombstone: t.maxDeletedAt,
          tag_categories: tc.maxUpdatedAt,
          tag_options: to.maxUpdatedAt,
        },
      },
      { status: 200, headers },
    )
  } catch (err) {
    logger.warn({ event: 'api.pull.failed', userId: user.id, err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
}
