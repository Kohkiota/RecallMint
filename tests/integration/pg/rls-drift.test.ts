// RLS-P3 hardening (Task 6): policy drift-detection (選択肢 B)。
// versioned SQL (db/policies/{rls-p2,rls-p3-wave1,rls-p3-wave2}-enable.sql) と実 DB の
// RLS 状態が乖離していないかを実 PG catalog で検出する。global-setup が migrate +
// grants + 3 enable SQL を適用済ゆえ、本 test はその適用結果 (= repo SQL が作った RLS
// 状態) を hardcoded な期待カタログ (独立 oracle) と突き合わせる。
//
// 選択肢 B の意味: policy は drizzle migration に昇格せず versioned SQL のまま置く
// (spec §2.9 の「enablement を deploy から分離・operator 手動適用」を守るため)。その
// 代償として「SQL と実 DB がズレていないか」の保証が要る — それが本 drift test。
//
// **name+cmd だけでは不十分** (Codex#4.1/#4.2): 誤 predicate (例 USING (true)) は policy 名も
// cmd も変えずに tenant 境界を無効化しうる。ゆえに (roles, cmd, permissive, qual, with_check)
// の**全定義**を突合する。qual/with_check は PG が式を正規化して pg_policies に格納するため、
// 実 DB が返す正規化テキストをそのまま期待値として pin する (下記 *_PRED 定数は PG17 実測)。
//
// **範囲の限界** (Codex#4.4): 本 test が保証するのは「repo の enable SQL ↔ test DB」の整合
// のみ。stg/prod で operator が手動適用した後に誰かが直接 policy をいじる「手動適用 drift」は
// 検出できない — それは runbook §12 の operator 用 readback SQL が担う。app_current_user_id()
// 関数本体の drift は rls-functions.test.ts が behavioral に担保する (Codex#4.5)。
//
// 期待カタログを db/policies から生成せず hardcode するのは意図 (Codex#4.3): SQL と test が
// 同じ SSoT を読むと「両方同時にズレる」盲点が生じる。fixture-completeness.test.ts の三者一致と
// 同思想で、独立した第二の記述 (この file) を照合軸にする。二重管理の drift は review で守る。
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeFixtureOwnerDb, getFixtureOwnerDb } from './setup/fixture'

// --- 期待カタログ (独立 oracle・PG17 で正規化テキストを実測して pin) ---

// tenant 共通形述語: `user_id = (SELECT public.app_current_user_id())` を PG が正規化した形。
const TENANT_PRED = '(user_id = ( SELECT app_current_user_id() AS app_current_user_id))'
// users 用述語: 主キーが id ゆえ `id = (SELECT app_current_user_id())`。
const USERS_ID_PRED = '(id = ( SELECT app_current_user_id() AS app_current_user_id))'
// users の SELECT/UPDATE USING: 上に `AND deleted_at IS NULL` が付く (退会済を app-role から隠す)。
const USERS_LIVE_PRED =
  '((id = ( SELECT app_current_user_id() AS app_current_user_id)) AND (deleted_at IS NULL))'

// 共通形 17 表 (P2 4 + Wave1 8 + Wave2 5)。各表ちょうど 1 policy `<table>_tenant`
// (FOR ALL・TO recallmint_app・USING=WITH CHECK=TENANT_PRED)。
const COMMON_FORM_RLS_TABLES = [
  // P2 共通形 4
  'exams',
  'cards',
  'tombstones',
  'study_days',
  // Wave 1 (8)
  'reviews',
  'answer_events',
  'tag_categories',
  'tag_options',
  'card_tags',
  'entity_mutations',
  'card_asset_refs',
  'ai_usage_users',
  // Wave 2 (5)
  'study_sessions',
  'user_settings',
  'assets',
  'source_documents',
  'upload_records',
  // ②-4a Phase A Task 1-3
  'source_assets',
  'upload_operations',
  'asset_derivations',
] as const

// RLS 対象 21 表 = 共通形 20 + users (per-command 特殊)。
const EXPECTED_RLS_TABLES: readonly string[] = [
  ...COMMON_FORM_RLS_TABLES,
  'users',
]

// RLS 非対象 5 表: relrowsecurity=false かつ policy ゼロ。
const EXPECTED_NON_RLS_TABLES: readonly string[] = [
  'ai_usage',
  'stripe_events',
  'clerk_events',
  'contact_messages',
  'integration_failures',
]

type PolicyTuple = {
  roles: string[]
  cmd: string
  permissive: string
  qual: string | null
  with_check: string | null
}

// 期待 policy カタログ: key = `${tablename}|${policyname}`。
// 共通形 20 + users 3 = 23 policy。
const EXPECTED_POLICIES: Record<string, PolicyTuple> = {}
for (const table of COMMON_FORM_RLS_TABLES) {
  EXPECTED_POLICIES[`${table}|${table}_tenant`] = {
    roles: ['recallmint_app'],
    cmd: 'ALL',
    permissive: 'PERMISSIVE',
    qual: TENANT_PRED,
    with_check: TENANT_PRED,
  }
}
// users: per-command・DELETE policy なし (= app-role の users hard delete を構造的 deny)。
EXPECTED_POLICIES['users|users_select'] = {
  roles: ['recallmint_app'],
  cmd: 'SELECT',
  permissive: 'PERMISSIVE',
  qual: USERS_LIVE_PRED,
  with_check: null,
}
EXPECTED_POLICIES['users|users_insert'] = {
  roles: ['recallmint_app'],
  cmd: 'INSERT',
  permissive: 'PERMISSIVE',
  qual: null,
  with_check: USERS_ID_PRED,
}
EXPECTED_POLICIES['users|users_update'] = {
  roles: ['recallmint_app'],
  cmd: 'UPDATE',
  permissive: 'PERMISSIVE',
  qual: USERS_LIVE_PRED,
  with_check: USERS_ID_PRED,
}

