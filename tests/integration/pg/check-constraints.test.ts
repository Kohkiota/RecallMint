// Sprint B (DB 全体掃除) Task 8: migration 0036 が追加する CHECK 制約 27 本を実 PG で pin する。
//
// なぜ iso (実 PostgreSQL) か: CHECK は DB 側の述語であり、drizzle schema の宣言を読んでも
// 「実際に弾かれるか」は分からない。global-setup が drizzle/migrations を fresh DB に適用する
// ため、本 file は **migration が実際に張った制約**を刺激する (schema.ts の宣言ではなく)。
//
// 刺激は owner 接続 (getFixtureOwnerDb) の raw INSERT。理由 2 つ:
//   - 違法値は drizzle の `$type<>` union に載らず型で書けない (制約の検査に型検査は使えない)。
//   - RLS を bypass したいのは検査対象が tenant 境界でなく列値の妥当性だから (fixture 同方針)。
//
// 各制約について ① 許容値が全て通る ② 違法値が **SQLSTATE 23514** かつ **期待した制約名**で
// 弾かれる ③ NULL 許容列は NULL が通る、を pin する。②の制約名照合が「別の制約に助けられて
// 落ちただけ」を排除する (名前は spec §5.2 の `<table>_<column>_<kind>` 規約そのもの)。
//
// #11 `entity_mutations.op` / #12 `assets.status` はアプリ層 SSoT + DB CHECK backstop の
// 二重定義 (spec §5.2)。ここだけは受理・拒否 INSERT を **アプリ語彙から動的生成**し、加えて
// `pg_get_constraintdef` から許容値集合を抽出して集合一致を assert する — どちら向きの drift
// (DB が狭い / DB が広い) も red にするため。constraintdef は**文字列比較しない**
// (括弧・cast・列順の描画は PG version で変わる)、抽出するのはリテラル集合のみ。
import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { hasSqlState } from '@/lib/db/p0rls'
import { ASSET_STATUSES } from '@/lib/media/domain/asset-state'
import { ENTITY_MUTATION_REGISTRY } from '@/lib/sync/server/entity-mutation-registry'

import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

