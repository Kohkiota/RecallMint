// GET /api/pull — 統合 delta pull endpoint。
// cards / exams / tombstone / tag_categories / tag_options / card_tags の 6 ストリームを
// 1 レスポンスに集約し、ストリーム別 next-cursor (maxUpdatedAt / maxDeletedAt /
// maxCreatedAt) を返す。
//
// query params (snake_case):
//   since_cards / since_exams / since_tombstone /
//   since_tag_categories / since_tag_options / since_card_tags
//   - 有効 ISO8601 → その Date 以降の差分のみ返す (since inclusive)
//   - 欠落 / 不正値 → undefined = 全件 fallback
//
// 認可: middleware は /app(.*) のみ protect。/api は素通しのため、ここで
// Clerk session 不在は 401 を返す (app/api/cards/pull/route.ts と同 pattern)。

import { z } from 'zod'
import { withReadOnlyAuth } from '@/lib/auth/with-read-only-auth'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getCardsDelta } from '@/lib/db/cards-pull'
import { getExamsDelta } from '@/lib/db/exams-pull'
import { getTombstonesDelta } from '@/lib/db/tombstones-pull'
import { getCategoriesDelta } from '@/lib/db/tag-categories-pull'
import { getOptionsDelta } from '@/lib/db/tag-options-pull'
import { getCardTagsDelta } from '@/lib/db/card-tags-pull'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// safeParse で例外を投げない。不正値 / null は undefined (全件 fallback)。
function parseSince(raw: string | null): Date | undefined {
  if (raw === null) return undefined
  const result = z.iso.datetime().safeParse(raw)
  if (!result.success) return undefined
  return new Date(raw)
}

export const GET = withReadOnlyAuth(
  {
    // Clerk session はあるが users 行が未 sync (sign-up race) → 200 で空レスポンス
    emptyBody: {
      cards: [],
      exams: [],
      tombstones: [],
      tag_categories: [],
      tag_options: [],
      card_tags: [],
      cursors: {
        cards: null,
        exams: null,
        tombstone: null,
        tag_categories: null,
        tag_options: null,
        card_tags: null,
      },
    },
    authFailEvent: 'api.pull.auth_failed',
  },
  async (user, headers, req) => {
    const u = new URL(req.url).searchParams
    const sc = parseSince(u.get('since_cards'))
    const se = parseSince(u.get('since_exams'))
    const st = parseSince(u.get('since_tombstone'))
    const stc = parseSince(u.get('since_tag_categories'))
    const sto = parseSince(u.get('since_tag_options'))
    const sct = parseSince(u.get('since_card_tags'))

    try {
      // 6 stream を 1 tenant tx に包み、tx 冒頭で app.user_id を張る (RLS-P2)。
      // 単一 tx = 単一接続のため Promise.all の並列は接続競合を招く → 6 直列 await。
      // wire (response の cards/cursors 等) は不変。
      const { c, e, t, tc, to, ct } = await withTenantTx(
        user.id,
        async (tx) => {
          const c = await getCardsDelta(user.id, tx, sc)
          const e = await getExamsDelta(user.id, tx, se)
          const t = await getTombstonesDelta(user.id, tx, st)
          const tc = await getCategoriesDelta(user.id, tx, stc)
          const to = await getOptionsDelta(user.id, tx, sto)
          const ct = await getCardTagsDelta(user.id, tx, sct)
          return { c, e, t, tc, to, ct }
        },
      )
      return Response.json(
        {
          cards: c.rows,
          exams: e.rows,
          tombstones: t.rows,
          tag_categories: tc.rows,
          tag_options: to.rows,
          card_tags: ct.rows,
          cursors: {
            cards: c.maxUpdatedAt,
            exams: e.maxUpdatedAt,
            tombstone: t.maxDeletedAt,
            tag_categories: tc.maxUpdatedAt,
            tag_options: to.maxUpdatedAt,
            card_tags: ct.maxCreatedAt,
          },
        },
        { status: 200, headers },
      )
    } catch (err) {
      logger.warn({ event: 'api.pull.failed', userId: user.id, err })
      return Response.json({ error: 'internal' }, { status: 500, headers })
    }
  },
)
