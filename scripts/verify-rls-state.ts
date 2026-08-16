// verify-rls-state — 実環境(stg / prod)の RLS 状態を app role 接続で検証する
// read-only operator ツール(S-0・2026-08-04)。
//
// 背景: `tests/integration/pg/rls-drift.test.ts` は期待カタログと実 DB を突合するが、
// 実行先が `setup/db-url.ts` の `assertLocalTestDb` で **local iso PG に固定**されて
// いるため、stg / prod の drift(適用漏れ・手動改変)を構造的に検出できない。2026-08-04 に
// stg で ②-4a Phase A が新設した 3 表(うち 1 表は S-5 で drop 済)が
// **RLS 未適用**のまま運用されていたのを手動 SQL で偶然検出した実績がある
// (`docs/audit/2026-08-04-stg-rls-remediation-verification.md`)。本 script はその手動 SQL の
// 製品化 = runbook §12.1(policy drift 監査)+ §11.2(grant readback)を 1 コマンドにしたもの。
//
// ## 期待カタログの SSoT
// 本 file が期待カタログの**正本**で、drift test が本 file から import する(逆向きは
// 不可 — `.test.ts` を script から import すると vitest の describe/it が import 時に
// 実行され CLI が落ちる)。drift test の設計意図「期待カタログを db/policies から生成せず
// 独立した第二の記述として持つ」は保たれる — 独立性の相手は **`db/policies/*.sql`** で
// あって別の検査器ではないため、置き場所が移るだけで oracle の性質は変わらない。
//
// ## app role 専用(fail-closed)
// owner(postgres)接続では policy が素通しになり **false-green を生む**ため、
// `current_user` が app role でない / superuser / BYPASSRLS を持つ場合は検証せず中断する。
//
// ## 決定的証拠と、その裏返し(raise しなかった時の意味)
// 決定的な証拠 = **no-context probe**: tenant 表を context 無しで読むと policy 述語の
// `app_current_user_id()` が P0RLS を raise する(`drizzle/migrations/0025_rls_p2_functions.sql:11-22`)。
// raise した = qual が実際に評価された = policy が効いている、と断定できる。
//
// **raise しなかった場合は「空表」と断定できない**(canonical review Minor#A・PG17 実測):
// raise の有無は行数ではなく **実行計画依存**で、同じ空表でも index scan(InitPlan を
// scan 開始時に取得)では raise し、seq scan(行ごとに filter 評価)では raise しない。
// ゆえに「raise しなかった」= ①qual は attach されているが評価されなかった(空表 + seq scan)
// ②**そもそも qual が attach されていない(= RLS 未適用)** の両方を含む。①②は行数からは
// 区別できないため、本 script は raise 無しを **PASS の根拠にしない**(判定不能として明示し、
// **カタログ突合の結果で判断させる**)。カタログ突合は行の有無に依らず必ず判定する。
//
// 注: 2026-08-04 の stg 観測(空の asset_derivations が 0 行を返した)は当時この表に
// **RLS が未適用**だった状態のもので、「空表だから raise しない」の実証ではない(②の実例)。
//
// ## 実行(接続文字列は operator が渡す。本 script は .env を読まない)
//   RLS_VERIFY_DATABASE_URL='postgresql://recallmint_app:...@host:6543/postgres' \
//     pnpm tsx scripts/verify-rls-state.ts [--user <uuid>] [--user <uuid>]
//   (`--env-file=.env.local` 経由で `DATABASE_URL_APP` を使う運用も可 — 下記 resolveUrl)
//
// ## exit code
//   0 = カタログ突合 合格(実効検証は PASS か判定不能。判定不能でも 0 = 「壊れている」証拠は無い)
//   1 = カタログ不一致 または 実効検証 FAIL(= tenant 境界が効いていない証拠あり)
//   2 = 前提エラー(接続文字列なし / app role でない / 接続失敗)= 検証していない
//
// read-only: SELECT と `set_config(..., true)`(tx local)のみ。DDL / DML は一切行わない。

import postgres from 'postgres'

// ---------------------------------------------------------------------------
// 期待カタログ(SSoT。PG17 で正規化されたテキストを実測して pin)
// ---------------------------------------------------------------------------