// ---------------------------------------------------------------------------
// SQL リテラル組み立て
// ---------------------------------------------------------------------------
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`

// PK / UNIQUE 衝突を避けるための連番日付 (ai_usage.date / study_days.day)。
let dateSeq = 0
const nextDate = () => `('2000-01-01'::date + ${dateSeq++})`

let ids: TenantFixture['a']

// 対象表ごとの「制約に無関係な必須列」既定値。probe INSERT はこれに検査対象列を
// 上書きして流す (= 落ちたら原因は検査対象列だけ、と言える形にする)。
function baseColumns(table: string): Record<string, string> {
  switch (table) {
    case 'users':
      return {}
    case 'ai_usage':
      return { date: nextDate() }
    case 'ai_usage_users':
      return { user_id: lit(ids.userId), date: nextDate() }
    case 'study_days':
      return { user_id: lit(ids.userId), day: nextDate() }
    case 'source_documents':
      return {
        user_id: lit(ids.userId),
        exam_id: lit(ids.examId),
        file_type: lit('pdf'),
        filename: lit('probe.pdf'),
        file_size_bytes: '1',
      }
    case 'upload_records':
      return { user_id: lit(ids.userId), status: lit('completed') }
    case 'contact_messages':
      return { email: lit('probe@example.test'), subject: lit('S'), body: lit('B') }
    case 'tag_categories':
      return { user_id: lit(ids.userId), name: lit('Cat'), select_type: lit('single') }
    case 'tombstones':
      return {
        user_id: lit(ids.userId),
        entity_type: lit('card'),
        entity_id: `'${randomUUID()}'`,
        deleted_at: 'now()',
      }
    case 'entity_mutations':
      return {
        mutation_id: `'${randomUUID()}'`,
        entity_type: lit('card'),
        entity_id: `'${randomUUID()}'`,
        user_id: lit(ids.userId),
        op: lit('create'),
        patch: `'{}'::jsonb`,
        edited_at: 'now()',
      }
    case 'assets':
      return {
        user_id: lit(ids.userId),
        object_key: lit(`probe/${randomUUID()}.webp`),
        mime: lit('image/webp'),
        byte_size: '1',
        width: '1',
        height: '1',
        hash: lit('probe-hash'),
      }
    case 'cards':
      // FSRS / 学習統計列は DB default が無い (Sprint A Task 3) ため probe でも全供給する。
      // base_order は probe 対象列なので baseColumns には含めない。
      return {
        user_id: lit(ids.userId),
        exam_id: lit(ids.examId),
        title: lit('probe'),
        question_text: lit('Q?'),
        options: `'[]'::jsonb`,
        correct_answer_ids: `'[]'::jsonb`,
        answered: 'false',
        current_streak: '0',
        due: 'now()',
        stability: '0',
        difficulty: '0',
        elapsed_days: '0',
        scheduled_days: '0',
        reps: '0',
        lapses: '0',
        state: '0',
        learning_steps: '0',
      }
    case 'upload_operations':
      return {
        user_id: lit(ids.userId),
        idempotency_key: lit(`probe_${randomUUID()}`),
        exam_id: lit(ids.examId),
        source_document_id: lit(ids.sourceDocumentId),
        expected_source_count: '1',
      }
    default:
      throw new Error(`baseColumns: unknown table ${table}`)
  }
}

async function insertProbe(table: string, column: string, value: string): Promise<void> {
  const cols = { ...baseColumns(table), [column]: value }
  const names = Object.keys(cols).join(', ')
  const values = Object.values(cols).join(', ')
  await getFixtureOwnerDb().execute(
    sql.raw(`INSERT INTO ${table} (${names}) VALUES (${values})`),
  )
}

// PG error は drizzle が DrizzleQueryError で包み元 error を .cause に載せる
// (hasSqlState と同じ理由でここも chain を歩く)。
function constraintNameOf(err: unknown): string | undefined {
  const name = (err as { constraint_name?: unknown } | undefined)?.constraint_name
  if (typeof name === 'string') return name
  const cause = (err as { cause?: unknown } | undefined)?.cause
  return cause !== undefined && cause !== err ? constraintNameOf(cause) : undefined
}

async function expectAccepted(
  constraint: string,
  table: string,
  column: string,
  value: string,
): Promise<void> {
  await expect(
    insertProbe(table, column, value),
    `${constraint}: ${column} = ${value} は受理されるべき`,
  ).resolves.toBeUndefined()
}

async function expectRejected(
  constraint: string,
  table: string,
  column: string,
  value: string,
): Promise<void> {
  let caught: unknown
  let resolved = false
  try {
    await insertProbe(table, column, value)
    resolved = true
  } catch (e) {
    caught = e
  }
  expect(resolved, `${constraint}: ${column} = ${value} は拒否されるべきだが通った`).toBe(
    false,
  )
  expect(
    hasSqlState(caught, '23514'),
    `${constraint}: ${column} = ${value} は 23514 で拒否されるべき / got ${String(caught)}`,
  ).toBe(true)
  expect(constraintNameOf(caught), `${constraint} が違反元であるべき`).toBe(constraint)
}

// ---------------------------------------------------------------------------
// アプリ層 SSoT の語彙 (spec §5.2 #11/#12)。registry は entity_type を外側 key、
// op を内側 key に持つ 2 段の表なので、両方をそこから導出する — DB CHECK の期待値を
// ここで手書きすると「語彙を足して migration を忘れた」drift が green のまま通る。
// ---------------------------------------------------------------------------
const REGISTRY_ENTITY_TYPES = Object.keys(ENTITY_MUTATION_REGISTRY).sort()
const REGISTRY_OPS = [
  ...new Set(
    Object.values(ENTITY_MUTATION_REGISTRY).flatMap((ops) => Object.keys(ops ?? {})),
  ),
].sort()

// ---------------------------------------------------------------------------
// spec §5.2 の 27 本。kind は制約名の suffix と一致 (enum / nonneg / positive)。
// ---------------------------------------------------------------------------
type CheckCase = {
  constraint: string
  table: string
  column: string
  legal: readonly string[]
  illegal: readonly string[]
  nullAllowed: boolean
}

const ENUM_CASES: readonly CheckCase[] = [
  {
    constraint: 'users_plan_enum',
    table: 'users',
    column: 'plan',
    legal: ['free', 'standard', 'pro'].map(lit),
    illegal: [lit('enterprise')],
    nullAllowed: false,
  },
  {
    constraint: 'users_subscription_status_enum',
    table: 'users',
    column: 'subscription_status',
    legal: ['active', 'past_due', 'canceled'].map(lit),
    illegal: [lit('trialing')],
    nullAllowed: true,
  },
  {
    constraint: 'users_billing_interval_enum',
    table: 'users',
    column: 'billing_interval',
    legal: ['month', 'year'].map(lit),
    illegal: [lit('week')],
    nullAllowed: true,
  },
  {
    constraint: 'source_documents_file_type_enum',
    table: 'source_documents',
    column: 'file_type',
    legal: ['pdf', 'image', 'csv', 'markdown'].map(lit),
    illegal: [lit('docx')],
    nullAllowed: false,
  },
  {
    constraint: 'source_documents_status_enum',
    table: 'source_documents',
    column: 'status',
    legal: ['processing', 'completed', 'failed'].map(lit),
    // 'uploading' は S1.9.1 で廃止した旧値 — 復活を DB でも塞ぐ。
    illegal: [lit('uploading')],
    nullAllowed: false,
  },
  {
    constraint: 'upload_records_status_enum',
    table: 'upload_records',
    column: 'status',
    legal: ['completed', 'failed'].map(lit),
    illegal: [lit('processing')],
    nullAllowed: false,
  },
  {
    constraint: 'contact_messages_status_enum',
    table: 'contact_messages',
    column: 'status',
    legal: ['open', 'in_progress', 'resolved'].map(lit),
    illegal: [lit('closed')],
    nullAllowed: false,
  },
  {
    constraint: 'tag_categories_select_type_enum',
    table: 'tag_categories',
    column: 'select_type',
    legal: ['single', 'multi'].map(lit),
    illegal: [lit('none')],
    nullAllowed: false,
  },
  {
    constraint: 'tombstones_entity_type_enum',
    table: 'tombstones',
    column: 'entity_type',
    legal: ['exam', 'card', 'tag_category', 'tag_option'].map(lit),
    illegal: [lit('deck')],
    nullAllowed: false,
  },
  {
    constraint: 'entity_mutations_entity_type_enum',
    table: 'entity_mutations',
    column: 'entity_type',
    // op と同じく registry から導出する (手書きしない・上記 vocab block 参照)。
    legal: REGISTRY_ENTITY_TYPES.map(lit),
    // outbox は exam を運ばない (exam 削除は専用経路) — 混入を DB でも塞ぐ。
    illegal: [lit('exam')],
    nullAllowed: false,
  },
  {
    constraint: 'entity_mutations_op_enum',
    table: 'entity_mutations',
    column: 'op',
    legal: ['create', 'update_field', 'delete'].map(lit),
    illegal: [lit('upsert')],
    nullAllowed: false,
  },
  {
    constraint: 'assets_status_enum',
    table: 'assets',
    column: 'status',
    legal: ['reserved', 'ready', 'deleting', 'deleted'].map(lit),
    illegal: [lit('pending')],
    nullAllowed: false,
  },
  {
    constraint: 'upload_operations_status_enum',
    table: 'upload_operations',
    column: 'status',
    legal: ['prepared', 'processing', 'completed', 'terminal_failed'].map(lit),
    illegal: [lit('queued')],
    nullAllowed: false,
  },
]

// 非負 12 本: 境界 0 が通り -1 が落ちる。
const nonneg = (
  constraint: string,
  table: string,
  column: string,
  nullAllowed = false,
): CheckCase => ({
  constraint,
  table,
  column,
  legal: ['0', '1'],
  illegal: ['-1'],
  nullAllowed,
})

const NONNEG_CASES: readonly CheckCase[] = [
  nonneg('ai_usage_count_nonneg', 'ai_usage', 'count'),
  nonneg('ai_usage_users_count_nonneg', 'ai_usage_users', 'count'),
  nonneg('source_documents_file_size_bytes_nonneg', 'source_documents', 'file_size_bytes'),
  nonneg('source_documents_pages_processed_nonneg', 'source_documents', 'pages_processed'),
  // pages_total は PDF count phase 前が NULL (spec §5.2 非負節)。
  nonneg('source_documents_pages_total_nonneg', 'source_documents', 'pages_total', true),
  nonneg('upload_records_pages_processed_nonneg', 'upload_records', 'pages_processed'),
  nonneg('study_days_review_count_nonneg', 'study_days', 'review_count'),
  nonneg('study_days_correct_count_nonneg', 'study_days', 'correct_count'),
  nonneg('study_days_distinct_card_count_nonneg', 'study_days', 'distinct_card_count'),
  nonneg('assets_byte_size_nonneg', 'assets', 'byte_size'),
  nonneg('upload_operations_attempt_count_nonneg', 'upload_operations', 'attempt_count'),
  nonneg(
    'upload_operations_expected_source_count_nonneg',
    'upload_operations',
    'expected_source_count',
  ),
]

// 正 2 本: 0 も落ちる (寸法 0 の画像は存在しない・spec §5.2 承認済)。
const POSITIVE_CASES: readonly CheckCase[] = [
  {
    // 0 と負値は使わない (0 は位置挿入の仮想下界として予約・spec §2.2)。
    constraint: 'cards_base_order_positive',
    table: 'cards',
    column: 'base_order',
    legal: ['1'],
    illegal: ['0', '-1'],
    nullAllowed: false,
  },
  {
    constraint: 'assets_width_positive',
    table: 'assets',
    column: 'width',
    legal: ['1'],
    illegal: ['0', '-1'],
    nullAllowed: false,
  },
  {
    constraint: 'assets_height_positive',
    table: 'assets',
    column: 'height',
    legal: ['1'],
    illegal: ['0', '-1'],
    nullAllowed: false,
  },
]

const ALL_CASES: readonly CheckCase[] = [
  ...ENUM_CASES,
  ...NONNEG_CASES,
  ...POSITIVE_CASES,
]

// Sprint A で入れた 4 本。spec §5.2「改名しない」の pin。
const PRE_EXISTING_CHECKS = [
  'cards_state_range',
  'answer_events_rating_range',
  'answer_events_elapsed_ms_nonneg',
  'answer_events_answered_at_le_created_at',
]

// pg_get_constraintdef から許容値集合だけを取り出す (描画形式に依存しない)。
function allowedLiteralsFromDef(def: string): string[] {
  return [...def.matchAll(/'((?:[^']|'')*)'/g)]
    .map((m) => m[1]!.replace(/''/g, "'"))
    .sort()
}

async function constraintDef(name: string): Promise<string> {
  const rows = await getFixtureOwnerDb().execute<{ def: string }>(
    sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name} AND contype = 'c'`,
  )
  expect(rows, `${name} が pg_constraint に存在しない`).toHaveLength(1)
  return rows[0]!.def
}

