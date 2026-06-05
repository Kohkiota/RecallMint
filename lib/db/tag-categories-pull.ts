// tag-categories-pull — server tag_categories テーブルから client (Dexie) 用の
// ClientTagCategory shape (snake_case + ISO8601 文字列) に変換した差分を取得する
// server-only module。 統合 `/api/pull` の delta 入口を提供する。
//
// 役割境界:
// - getCategoriesDelta: tenant 絞り込み + Drizzle SELECT の唯一の入口。 ここで
//   `WHERE user_id` を強制し、 呼出側が条件を忘れて全 user を覗ける事故を防ぐ
//   (cards-pull / exams-pull と同 pattern)。

import 'server-only'

import { and, eq, gte, SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { tagCategories } from './schema'
import type { ClientTagCategory } from '@/lib/client-db'
import { maxIso } from './max-iso'

type TagCategoryRow = typeof tagCategories.$inferSelect

export function toClientTagCategory(row: TagCategoryRow): ClientTagCategory {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    select_type: row.selectType,
    color: row.color,
    sort_key: row.sortKey,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export async function getCategoriesDelta(
  userId: string,
  since?: Date,
): Promise<{ rows: ClientTagCategory[]; maxUpdatedAt: string | null }> {
  const db = getDb()
  const conds: SQL[] = [eq(tagCategories.userId, userId)]
  if (since) conds.push(gte(tagCategories.updatedAt, since))
  const rows = (await db.select().from(tagCategories).where(and(...conds))).map(
    toClientTagCategory,
  )
  return { rows, maxUpdatedAt: maxIso(rows.map((r) => r.updated_at)) }
}