/** tenant 共通形述語: `user_id = (SELECT public.app_current_user_id())` の正規化形。 */
export const TENANT_PRED = '(user_id = ( SELECT app_current_user_id() AS app_current_user_id))'
/** users 用述語: 主キーが id ゆえ `id = (SELECT app_current_user_id())`。 */
export const USERS_ID_PRED = '(id = ( SELECT app_current_user_id() AS app_current_user_id))'
/** users の SELECT/UPDATE USING: 退会済を app-role から隠すため deleted_at 条件が付く。 */
export const USERS_LIVE_PRED =
  '((id = ( SELECT app_current_user_id() AS app_current_user_id)) AND (deleted_at IS NULL))'

/**
 * 共通形 RLS 表(各表ちょうど 1 policy `<table>_tenant`・FOR ALL・TO recallmint_app・
 * USING = WITH CHECK = TENANT_PRED)。P2 4 + Wave1 7 + Wave2 4 + ②-4a 2 + R0 Task 1 1。
 */
export const COMMON_FORM_RLS_TABLES = [
  // P2 共通形 4
  'exams',
  'cards',
  'tombstones',
  'study_days',
  // Wave 1 (7)
  'answer_events',
  'tag_categories',
  'tag_options',
  'card_tags',
  'entity_mutations',
  'card_asset_refs',
  'ai_usage_users',
  // Wave 2 (4)
  'user_settings',
  'assets',
  'source_documents',
  'upload_records',
  // ②-4a Phase A Task 2-3(Task 1 の 1 表は S-5 / migration 0032 で drop 済)
  'upload_operations',
  'asset_derivations',
  // R0 Task 1 (ReviewLog 持続化): ts-fsrs ReviewLog 永続化表
  'review_logs',
] as const

/** RLS 対象表 = 共通形 + users(per-command 特殊)。 */
export const EXPECTED_RLS_TABLES: readonly string[] = [...COMMON_FORM_RLS_TABLES, 'users']

/** RLS 非対象表: relrowsecurity=false かつ policy ゼロ(command-level GRANT が唯一の防壁)。 */
export const EXPECTED_NON_RLS_TABLES: readonly string[] = [
  'ai_usage',
  'stripe_events',
  'clerk_events',
  'contact_messages',
  'integration_failures',
]

export type PolicyTuple = {
  roles: string[]
  cmd: string
  permissive: string
  qual: string | null
  with_check: string | null
}

/** 期待 policy カタログ: key = `${tablename}|${policyname}`。共通形 18 + users 3 = 21。 */
export const EXPECTED_POLICIES: Record<string, PolicyTuple> = {}
for (const table of COMMON_FORM_RLS_TABLES) {
  EXPECTED_POLICIES[`${table}|${table}_tenant`] = {
    roles: ['recallmint_app'],
    cmd: 'ALL',
    permissive: 'PERMISSIVE',
    qual: TENANT_PRED,
    with_check: TENANT_PRED,
  }
}
// users: per-command。DELETE policy が無いこと自体が app-role の hard delete を構造的に deny する。
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

/**
 * 期待 grant(app role)。RLS 対象表 = base grants の blanket CRUD。非 RLS 5 表 =
 * `db/roles/recallmint_app-grants-phase3.sql` の縮小後。runbook §11.2 readback matrix の実装。
 * 挙動(42501)の証明は `tests/integration/pg/grant-narrowing.test.ts` が別に担う —
 * 本 catalog は「実 DB の GRANT が縮小後の形か」の readback であり役割が違う。
 */
export const EXPECTED_GRANTS: Record<string, readonly string[]> = {}
for (const table of EXPECTED_RLS_TABLES) {
  EXPECTED_GRANTS[table] = ['DELETE', 'INSERT', 'SELECT', 'UPDATE']
}
EXPECTED_GRANTS['contact_messages'] = ['DELETE', 'INSERT', 'SELECT']
EXPECTED_GRANTS['integration_failures'] = ['INSERT']
EXPECTED_GRANTS['stripe_events'] = ['INSERT', 'SELECT']
EXPECTED_GRANTS['clerk_events'] = ['INSERT', 'SELECT']
EXPECTED_GRANTS['ai_usage'] = ['INSERT', 'SELECT', 'UPDATE']