afterAll(async () => {
  await closeFixtureOwnerDb()
})

beforeEach(async () => {
  await truncateAllUserTables()
  // ai_usage は user_id を持たない global 表ゆえ truncateAllUserTables の対象外。
  // 本 file だけが probe 行を積むので、他 file へ状態を残さないようここで明示的に消す
  // (iso suite の「file 間に跨る state を残さない」規律)。
  await getFixtureOwnerDb().execute(sql.raw('DELETE FROM ai_usage'))
  ids = (await seedTwoTenants()).a
})

describe('migration 0036/0037 CHECK constraints (28)', () => {
  // 存在確認でなく **集合一致**。片側 (「期待した 32 本が有る」) だけでは spec 外の
  // CHECK が増えても green のままで、file 冒頭の「28 本、かつ 28 本だけ」が嘘になる。
  it('public schema の CHECK 集合 = 定義済 28 本 + 既存 4 本(過不足なし)', async () => {
    const rows = await getFixtureOwnerDb().execute<{ conname: string }>(
      sql`SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
    )
    expect(ALL_CASES).toHaveLength(28)
    const expected = [...ALL_CASES.map((c) => c.constraint), ...PRE_EXISTING_CHECKS].sort()
    expect(rows.map((r) => r.conname).sort()).toEqual(expected)
  })

  for (const c of ALL_CASES) {
    describe(c.constraint, () => {
      it('許容値を受理する', async () => {
        for (const value of c.legal) {
          await expectAccepted(c.constraint, c.table, c.column, value)
        }
      })

      it('違法値を 23514 で拒否する', async () => {
        for (const value of c.illegal) {
          await expectRejected(c.constraint, c.table, c.column, value)
        }
      })

      if (c.nullAllowed) {
        it('NULL を受理する (制約式が `col IS NULL OR ...`)', async () => {
          await expectAccepted(c.constraint, c.table, c.column, 'NULL')
        })
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 語彙一致 pin ×2 (spec §5.2 #11/#12)。アプリ層 = SSoT / DB CHECK = backstop。
// 受理・拒否 INSERT はアプリ語彙から動的生成する — 語彙を増やして schema.ts /
// migration を忘れたら「受理されるはずの値が 23514」で落ちる。
// ---------------------------------------------------------------------------
describe('アプリ語彙 ↔ DB CHECK の集合一致', () => {
  it('entity_mutations.op = ENTITY_MUTATION_REGISTRY の op key 集合', async () => {
    expect(REGISTRY_OPS.length).toBeGreaterThan(0)
    expect(allowedLiteralsFromDef(await constraintDef('entity_mutations_op_enum'))).toEqual(
      REGISTRY_OPS,
    )
    // 集合一致は宣言の照合にすぎない。実際に効いていることを INSERT で確かめる。
    for (const op of REGISTRY_OPS) {
      await expectAccepted('entity_mutations_op_enum', 'entity_mutations', 'op', lit(op))
    }
    const outsider = `not_a_registered_op_${randomUUID().slice(0, 8)}`
    expect(REGISTRY_OPS).not.toContain(outsider)
    await expectRejected(
      'entity_mutations_op_enum',
      'entity_mutations',
      'op',
      lit(outsider),
    )
  })

  it('assets.status = ASSET_STATUSES', async () => {
    const vocabulary = [...ASSET_STATUSES].sort()
    expect(allowedLiteralsFromDef(await constraintDef('assets_status_enum'))).toEqual(
      vocabulary,
    )
    for (const status of vocabulary) {
      await expectAccepted('assets_status_enum', 'assets', 'status', lit(status))
    }
    const outsider = `not_an_asset_status_${randomUUID().slice(0, 8)}`
    expect(vocabulary).not.toContain(outsider)
    await expectRejected('assets_status_enum', 'assets', 'status', lit(outsider))
  })
})
