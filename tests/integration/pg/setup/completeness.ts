// H2: 三者一致 completeness helper — user_id 保持 table 集合を 3 経路で導出する。
// 「検出器(schema introspect)と fixture が同じ漏れ方をする」盲点を塞ぐため、
// (1) Drizzle schema introspect / (2) 実 PG catalog / (3) 明示 hardcode の 3 者を
// test で突き合わせる (fixture-completeness.test.ts)。母集団は user_id 列を持つ 20 table。
import { is, sql } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'

import type { DB } from '@/lib/db'
import * as schema from '@/lib/db/schema'

// user_id 列を持つ 20 table の明示 list (三者一致の第 3 経路 = 独立した SSoT)。
// 非保持 = users(tenant 本体・PK は id)/ ai_usage / stripe_events / clerk_events。
export const EXPECTED_USER_ID_TABLES: readonly string[] = [
  'reviews',
  'ai_usage_users',
  'integration_failures',
  'exams',
  'cards',
  'source_documents',
  'upload_records',
  'study_days',
  'user_settings',
  'contact_messages',
  'study_sessions',
  'answer_events',
  'entity_mutations',
  'tag_categories',
  'tag_options',
  'card_tags',
  'tombstones',
  'assets',
  'card_asset_refs',
  'source_assets',
]

// Drizzle schema (lib/db/schema.ts) の pgTable 定義を introspect し、user_id 列を
// 持つ table 名集合を返す。schema の runtime export は pgTable のみ (型 export は
// erase 済) のため Object.values を is(PgTable) で絞って getTableConfig にかける。
export function userIdTablesFromSchema(): Set<string> {
  const names = new Set<string>()
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    if (config.columns.some((column) => column.name === 'user_id')) {
      names.add(config.name)
    }
  }
  return names
}

// 実 PG の information_schema から user_id 列を持つ public table 名集合を返す。
// schema introspect とは独立に実 catalog を引くことで、migration 適用漏れ・
// introspect と実 DB の乖離を検出する。
export async function userIdTablesFromCatalog(db: DB): Promise<Set<string>> {
  const rows = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.columns WHERE column_name = 'user_id' AND table_schema = 'public'`,
  )
  return new Set(rows.map((row) => row.table_name))
}