// oracle は import 側から書き換えられてはならない(canonical review Minor#11)。
// **浅い freeze では意味がない**(同 Minor#B): 封じたいのは「期待 qual を `true` に緩めて
// comparePolicies に何でも通させる」改変であり、それは入れ子の tuple 側にある。配列も
// push で表を足せてしまうため、値まで再帰的に凍らせる。
Object.freeze(COMMON_FORM_RLS_TABLES)
Object.freeze(EXPECTED_RLS_TABLES)
Object.freeze(EXPECTED_NON_RLS_TABLES)
for (const tuple of Object.values(EXPECTED_POLICIES)) {
  Object.freeze(tuple.roles)
  Object.freeze(tuple)
}
Object.freeze(EXPECTED_POLICIES)
for (const privileges of Object.values(EXPECTED_GRANTS)) Object.freeze(privileges)
Object.freeze(EXPECTED_GRANTS)

/** app runtime の接続 role。これ以外での実行は false-green ゆえ拒否する。 */
export const APP_ROLE = 'recallmint_app'

/** 実在しない tenant を表す context(全ゼロ uuid)。どの user もこの id を持たない。 */
export const BOGUS_CONTEXT = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------------------
// pure: 突合ロジック(DB なしで unit test できるよう I/O から分離)
// ---------------------------------------------------------------------------

export type RelRow = {
  relname: string
  relrowsecurity: boolean
  relforcerowsecurity: boolean
}

export type PolicyRow = PolicyTuple & {
  tablename: string
  policyname: string
}

export type GrantRow = { table_name: string; privilege_type: string }

/** 検出事項 1 件。空配列 = 合格。 */
export type Finding = { area: 'rls' | 'policy' | 'grant'; subject: string; detail: string }

/** RLS 有効/無効の集合と FORCE の有無を期待カタログと突合する。 */
export function compareRlsTables(actual: readonly RelRow[]): Finding[] {
  const findings: Finding[] = []
  const byName = new Map(actual.map((r) => [r.relname, r]))

  for (const table of EXPECTED_RLS_TABLES) {
    const row = byName.get(table)
    if (!row) {
      findings.push({ area: 'rls', subject: table, detail: '表が存在しない(migration 未適用の疑い)' })
      continue
    }
    if (!row.relrowsecurity) {
      findings.push({ area: 'rls', subject: table, detail: 'RLS が無効(enable SQL 未適用の疑い)' })
    }
    if (row.relforcerowsecurity) {
      // FORCE を張ると owner(migrate/seed/operator)まで policy に縛られる。設計は非 FORCE。
      findings.push({ area: 'rls', subject: table, detail: 'FORCE RLS が有効(設計は非 FORCE)' })
    }
  }

  for (const table of EXPECTED_NON_RLS_TABLES) {
    const row = byName.get(table)
    if (!row) {
      findings.push({ area: 'rls', subject: table, detail: '表が存在しない' })
      continue
    }
    if (row.relrowsecurity) {
      findings.push({ area: 'rls', subject: table, detail: 'RLS 非対象表なのに RLS が有効' })
    }
  }

  // カタログ外の表が RLS on = 想定外(新表追加時にカタログ更新が漏れている)。
  const known = new Set([...EXPECTED_RLS_TABLES, ...EXPECTED_NON_RLS_TABLES])
  for (const row of actual) {
    if (!known.has(row.relname) && row.relrowsecurity) {
      findings.push({ area: 'rls', subject: row.relname, detail: 'カタログ外の表が RLS on(カタログ更新漏れ)' })
    }
  }

  return findings
}

/** policy 全定義(roles/cmd/permissive/qual/with_check)を期待カタログと突合する。 */
export function comparePolicies(actual: readonly PolicyRow[]): Finding[] {
  const findings: Finding[] = []
  const actualByKey = new Map(actual.map((p) => [`${p.tablename}|${p.policyname}`, p]))

  for (const [key, expected] of Object.entries(EXPECTED_POLICIES)) {
    const got = actualByKey.get(key)
    if (!got) {
      findings.push({ area: 'policy', subject: key, detail: 'policy が存在しない' })
      continue
    }
    const diffs: string[] = []
    if (got.roles.join(',') !== expected.roles.join(',')) {
      diffs.push(`roles: ${JSON.stringify(got.roles)} != ${JSON.stringify(expected.roles)}`)
    }
    if (got.cmd !== expected.cmd) diffs.push(`cmd: ${got.cmd} != ${expected.cmd}`)
    if (got.permissive !== expected.permissive) {
      diffs.push(`permissive: ${got.permissive} != ${expected.permissive}`)
    }
    if (got.qual !== expected.qual) diffs.push(`qual: ${String(got.qual)} != ${String(expected.qual)}`)
    if (got.with_check !== expected.with_check) {
      diffs.push(`with_check: ${String(got.with_check)} != ${String(expected.with_check)}`)
    }
    if (diffs.length > 0) findings.push({ area: 'policy', subject: key, detail: diffs.join(' / ') })
  }

  for (const key of actualByKey.keys()) {
    if (!(key in EXPECTED_POLICIES)) {
      findings.push({ area: 'policy', subject: key, detail: 'カタログに無い policy が存在する' })
    }
  }

  return findings
}

