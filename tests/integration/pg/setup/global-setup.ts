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

// RLS-P3 hardening: RLS 非対象 5 表 (ai_usage/stripe_events/clerk_events/
// contact_messages/integration_failures) の app-role grant を最小コマンドへ縮小する
// REVOKE 群。base grants (blanket ON ALL TABLES) の **直後** に owner で適用しないと
// REVOKE が blanket GRANT に上書きされ無効化するため、順序 (base → phase3) が固定。
const GRANTS_PHASE3_FILE = path.resolve(
  import.meta.dirname,
  '../../../../db/roles/recallmint_app-grants-phase3.sql',
)

// RLS-P2: 5 表 (users/exams/cards/tombstones/study_days) の policy 有効化 SQL。
// migration にしない (spec §2.9) ため、grants の直後に owner client で適用する。
// これで test:iso は毎 run RLS on で走る (= 「動く」の証明: spec §3.1-1)。
const RLS_ENABLE_FILE = path.resolve(
  import.meta.dirname,
  '../../../../db/policies/rls-p2-enable.sql',
)

// RLS-P3 Wave 1: 追加 8 表 (reviews/answer_events/tag_categories/tag_options/card_tags/
// entity_mutations/card_asset_refs/ai_usage_users) の policy 有効化 SQL。P2 と同機構で
// grants → p2-enable の直後に owner client で適用する (test:iso は毎 run Wave 1 も RLS on)。
const RLS_WAVE1_ENABLE_FILE = path.resolve(
  import.meta.dirname,
  '../../../../db/policies/rls-p3-wave1-enable.sql',
)

// RLS-P3 Wave 2: 軽配線 5 表 (study_sessions/user_settings/assets/source_documents/
// upload_records) の policy 有効化 SQL。Wave 1 と同機構で wave1-enable の直後に owner
// client で適用する (test:iso は毎 run Wave 2 も RLS on)。
const RLS_WAVE2_ENABLE_FILE = path.resolve(
  import.meta.dirname,
  '../../../../db/policies/rls-p3-wave2-enable.sql',
)

// ②-4a Phase A: 新設 tenant 表 (upload_operations / asset_derivations) の policy
// 有効化 SQL。Wave 2 と同機構で wave2-enable の直後に owner client で適用する
// (test:iso は毎 run 本 SQL も RLS on で走る)。
const RLS_OCR_2_4A_ENABLE_FILE = path.resolve(
  import.meta.dirname,
  '../../../../db/policies/ocr-2-4a-enable.sql',
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

    // RLS-P3 hardening: base grants の直後に非 RLS 5 表の grant 縮小 (REVOKE) を適用する
    // (同 owner client)。順序が絶対 — base の blanket GRANT を張った後でなければ REVOKE が
    // 意味を持たない。これで test:iso は毎 run 縮小後の grant で走る (= 42501 matrix が効く)。
    const grantsPhase3Sql = readFileSync(GRANTS_PHASE3_FILE, 'utf8')
    await client.unsafe(grantsPhase3Sql).simple()

    // RLS-P2: grants の直後に policy を有効化する (同 owner client)。owner は
    // FORCE RLS していないため policy を bypass する = 以降の seed/truncate は素通し。
    const rlsEnableSql = readFileSync(RLS_ENABLE_FILE, 'utf8')
    await client.unsafe(rlsEnableSql).simple()

    // RLS-P3 Wave 1: P2 enable の直後に追加 8 表の policy を有効化 (同 owner client)。
    const rlsWave1EnableSql = readFileSync(RLS_WAVE1_ENABLE_FILE, 'utf8')
    await client.unsafe(rlsWave1EnableSql).simple()

    // RLS-P3 Wave 2: Wave 1 enable の直後に軽配線 5 表の policy を有効化 (同 owner client)。
    const rlsWave2EnableSql = readFileSync(RLS_WAVE2_ENABLE_FILE, 'utf8')
    await client.unsafe(rlsWave2EnableSql).simple()

    // ②-4a Phase A: Wave 2 enable の直後に新設 tenant 表の policy を有効化 (同 owner client)。
    const rlsOcr24aEnableSql = readFileSync(RLS_OCR_2_4A_ENABLE_FILE, 'utf8')
    await client.unsafe(rlsOcr24aEnableSql).simple()
  } finally {
    await client.end({ timeout: 5 })
  }
}

export async function teardown(): Promise<void> {
  // setup が自前接続を finally で close 済、 test fork 側の getDb() 接続は各 test の
  // afterAll で closeDb() 済のため、 ここで追加 close する対象はない。 vitest の
  // globalSetup 契約に沿って明示 export する (残接続なしの確認点)。
}
