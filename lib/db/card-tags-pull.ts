// card-tags-pull — server card_tags テーブルから client (Dexie) 用の
// ClientCardTag shape (snake_case + ISO8601 文字列) に変換して返す server-only
// module。 統合 `/api/pull` の card_tags read はすべてここを通る (Tag-2b)。
//
// read は 2 種 (役割が違う):
// - getCardTagsDelta: cursor 増分。 card_tags は updated_at を持たない junction ゆえ
//   cursor は created_at base (他 pull module と cursor 列だけ非対称)。
// - getCardTagsByCardIds: 変更 card ぶんの authoritative 集合 (cursor 条件なし)。
//
// 2 種要る理由: 関連付けのみ外す `[A,B] → []` は増分に何も載らないため、 client は
// cards.updated_at bump 起点で「変更 card の card_tags を全削除 → 応答で再構築」する。
// 削除する集合 (card 単位) と復元する集合 (cursor 単位) が別述語だと、 cursor より古い
// 行が恒久欠落する。 塞ぐのは route 側の合成で、 変更 card ぶんは増分側を捨てて by-card
// 側で置換する (union でなく replace)。 契約の正本 =
// docs/superpowers/specs/2026-08-17-card-tags-delta-completeness-design.md の I-1。

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
