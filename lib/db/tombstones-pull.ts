// tombstones-pull — server tombstones テーブルから user の削除済 entity 差分を取得し、
// client 向け ClientTombstone shape に変換する。 S-delete-0 (§1 統合 /api/pull 向け)。
//
// getTombstonesDelta: WHERE user_id [AND deleted_at >= since] の tombstone を
// {rows, maxDeletedAt} で返す。 maxDeletedAt は next-cursor として呼出側が保持する。

import { and, eq, gte, SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { tombstones } from './schema'
import { maxIso } from './max-iso'

type TombstoneRow = typeof tombstones.$inferSelect

export type ClientTombstone = {
  entity_type: 'exam' | 'card'
  entity_id: string
  deleted_at: string
}

export function toClientTombstone(row: TombstoneRow): ClientTombstone {
  return {
    entity_type: row.entityType,
    entity_id: row.entityId,
    deleted_at: row.deletedAt.toISOString(), // Z 付き UTC ISO (maxIso の lexicographic 前提)
  }
}

export async function getTombstonesDelta(
  userId: string,
  since?: Date,
): Promise<{ rows: ClientTombstone[]; maxDeletedAt: string | null }> {
  const db = getDb()
  const conds: SQL[] = [eq(tombstones.userId, userId)]
  if (since) conds.push(gte(tombstones.deletedAt, since))
  const raw = await db.select().from(tombstones).where(and(...conds))
  const rows = raw.map(toClientTombstone)
  return { rows, maxDeletedAt: maxIso(rows.map((r) => r.deleted_at)) }
}
