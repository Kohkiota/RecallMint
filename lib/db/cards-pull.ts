// cards-pull — server cards テーブルから client (Dexie) 用の ClientCard shape
// (snake_case + ISO8601 文字列) に変換した差分を取得する server-only module。
// 統合 `/api/pull` の delta 入口を提供する。
//
// 役割境界:
// - getCardsDelta: tenant 絞り込み + Drizzle SELECT の唯一の入口。 ここで
//   `WHERE user_id` を強制し、 呼出側が条件を忘れて全 user を覗ける事故を防ぐ。
// - pure mapper (toClientCard / toCard) は `./cards-mapper` に切り出し済。 client
//   component から型変換だけ使いたい場合はそちらを直接 import すること。

import 'server-only'

import { cards } from './schema'
import type { ClientCard } from '@/lib/client-db'
import { toClientCard } from './cards-mapper'
import { getDeltaRows } from './pull-delta'
import type { TenantDb } from './tenant-tx'

export async function getCardsDelta(
  userId: string,
  dbc: TenantDb,
  since?: Date,
): Promise<{ rows: ClientCard[]; maxUpdatedAt: string | null }> {
  const { rows, max } = await getDeltaRows(
    {
      table: cards,
      userIdCol: cards.userId,
      cursorCol: cards.updatedAt,
      mapper: toClientCard,
      cursorValueOf: (r) => r.updated_at,
    },
    userId,
    dbc,
    since,
  )
  return { rows, maxUpdatedAt: max }
}
