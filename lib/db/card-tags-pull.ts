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

import { and, eq, inArray } from 'drizzle-orm'

import { cardTags } from './schema'
import type { ClientCardTag } from '@/lib/client-db'
import { getDeltaRows } from './pull-delta'
import type { TenantDb } from './tenant-tx'

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
  dbc: TenantDb,
  since?: Date,
): Promise<{ rows: ClientCardTag[]; maxCreatedAt: string | null }> {
  const { rows, max } = await getDeltaRows(
    {
      table: cardTags,
      userIdCol: cardTags.userId,
      cursorCol: cardTags.createdAt, // card_tags は updated_at 非保持: cursor = createdAt
      mapper: toClientCardTag,
      cursorValueOf: (r) => r.created_at,
    },
    userId,
    dbc,
    since,
  )
  return { rows, maxCreatedAt: max }
}

// 変更 card の authoritative な card_tags 集合を返す (cursor 条件なし)。
// 返り値に cursor 材料 (max) を持たせないのは I-2 の構造的表現: cursors.card_tags は
// 増分 query の rows のみから算出し、この結果からは算出させない。
// eq(cardTags.userId, userId) は I-3 の第 1 層 (RLS は第 2 層であり省略の理由にならない)。
// cardIds が空でないことは caller の precondition (route は I-4(a) でそもそも呼ばない)。
// getDeltaRows は使わない: cursor 列を持たない別形の query。
export async function getCardTagsByCardIds(
  userId: string,
  dbc: TenantDb,
  cardIds: string[],
): Promise<ClientCardTag[]> {
  const db = dbc
  const rows = await db
    .select()
    .from(cardTags)
    .where(and(eq(cardTags.userId, userId), inArray(cardTags.cardId, cardIds)))
  return rows.map(toClientCardTag)
}
