// tag-categories-pull — server tag_categories テーブルから client (Dexie) 用の
// ClientTagCategory shape (snake_case + ISO8601 文字列) に変換した差分を取得する
// server-only module。 統合 `/api/pull` の delta 入口を提供する。
//
// 役割境界:
// - getCategoriesDelta: tenant 絞り込み + Drizzle SELECT の唯一の入口。 ここで
//   `WHERE user_id` を強制し、 呼出側が条件を忘れて全 user を覗ける事故を防ぐ
//   (cards-pull / exams-pull と同 pattern)。

import 'server-only'

import { tagCategories } from './schema'
import type { ClientTagCategory } from '@/lib/client-db'
import { getDeltaRows } from './pull-delta'

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
  const { rows, max } = await getDeltaRows(
    {
      table: tagCategories,
      userIdCol: tagCategories.userId,
      cursorCol: tagCategories.updatedAt,
      mapper: toClientTagCategory,
      cursorValueOf: (r) => r.updated_at,
    },
    userId,
    since,
  )
  return { rows, maxUpdatedAt: max }
}
