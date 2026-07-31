// H2: 三者一致 completeness + 2 テナント fixture の行存在 assertion。
// これは後続 隔離 assertion(R1/R2/W1/W2)の vacuous green(WHERE が消えても餌が
// 無く空振り)を構造的に防ぐ backbone。三者一致で「検出器 と fixture が同じ漏れ方を
// する」盲点を塞ぎ、22 table A/B 行存在で「餌データが確かに置かれた」を保証する。
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '@/lib/db'

import {
  EXPECTED_USER_ID_TABLES,
  userIdTablesFromCatalog,
  userIdTablesFromSchema,
} from './setup/completeness'
import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

const EXPECTED_SORTED = [...EXPECTED_USER_ID_TABLES].sort()

function sorted(set: Set<string>): string[] {
  return [...set].sort()
}

// H1 規約: 各 PG test file は afterAll で closeDb() + closeFixtureOwnerDb()
// (接続リーク防止)。
afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

describe('user_id table three-way completeness', () => {
  it('Drizzle schema introspect === expected 22', () => {
    expect(sorted(userIdTablesFromSchema())).toEqual(EXPECTED_SORTED)
  })

  it('live PG catalog === expected 22', async () => {
    const catalog = await userIdTablesFromCatalog(getDb())
    expect(sorted(catalog)).toEqual(EXPECTED_SORTED)
  })

  it('Drizzle schema introspect === live PG catalog', async () => {
    const fromSchema = userIdTablesFromSchema()
    const catalog = await userIdTablesFromCatalog(getDb())
    expect(sorted(fromSchema)).toEqual(sorted(catalog))
  })
})

describe('two-tenant fixture row completeness', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    await truncateAllUserTables()
    fixture = await seedTwoTenants()
  })

  // A/B 双方の decoy 行存在を数える ground-truth 観測。RLS-P2: RLS 対象表
  // (exams/cards/tombstones/study_days) は app-role では単一 tenant しか見えず
  // 両テナントを 1 query で数えられないため、owner 接続 (RLS bypass) で数える。
  async function countForUser(table: string, userId: string): Promise<number> {
    const rows = await getFixtureOwnerDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE user_id = ${userId}::uuid`,
    )
    return rows[0].n
  }

  it('seeds distinct users for the two tenants', () => {
    expect(fixture.a.userId).not.toBe(fixture.b.userId)
  })

  it.each(EXPECTED_USER_ID_TABLES)(
    '%s has >=1 row for tenant A and tenant B',
    async (table) => {
      const a = await countForUser(table, fixture.a.userId)
      const b = await countForUser(table, fixture.b.userId)
      expect(a, `${table} tenant A rows`).toBeGreaterThanOrEqual(1)
      expect(b, `${table} tenant B rows`).toBeGreaterThanOrEqual(1)
    },
  )
})