/** app role の GRANT を期待カタログと突合する(runbook §11.2 readback の実装)。 */
export function compareGrants(actual: readonly GrantRow[]): Finding[] {
  const findings: Finding[] = []
  const byTable = new Map<string, Set<string>>()
  for (const row of actual) {
    const set = byTable.get(row.table_name) ?? new Set<string>()
    set.add(row.privilege_type)
    byTable.set(row.table_name, set)
  }

  for (const [table, expected] of Object.entries(EXPECTED_GRANTS)) {
    // 期待集合との完全一致で見る(過剰 grant = 縮小の巻き戻し・不足 = 経路が 42501 で壊れる)。
    const got = [...(byTable.get(table) ?? new Set<string>())].sort()
    const want = [...expected].sort()
    if (got.join(',') !== want.join(',')) {
      findings.push({
        area: 'grant',
        subject: table,
        detail: `[${got.join(',') || '(なし)'}] != 期待 [${want.join(',')}]`,
      })
    }
  }

  // カタログ外の表に app role の grant が付いている = 見逃してはならない(Codex P2)。
  // base grants の `ALTER DEFAULT PRIVILEGES`(db/roles/recallmint_app-grants.sql:5-6)により
  // **新設表には自動で blanket CRUD が付く**ため、カタログ更新を忘れた新表は「RLS も無く
  // grant だけフルにある」状態で素通りしうる — 2026-08-04 に ②-4a の 3 表で実際に起きた
  // 事象と同じ形。期待側の走査だけでは構造的に検出できないので実測側からも走査する。
  for (const table of byTable.keys()) {
    if (!(table in EXPECTED_GRANTS)) {
      const got = [...(byTable.get(table) ?? new Set<string>())].sort()
      findings.push({
        area: 'grant',
        subject: table,
        detail: `カタログ外の表に app role grant [${got.join(',')}] が付いている(新表のカタログ更新漏れ)`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// pure: 実効検証の判定
// ---------------------------------------------------------------------------

/** context 無しで tenant 表を読んだ結果。 */
export type NoContextProbe = {
  table: string
  /** policy 述語の app_current_user_id() が P0RLS を raise した = RLS が実効で効いている決定的証拠。 */
  raisedP0RLS: boolean
  /** raise しなかった場合に返った行数(0 = 空表ゆえ qual 未評価 / >0 = policy が効いていない)。 */
  rows: number
}

/**
 * probe / 観測が実行できなかった記録(Codex P1)。**「検証できなかった」を「合格」に
 * 混ぜない**ための型: 漏れの証拠ではないが、未検証を残したまま exit 0 を返すと
 * false-green になる(本 script の存在意義そのものに反する)。
 */
export type ProbeFailure = {
  table: string
  /** context 付き観測の失敗なら該当 context。no-context probe の失敗なら undefined。 */
  context?: string
  detail: string
}

/**
 * `app_current_user_id()` を直接叩いた結果(canonical review Important#1)。
 *
 * 本 script の「決定的証拠」は **P0RLS が raise されること**に全面的に依存している。
 * もしこの関数が raise しない実装(例: NULL を返す)に差し替わっていると、**行のある表でも
 * no-context probe が「0 行・エラー無し」を返し、空表と区別できなくなる** — 推論の土台が
 * 黙って無効化される。ゆえに前提そのものを 1 回直接検証する。
 */
export type FunctionProbe = {
  /** context 未設定で P0RLS を raise したか(= 推論の土台が健在)。 */
  raisedP0RLS: boolean
  detail: string
}

/** ある tenant context から観測した行数。 */
export type ContextObservation = {
  context: string
  kind: 'bogus' | 'user'
  table: string
  visible: number
  /** context と異なる所有者の行(RLS が効いていれば構造的に 0)。 */
  foreign: number
}

export type EffectivenessVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

export type EffectivenessResult = {
  verdict: EffectivenessVerdict
  findings: Finding[]
  /** 判定理由(証跡にそのまま残す 1 行)。 */
  reason: string
}

/**
 * 実効検証の判定。**行が 0 件の環境で silent に PASS しない**ことが本関数の要件:
 * - FAIL = 漏れの証拠がある(context 無しで行が見えた / bogus context で行が見えた /
 *   自分以外の所有者の行が見えた)
 * - PASS = 効いている決定的証拠がある(no-context probe が P0RLS を raise した表が 1 つ以上)
 * - INCONCLUSIVE = どちらの証拠も無い(= 観測できる行が 0 件。空表では qual が評価されず
 *   raise しないため、行数からは「弾かれた 0」と「元から 0」を区別できない)
 */
export function evaluateEffectiveness(
  probes: readonly NoContextProbe[],
  observations: readonly ContextObservation[],
  failures: readonly ProbeFailure[] = [],
  functionProbe: FunctionProbe | null = null,
): EffectivenessResult {
  const findings: Finding[] = []

  // 実行できなかった probe / 観測は「未検証」であって「合格」ではない(Codex P1)。
  // 例: `--user` に不正 uuid を渡すと全 user 観測が cast で落ちるが、無関係な表の
  // P0RLS raise だけで PASS/exit 0 を返してしまう経路があった。
  for (const failure of failures) {
    findings.push({
      area: 'rls',
      subject: failure.context ? `${failure.table}@${failure.context}` : failure.table,
      detail: `検証不能: ${failure.detail}`,
    })
  }

  // 推論の土台(canonical review Important#1): 関数が raise しないなら、no-context probe の
  // 「raise しなかった = 空表」という解釈自体が成立しない。黙って INCONCLUSIVE にせず findings に出す。
  if (functionProbe && !functionProbe.raisedP0RLS) {
    findings.push({
      area: 'rls',
      subject: 'app_current_user_id()',
      detail: `検証不能: context 未設定でも P0RLS を raise しない(${functionProbe.detail})= no-context probe の解釈が成立しない`,
    })
  }

  for (const probe of probes) {
    if (!probe.raisedP0RLS && probe.rows > 0) {
      findings.push({
        area: 'rls',
        subject: probe.table,
        detail: `tenant context 無しで ${probe.rows} 行が見えた(policy が効いていない)`,
      })
    }
  }

  for (const obs of observations) {
    if (obs.kind === 'bogus' && obs.visible > 0) {
      findings.push({
        area: 'rls',
        subject: obs.table,
        detail: `実在しない tenant context で ${obs.visible} 行が見えた`,
      })
    }
    // 他 tenant 行の混入。bogus context は直上の visible>0 で既に計上済ゆえ二重に出さない
    // (canonical review Minor#8)。
    if (obs.kind === 'user' && obs.foreign > 0) {
      findings.push({
        area: 'rls',
        subject: obs.table,
        detail: `context=${obs.context} から他 tenant の行が ${obs.foreign} 件見えた`,
      })
    }
  }

  const unverifiedCount = failures.length + (functionProbe && !functionProbe.raisedP0RLS ? 1 : 0)
  if (findings.length > 0) {
    const onlyUnverified = unverifiedCount > 0 && findings.length === unverifiedCount
    return {
      verdict: 'FAIL',
      findings,
      reason: onlyUnverified
        ? '実効検証を完走できなかった(未検証あり)= 合格とは扱わない'
        : '漏れの証拠を検出した(下記 findings)',
    }
  }

  // 「決定的に効いていると示せた表」と「空表ゆえ示せなかった表」の内訳を verdict 行に載せる
  // (canonical review Minor#7): 総合 PASS を「全表が runtime で証明された」と読ませない。
  const decisive = probes.filter((p) => p.raisedP0RLS).map((p) => p.table)
  const inconclusiveTables = probes.filter((p) => !p.raisedP0RLS).map((p) => p.table)
  const coverage = `decisive ${decisive.length} / inconclusive ${inconclusiveTables.length}`

  if (decisive.length > 0) {
    return {
      verdict: 'PASS',
      findings,
      reason:
        `${coverage} — no-context probe が P0RLS を raise した表 ${decisive.length} 件(例: ${decisive.slice(0, 3).join(', ')})= policy が実効で評価されている決定的証拠。` +
        (inconclusiveTables.length > 0
          ? `残り ${inconclusiveTables.length} 表は qual が評価されず runtime 証明なし(例: ${inconclusiveTables.slice(0, 3).join(', ')})— 空表 + seq scan か RLS 未適用かはこの観測では区別できないため、カタログ突合の結果で判断すること`
          : ''),
    }
  }

  return {
    verdict: 'INCONCLUSIVE',
    findings,
    reason:
      `${coverage} — 判定不能: どの表でも qual が評価されなかった(P0RLS 無し + 可視行 0)。` +
      'これは「qual はあるが評価されなかった(空表 + seq scan)」と「そもそも qual が無い(RLS 未適用)」の両方を含み、' +
      'この観測だけでは区別できない(raise の有無は行数でなく実行計画依存)。**カタログ突合の結果で判断すること**' +
      (functionProbe?.raisedP0RLS
        ? '。なお app_current_user_id() 自体は P0RLS を raise しており、raise 機構は健在(未証明なのは各表の qual 評価のみ)'
        : ''),
  }
}

// ---------------------------------------------------------------------------
// pure: 出力整形(証跡としてそのまま台帳に貼れる生の表)
// ---------------------------------------------------------------------------

/** 見出し + 行配列を等幅の表に整形する。 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  )
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - displayWidth(s)))
  const line = widths.map((w) => '-'.repeat(w)).join('-+-')
  const head = headers.map((h, i) => pad(h, widths[i]!)).join(' | ')
  const body = rows.map((r) => r.map((c, i) => pad(c ?? '', widths[i]!)).join(' | '))
  return [head, line, ...body].join('\n')
}

/** 全角を 2 幅として数える(表の桁ズレを防ぐ)。 */
function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1
  return width
}

// ---------------------------------------------------------------------------
// I/O: CLI
// ---------------------------------------------------------------------------

/** `--user <uuid>` を全て集める(0 個可)。 */
export function parseUserFlags(argv: readonly string[]): string[] {
  const users: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user' && argv[i + 1]) {
      users.push(argv[i + 1]!)
      i++
    }
  }
  return users
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `--user` の値が uuid でなければ前提エラーにする(Codex P1 の具体例)。不正値は
 * `::uuid` cast で全観測が落ち、「未検証なのに他表の P0RLS で PASS」に化けるため、
 * 検証を始める前に弾く。
 */
export function invalidUserIds(userIds: readonly string[]): string[] {
  return userIds.filter((id) => !UUID_RE.test(id))
}

/** 接続文字列の解決元。証跡にどちらを使ったか残すため名前も返す。 */
/**
 * 接続先を証跡に自己識別させる(canonical review Important#4)。Supabase は stg も prod も
 * `current_database()` が `postgres` で**出力が区別できない** — 本 script の成果物は台帳に
 * 貼る証拠であり、「どの環境の話か」が出力自体から読めなければ今回の事故(記録と現物の乖離)
 * を繰り返す。password は含めない(`tests/integration/pg/setup/db-url.ts:24` と同じ方針)。
 */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url)
    const db = parsed.pathname.replace(/^\//, '') || '(なし)'
    return `host=${parsed.hostname} port=${parsed.port || '(既定)'} db=${db}`
  } catch {
    return '(接続文字列を解析できず)'
  }
}

export function resolveUrl(
  env: Readonly<Record<string, string | undefined>>,
): { url: string; source: string } | null {
  const explicit = env['RLS_VERIFY_DATABASE_URL']
  if (explicit) return { url: explicit, source: 'RLS_VERIFY_DATABASE_URL' }
  const fallback = env['DATABASE_URL_APP']
  if (fallback) return { url: fallback, source: 'DATABASE_URL_APP' }
  return null
}

async function main(): Promise<number> {
  const resolved = resolveUrl(process.env)
  if (!resolved) {
    console.error(
      '[verify-rls-state] 接続文字列がありません。RLS_VERIFY_DATABASE_URL(推奨)または DATABASE_URL_APP を設定してください。',
    )
    return 2
  }
  const userIds = parseUserFlags(process.argv.slice(2))
  const invalid = invalidUserIds(userIds)
  if (invalid.length > 0) {
    console.error(`[verify-rls-state] --user が uuid 形式ではありません: ${invalid.join(', ')}`)
    return 2
  }

  const sql = postgres(resolved.url, { prepare: false, max: 1, onnotice: () => {} })

  try {
    // --- 前提: app role であること(owner は policy 素通し = false-green ゆえ拒否)---
    const [identity] = await sql<
      { role: string; db: string; is_super: boolean; bypass_rls: boolean }[]
    >`
      SELECT current_user AS role,
             current_database() AS db,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `
    console.log('## 1. 接続')
    console.log(
      formatTable(
        ['項目', '値'],
        [
          ['接続元 env', resolved.source],
          ['接続先', describeTarget(resolved.url)],
          ['current_user', identity?.role ?? '(不明)'],
          ['current_database', identity?.db ?? '(不明)'],
          ['rolsuper', String(identity?.is_super ?? '(不明)')],
          ['rolbypassrls', String(identity?.bypass_rls ?? '(不明)')],
        ],
      ),
    )
    console.log('')

    if (!identity || identity.role !== APP_ROLE || identity.is_super || identity.bypass_rls) {
      console.error(
        `[verify-rls-state] app role(${APP_ROLE}・非 superuser・非 BYPASSRLS)以外では検証になりません` +
          '(owner は policy を素通しし false-green を生む)。中断します。',
      )
      return 2
    }

    // --- カタログ突合(行の有無に依らず必ず判定する)---
    const relRows = await sql<RelRow[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `
    const policyRows = await sql<PolicyRow[]>`
      SELECT tablename, policyname, roles, cmd, permissive, qual, with_check
      FROM pg_policies WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `
    const grantRows = await sql<GrantRow[]>`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = ${APP_ROLE} AND table_schema = 'public'
    `

    const rlsFindings = compareRlsTables(relRows)
    const policyFindings = comparePolicies(policyRows)
    const grantFindings = compareGrants(grantRows)
    const catalogFindings = [...rlsFindings, ...policyFindings, ...grantFindings]

    console.log('## 2. カタログ突合')
    console.log(
      formatTable(
        ['観点', '実測', '期待', '判定'],
        [
          [
            'RLS 有効表',
            String(relRows.filter((r) => r.relrowsecurity).length),
            String(EXPECTED_RLS_TABLES.length),
            rlsFindings.length === 0 ? 'OK' : 'NG',
          ],
          [
            'policy 総数',
            String(policyRows.length),
            String(Object.keys(EXPECTED_POLICIES).length),
            policyFindings.length === 0 ? 'OK' : 'NG',
          ],
          [
            'grant(app role)',
            `${new Set(grantRows.map((g) => g.table_name)).size} 表`,
            `${Object.keys(EXPECTED_GRANTS).length} 表`,
            grantFindings.length === 0 ? 'OK' : 'NG',
          ],
        ],
      ),
    )
    console.log('')
    console.log(
      formatTable(
        ['table', 'rowsecurity', 'force'],
        relRows.map((r) => [r.relname, String(r.relrowsecurity), String(r.relforcerowsecurity)]),
      ),
    )
    console.log('')
    console.log(
      formatTable(
        ['table', 'policy', 'roles', 'cmd', 'qual', 'with_check'],
        policyRows.map((p) => [
          p.tablename,
          p.policyname,
          `{${p.roles.join(',')}}`,
          p.cmd,
          p.qual ?? '(null)',
          p.with_check ?? '(null)',
        ]),
      ),
    )
    console.log('')

    if (catalogFindings.length > 0) {
      console.log('### カタログ不一致')
      console.log(
        formatTable(
          ['area', 'subject', 'detail'],
          catalogFindings.map((f) => [f.area, f.subject, f.detail]),
        ),
      )
      console.log('')
    }

    // --- 実効検証 ---
    // (a) no-context probe: policy が実際に評価されているかの決定的証拠(行があれば)。
    // (a-0) 推論の土台を先に検証する(canonical review Important#1): この関数が raise
    // しないなら「raise しなかった = 空表」という以降の解釈が丸ごと成立しない。
    let functionProbe: FunctionProbe
    try {
      await sql`SELECT public.app_current_user_id()`
      functionProbe = { raisedP0RLS: false, detail: 'context 未設定でも例外なく値を返した' }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      functionProbe =
        code === 'P0RLS'
          ? { raisedP0RLS: true, detail: 'P0RLS' }
          : { raisedP0RLS: false, detail: `想定外エラー (code=${code ?? 'なし'}): ${String(err)}` }
    }

    const probes: NoContextProbe[] = []
    const failures: ProbeFailure[] = []
    for (const table of COMMON_FORM_RLS_TABLES) {
      try {
        const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(table)}`
        probes.push({ table, raisedP0RLS: false, rows: row?.n ?? 0 })
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        if (code === 'P0RLS') {
          probes.push({ table, raisedP0RLS: true, rows: 0 })
        } else {
          // 権限不足など想定外 = 「この表は検証できていない」。握って PASS に流さない(Codex P1)。
          failures.push({
            table,
            detail: `no-context probe が想定外エラー (code=${code ?? 'なし'}): ${String(err)}`,
          })
        }
      }
    }

    // (b) context 付き観測: bogus(実在しない tenant)+ operator 指定 user。
    const observations: ContextObservation[] = []
    for (const context of [BOGUS_CONTEXT, ...userIds]) {
      const kind: ContextObservation['kind'] = context === BOGUS_CONTEXT ? 'bogus' : 'user'
      for (const table of COMMON_FORM_RLS_TABLES) {
        try {
          // 'read only' で開く(canonical review Minor#10): 本 script は read-only 契約だが、
          // 将来の編集が誤って書込を足しても DB 側で弾かれる構造保証にしておく。
          const rows = await sql.begin('read only', async (tx) => {
            await tx`SELECT set_config('app.user_id', ${context}, true)`
            return tx<{ visible: number; foreign_rows: number }[]>`
              SELECT count(*)::int AS visible,
                     count(*) FILTER (WHERE user_id <> ${context}::uuid)::int AS foreign_rows
              FROM ${tx(table)}
            `
          })
          const row = rows[0]
          observations.push({
            context,
            kind,
            table,
            visible: row?.visible ?? 0,
            foreign: row?.foreign_rows ?? 0,
          })
        } catch (err) {
          // 観測できなかった = 未検証。silent に落として残りだけで PASS を出さない(Codex P1)。
          failures.push({ table, context, detail: `context 付き観測が失敗: ${String(err)}` })
        }
      }
    }

    const effectiveness = evaluateEffectiveness(probes, observations, failures, functionProbe)

    console.log('## 3. 実効検証')
    console.log(
      formatTable(
        ['前提', '結果'],
        [
          [
            'app_current_user_id() 直接呼出(context 未設定)',
            functionProbe.raisedP0RLS
              ? 'P0RLS(raise 機構は健在)'
              : `raise しない: ${functionProbe.detail}`,
          ],
        ],
      ),
    )
    console.log('')
    console.log(
      formatTable(
        ['table', 'no-context probe', 'bogus ctx 可視', ...userIds.map((u) => `${u.slice(0, 8)} 可視/他所有`)],
        COMMON_FORM_RLS_TABLES.map((table) => {
          const probe = probes.find((p) => p.table === table)
          const probeText = !probe
            ? '検証不能'
            : probe.raisedP0RLS
              ? 'P0RLS(効いている)'
              : `${probe.rows} 行(空 or 無効)`
          const bogus = observations.find((o) => o.table === table && o.kind === 'bogus')
          return [
            table,
            probeText,
            String(bogus?.visible ?? '-'),
            ...userIds.map((u) => {
              const o = observations.find((x) => x.table === table && x.context === u)
              return o ? `${o.visible}/${o.foreign}` : '-'
            }),
          ]
        }),
      ),
    )
    console.log('')
    console.log(`実効検証 = ${effectiveness.verdict}`)
    console.log(`理由: ${effectiveness.reason}`)
    if (effectiveness.findings.length > 0) {
      console.log('')
      console.log(
        formatTable(
          ['area', 'subject', 'detail'],
          effectiveness.findings.map((f) => [f.area, f.subject, f.detail]),
        ),
      )
    }
    console.log('')

    // --- 総合判定 ---
    const catalogOk = catalogFindings.length === 0
    const failed = !catalogOk || effectiveness.verdict === 'FAIL'
    console.log('## 4. 総合判定')
    console.log(
      formatTable(
        ['項目', '結果'],
        [
          ['カタログ突合', catalogOk ? '合格' : `不一致 ${catalogFindings.length} 件`],
          ['実効検証', effectiveness.verdict],
          ['exit code', failed ? '1' : '0'],
        ],
      ),
    )
    return failed ? 1 : 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// process.argv[1] が本 file のとき = CLI 起動。test / 他 module からの import では走らない
// (gc-image-assets.ts / gc-abandoned-operations.ts と同じ guard)。
if (process.argv[1]?.endsWith('verify-rls-state.ts')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[verify-rls-state] fatal:', err)
      process.exit(2)
    })
}
