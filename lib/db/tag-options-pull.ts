// tag-options-pull — server tag_options テーブルから client (Dexie) 用の
// ClientTagOption shape (snake_case + ISO8601 文字列) に変換した差分を取得する
// server-only module。 統合 `/api/pull` の delta 入口を提供する。
//
// 役割境界:
// - getOptionsDelta: tenant 絞り込み + Drizzle SELECT の唯一の入口
//   (tag-categories-pull と同 pattern)。

import 'server-only'

import { and, eq, gte, SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { tagOptions } from './schema'
import type { ClientTagOption } from '@/lib/client-db'
import { maxIso } from './max-iso'

type TagOptionRow = typeof tagOptions.$inferSelect

export function toClientTagOption(row: TagOptionRow): ClientTagOption {
  return {
    id: row.id,
    user_id: row.userId,
    category_id: row.categoryId,
    name: row.name,
    color: row.color,
    sort_key: row.sortKey,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export async function getOptionsDelta(
  userId: string,
  since?: Date,
): Promise<{ rows: ClientTagOption[]; maxUpdatedAt: string | null }> {
  const db = getDb()
  const conds: SQL[] = [eq(tagOptions.userId, userId)]
  if (since) conds.push(gte(tagOptions.updatedAt, since))
  const rows = (await db.select().from(tagOptions).where(and(...conds))).map(
    toClientTagOption,
  )
  return { rows, maxUpdatedAt: maxIso(rows.map((r) => r.updated_at)) }
}
