// card-tags-pull — server card_tags テーブルから client (Dexie) 用の
// ClientCardTag shape (snake_case + ISO8601 文字列) に変換した差分を取得する
// server-only module。 統合 `/api/pull` の delta 入口を提供する (Tag-2b)。
//
// 役割境界:
// - getCardTagsDelta: tenant 絞り込み + Drizzle SELECT の唯一の入口
//   (tag-categories-pull / tag-options-pull と同 pattern)。
//   card_tags は updated_at を持たない junction なので cursor は created_at base。
//
// 同期穴の補完 (案 a):
//   関連付けのみ外す `[A,B] → []` の場合、 card_tags 増分には何も載らない。
//   このギャップは pull 側で「cards.updated_at bump 起点の取り直し」 で塞ぐ
//   (書込側が cards.updated_at を bump → pull 経路が変更カードの旧 card_tags を
//   削除してから当該カードぶんの新集合を upsert する)。 本 file は単純な増分のみ。

import 'server-only'

import { and, eq, gte, SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { cardTags } from './schema'
import type { ClientCardTag } from '@/lib/client-db'
import { maxIso } from './max-iso'

type CardTagRow = typeof cardTags.$inferSelect

export function toClientCardTag(row: CardTagRow): ClientCardTag {
  return {
    card_id: row.cardId,
    option_id: row.optionId,
    user_id: row.userId,
    created_at: row.createdAt.toISOString(),
  }
}

export async function getCardTagsDelta(
  userId: string,
  since?: Date,
): Promise<{ rows: ClientCardTag[]; maxCreatedAt: string | null }> {
  const db = getDb()
  const conds: SQL[] = [eq(cardTags.userId, userId)]
  if (since) conds.push(gte(cardTags.createdAt, since))
  const rows = (await db.select().from(cardTags).where(and(...conds))).map(
    toClientCardTag,
  )
  return { rows, maxCreatedAt: maxIso(rows.map((r) => r.created_at)) }
}
