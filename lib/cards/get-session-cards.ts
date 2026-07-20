// get-session-cards — due card を全 exam 横断で取得する query。
//
// 全 exam 横断 (exam JOIN なし)。 archived_at 問わず。
// user_id で絞り込み (テナント分離必須)。
// due ASC で返すことで、 最も期限切れの古い card から学習できる。

import { and, asc, eq, lte } from 'drizzle-orm'
import { cards, type Card } from '@/lib/db/schema'
import type { TenantDb } from '@/lib/db/tenant-tx'

/**
 * 全 exam 横断で due <= now (デフォルト: 現在時刻) の card を
 * due ASC で limit 件取得して返す。
 *
 * @param userId  テナント識別子 (必須)
 * @param limit   session_limit (1 以上)。null = 上限なし (due 範囲内の全件を返す)
 * @param dbc     tenant context 下の接続ハンドル (withTenantTx 由来の tx)
 * @param now     due 判定基準時刻 (省略時は new Date())
 */
export async function getSessionCards(
  userId: string,
  limit: number | null,
  dbc: TenantDb,
  now?: Date,
): Promise<Card[]> {
  const db = dbc
  const threshold = now ?? new Date()
  const base = db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), lte(cards.due, threshold)))
    .orderBy(asc(cards.due))
  return limit === null ? await base : await base.limit(limit)
}
