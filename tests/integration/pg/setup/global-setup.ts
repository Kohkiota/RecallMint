import { readFileSync } from 'node:fs'
import path from 'node:path'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { TEST_DATABASE_URL, assertLocalTestDb } from './db-url'

// vitest は globalSetup を setupFiles より前に走らせる。 setupFiles の hard-set は
// この globalSetup を保護しないため、 冒頭で自前に guard する。 外部 env は参照せず
// 定数 TEST_DATABASE_URL のみを使う。
//
// migration folder は repo root の drizzle/migrations。 cwd 依存を避け file 位置基準で
// 絶対解決する (tests/integration/pg/setup → 4 階層上が repo root)。
const MIGRATIONS_FOLDER = path.resolve(
  import.meta.dirname,
  '../../../../drizzle/migrations',
)

// RLS-P1: least-privilege app role (recallmint_app) への grant 定義の SSoT。
// migrate 直後・owner client close 前に owner として同 DB へ適用する (毎回
// DROP/CREATE する recallmint_test は grant が残らないため、 test run ごとに要る)。
const GRANTS_FILE = path.resolve(
  import.meta.dirname,
  '../../../../db/roles/recallmint_app-grants.sql',
)

// DROP/CREATE DATABASE は対象 DB 自身に接続していると不可能なため、 同 host/port/user の
// maintenance DB (postgres) へ繋ぐ。 host/port は上の assertLocalTestDb で検証済 —
// db 名のみ postgres へ差し替える (別 host を作らない)。
function maintenanceUrl(): string {
  const u = new URL(TEST_DATABASE_URL)
  u.pathname = '/postgres'
  return u.toString()
}

export async function setup(): Promise<void> {
  assertLocalTestDb(TEST_DATABASE_URL)

  // provision: 残存 backend を切ってから DB を作り直す (前回 run の残骸を排除)。
  const maintenance = postgres(maintenanceUrl(), { max: 1, onnotice: () => {} })
  try {
    await maintenance`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'recallmint_test' AND pid <> pg_backend_pid()`
    // CREATE/DROP DATABASE は transaction block 内で走れないため simple protocol を使う。
    await maintenance.unsafe('DROP DATABASE IF EXISTS recallmint_test').simple()
    await maintenance.unsafe('CREATE DATABASE recallmint_test').simple()
  } finally {
    await maintenance.end({ timeout: 5 })
  }

  // migrate: drizzle-kit push でなく実 migration を忠実に適用する。
  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER })

    // grants: owner (postgres) として recallmint_app に least-privilege を付与する。
    // .simple() = simple query protocol で multi-statement SQL file を一括実行。
    const grantsSql = readFileSync(GRANTS_FILE, 'utf8')
    await client.unsafe(grantsSql).simple()
  } finally {
    await client.end({ timeout: 5 })
  }
}

export async function teardown(): Promise<void> {
  // setup が自前接続を finally で close 済、 test fork 側の getDb() 接続は各 test の
  // afterAll で closeDb() 済のため、 ここで追加 close する対象はない。 vitest の
  // globalSetup 契約に沿って明示 export する (残接続なしの確認点)。
}
