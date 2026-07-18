import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'

// harness 検証: globalSetup が provision + migrate を終えた後、 real getDb() で public
// schema の table 一覧を引き、 必須 table 名が揃うこと (= 25 migration 適用) を確認する。
// 単なる count でなく必須 table 名で検証する (空 DB や部分適用を確実に落とす)。
describe('pg harness smoke', () => {
  afterAll(async () => {
    await closeDb()
  })

  it('applies migrations so required tables exist', async () => {
    const db = getDb()
    const rows = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const names = new Set(rows.map((r) => r.table_name))
    for (const required of [
      'users',
      'exams',
      'cards',
      'entity_mutations',
      'tombstones',
    ]) {
      expect(names.has(required)).toBe(true)
    }
  })
})
