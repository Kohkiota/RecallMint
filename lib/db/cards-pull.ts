// cards-pull — server cards テーブルから user 全 cards を取得し、 client (Dexie)
// 用の ClientCard shape (snake_case + ISO8601 文字列) に変換する server-only module。
// S-local-2 Task 2 で `/api/cards/pull` route が利用する。
//
// 役割境界:
// - getAllCardsForUser: tenant 絞り込み + Drizzle SELECT の唯一の入口。 ここで
//   `WHERE user_id` を強制し、 呼出側が条件を忘れて全 user を覗ける事故を防ぐ。
// - pure mapper (toClientCard / toCard) は `./cards-mapper` に切り出し済。 client
//   component から型変換だけ使いたい場合はそちらを直接 import すること。 本ファイル
//   は backward compat のため re-export を提供する。

import 'server-only'

import { and, eq, gte, SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cards } from './schema'
import type { ClientCard } from '@/lib/client-db'
import { toClientCard } from './cards-mapper'
import { maxIso } from './max-iso'

export { toClientCard, toCard } from './cards-mapper'

export async function getAllCardsForUser(userId: string): Promise<ClientCard[]> {
  const db = getDb()
  const rows = await db.select().from(cards).where(eq(cards.userId, userId))
  return rows.map(toClientCard)
}

export async function getCardsDelta(
  userId: string,
  since?: Date,
): Promise<{ rows: ClientCard[]; maxUpdatedAt: string | null }> {
  const db = getDb()
  const conds: SQL[] = [eq(cards.userId, userId)]
  if (since) conds.push(gte(cards.updatedAt, since))
  const rows = (await db.select().from(cards).where(and(...conds))).map(toClientCard)
  return { rows, maxUpdatedAt: maxIso(rows.map((r) => r.updated_at)) }
}