type PolicyRow = {
  tablename: string
  policyname: string
  roles: string[]
  cmd: string
  permissive: string
  qual: string | null
  with_check: string | null
}

type RelRow = {
  relname: string
  relrowsecurity: boolean
  relforcerowsecurity: boolean
}

describe('RLS policy drift-detection (versioned SQL ↔ test DB integrity)', () => {
  let policyRows: PolicyRow[]
  let relRows: RelRow[]

  beforeAll(async () => {
    // owner 接続で catalog を読む (pg_policies / pg_class は DDL を映すため row DML や
    // SET context の影響を受けない。他 test file が先に走っても policy 状態は不変)。
    const db = getFixtureOwnerDb()
    policyRows = await db.execute<PolicyRow>(
      sql`SELECT tablename, policyname, roles, cmd, permissive, qual, with_check
          FROM pg_policies WHERE schemaname = 'public'`,
    )
    relRows = await db.execute<RelRow>(
      sql`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    )
  })

  afterAll(async () => {
    await closeFixtureOwnerDb()
  })

  // 期待カタログ自体の内部整合を守る (この file の編集ミスで oracle が壊れるのを防ぐ)。
  it('expected catalog is internally consistent (21 RLS tables, 23 policies)', () => {
    expect(EXPECTED_RLS_TABLES).toHaveLength(21)
    expect(EXPECTED_NON_RLS_TABLES).toHaveLength(5)
    expect(Object.keys(EXPECTED_POLICIES)).toHaveLength(23)
  })

  // 1. relrowsecurity / relforcerowsecurity: 18 対象 true / 5 非対象 false /
  //    意図しない表が true でない / FORCE は全 public 表で false (owner bypass 不変条件)。
  it('relrowsecurity matches the 18-RLS / 5-non-RLS split; forcerowsecurity off everywhere', () => {
    const byName = new Map(relRows.map((r) => [r.relname, r]))

    for (const table of EXPECTED_RLS_TABLES) {
      expect(byName.get(table)?.relrowsecurity, `${table} should have RLS enabled`).toBe(
        true,
      )
    }
    for (const table of EXPECTED_NON_RLS_TABLES) {
      expect(
        byName.get(table)?.relrowsecurity,
        `${table} should NOT have RLS enabled`,
      ).toBe(false)
    }

    // 意図しない表が relrowsecurity=true になっていないこと (全 public 表を diff)。
    const actualRlsOn = relRows
      .filter((r) => r.relrowsecurity)
      .map((r) => r.relname)
      .sort()
    expect(actualRlsOn).toEqual([...EXPECTED_RLS_TABLES].sort())

    // FORCE RLS は全 public 表で false (owner が seed/migrate/operator を素通しする前提)。
    const forced = relRows.filter((r) => r.relforcerowsecurity).map((r) => r.relname)
    expect(forced).toEqual([])
  })

  // 2. pg_policies の全 tuple が期待カタログと完全一致 (name+cmd でなく全定義)。
  //    qual/with_check の正規化テキスト一致が「誤 predicate は green にならない」保証の中核。
  it('every policy tuple matches the expected catalog exactly (roles/cmd/permissive/qual/with_check)', () => {
    const actual = new Map(
      policyRows.map((r) => [`${r.tablename}|${r.policyname}`, r]),
    )
    for (const [key, expected] of Object.entries(EXPECTED_POLICIES)) {
      const got = actual.get(key)
      expect(got, `expected policy ${key} to exist`).toBeDefined()
      if (!got) continue
      expect(got.roles, `${key} roles`).toEqual(expected.roles)
      expect(got.cmd, `${key} cmd`).toBe(expected.cmd)
      expect(got.permissive, `${key} permissive`).toBe(expected.permissive)
      expect(got.qual, `${key} qual`).toBe(expected.qual)
      expect(got.with_check, `${key} with_check`).toBe(expected.with_check)
    }
  })

  // 3. (table, policy) の全集合が期待カタログと完全一致 = 余計な / 不正な policy が
  //    どこにも無い (非対象 5 表に policy が付いていないことも同時に保証)。
  it('the full set of (table, policy) equals the expected catalog — no rogue/extra policy', () => {
    const actualKeys = policyRows
      .map((r) => `${r.tablename}|${r.policyname}`)
      .sort()
    const expectedKeys = Object.keys(EXPECTED_POLICIES).sort()
    expect(actualKeys).toEqual(expectedKeys)
  })

  // 4. 全 policy の role は recallmint_app のみ (別 role・PUBLIC 混入を検出)。
  it('recallmint_app is the only role in every policy', () => {
    for (const r of policyRows) {
      expect(r.roles, `${r.tablename}.${r.policyname} roles`).toEqual([
        'recallmint_app',
      ])
    }
  })

  // 5. users に DELETE を覆う policy が無い (FOR ALL も FOR DELETE も不在 = hard delete deny)。
  it('users has no DELETE-capable policy; exactly the 3 per-command policies exist', () => {
    const usersCmds = policyRows
      .filter((r) => r.tablename === 'users')
      .map((r) => r.cmd)
    for (const cmd of usersCmds) {
      expect(['ALL', 'DELETE'], `users must not have a ${cmd} policy`).not.toContain(
        cmd,
      )
    }
    expect(usersCmds.sort()).toEqual(['INSERT', 'SELECT', 'UPDATE'])
  })
})
