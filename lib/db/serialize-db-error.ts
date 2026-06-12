// serialize-db-error — catch した DB error (postgres-js / Drizzle wrap) を
// JSON-safe な plain object に展開する観測専用 util。
//
// なぜ必要か: lib/logger.ts の JSON replacer (expandError) は Error instance を
// {name, message, stack} に潰すため、 postgres-js native error が持つ
// code(SQLSTATE) / severity / detail / hint / constraint_name 等が log から消える。
// さらに Drizzle は native error を `Failed query: <SQL>` で wrap し、 native 詳細を
// `cause` 等の入れ子に隠す。 本 util は Error を **plain object** に展開して返すので、
// logger がそのまま全フィールドを serialize でき、 native error が可視化される。
//
// 制約: 観測専用。 throw しない (catch 内で更に throw すると 200+failed[] 契約が崩れる)。
// 副作用なし。 SQL 文・挙動は一切変えない (診断強化のみ)。

import { isLogGateOpen } from '@/lib/env/log-gate'

const STD_KEYS = [
  'name', 'message', 'stack',
  // postgres-js native error (node-postgres 互換) が持つ field
  'code', 'severity', 'detail', 'hint', 'position', 'where',
  'schema_name', 'table_name', 'column_name', 'constraint_name',
  'query',
] as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// error が入りうる入れ子 field (Drizzle が cause 以外に入れる可能性をカバー)。
const NESTED_KEYS = ['cause', 'originalError', 'error'] as const

// 1 つの error-like value の own props (enumerable 外含む) + 標準 key を JSON-safe に展開。
// params / 入れ子 error field は呼び元 (shapeError) が別扱いするためここでは除外。
function shapeOwnProps(e: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const o = e as Record<string, unknown>
  const skip = new Set<string>([...NESTED_KEYS, 'errors', 'params'])
  const keys = new Set<string>([...Object.getOwnPropertyNames(o), ...STD_KEYS])
  for (const k of keys) {
    if (skip.has(k)) continue
    const v = o[k]
    if (
      v === null ||
      v === undefined ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      out[k] = v
    } else {
      // object / function / bigint / symbol 等は文字列化 (circular 安全 / JSON-safe)
      try {
        out[k] = String(v)
      } catch {
        out[k] = '[unserializable]'
      }
    }
  }
  return out
}

// error chain を再帰展開 (cause / originalError / error / errors を辿る)。
function shapeError(e: unknown, depth = 0): unknown {
  if (depth > 4) return '[max depth]'
  if (e === undefined) return '[undefined]'
  if (e === null || typeof e !== 'object') return e
  const o = e as Record<string, unknown>
  const out = shapeOwnProps(e)
  for (const k of NESTED_KEYS) {
    if (o[k] != null) out[k] = shapeError(o[k], depth + 1)
  }
  if (Array.isArray(o.errors)) {
    out.errors = o.errors.map((x) => shapeError(x, depth + 1))
  }
  return out
}

// err + 入れ子から bind params 配列を探す (Drizzle wrap が持つ可能性)。
function findParams(e: unknown, depth = 0): unknown[] | null {
  if (depth > 5 || e === null || typeof e !== 'object') return null
  const o = e as Record<string, unknown>
  if (Array.isArray(o.params)) return o.params as unknown[]
  for (const k of NESTED_KEYS) {
    const r = findParams(o[k], depth + 1)
    if (r) return r
  }
  if (Array.isArray(o.errors)) {
    for (const x of o.errors) {
      const r = findParams(x, depth + 1)
      if (r) return r
    }
  }
  return null
}

export interface SerializedDbError {
  paramsCount: number
  paramsTypeDistribution: Record<string, number>
  paramsAnomaly: { hasUndefined: boolean; hasNull: boolean; hasInvalidDate: boolean }
  cardIds: string[]
  fullParams?: unknown[]
  [k: string]: unknown
}

// params の要約 (PII / log 肥大化対策で full params はデフォルト出さない)。
function summarizeParams(
  params: unknown[] | null,
  seedCardIds: string[],
): SerializedDbError {
  const cardIds = new Set<string>(seedCardIds.filter((c) => UUID_RE.test(c)))
  let hasUndefined = false
  let hasNull = false
  let hasInvalidDate = false
  const dist: Record<string, number> = {}

  for (const p of params ?? []) {
    let t: string
    if (p === undefined) {
      t = 'undefined'
      hasUndefined = true
    } else if (p === null) {
      t = 'null'
      hasNull = true
    } else if (p instanceof Date) {
      t = 'date'
      if (Number.isNaN(p.getTime())) hasInvalidDate = true
    } else {
      t = typeof p
    }
    dist[t] = (dist[t] ?? 0) + 1
    if (typeof p === 'string') {
      if (UUID_RE.test(p)) cardIds.add(p)
      if (p === 'Invalid Date') hasInvalidDate = true
    }
  }

  const summary: SerializedDbError = {
    paramsCount: params?.length ?? 0,
    paramsTypeDistribution: dist,
    paramsAnomaly: { hasUndefined, hasNull, hasInvalidDate },
    cardIds: [...cardIds],
  }
  // full params は env flag が "1" のときのみ。 prod では LOG_GATE_ALLOW_PROD=1 も
  // 併せて要する 2 段 gate (audit §10.3 (b) #5、 lib/env/log-gate.ts)。
  if (isLogGateOpen('BULK_FULL_PARAMS_LOG')) summary.fullParams = params ?? []
  return summary
}

/**
 * catch した DB error を JSON-safe plain object に展開する。
 * - error chain (name/message/stack/code/severity/detail/hint/constraint_name 等) を
 *   cause / originalError / error / errors まで再帰展開
 * - params は count / 型分布 / anomaly flag / card_id 抽出のみ (full は env flag 時)
 * 絶対に throw しない (失敗時は fallback object を返す)。
 */
export function serializeDbError(
  err: unknown,
  opts: { cardIds?: string[] } = {},
): SerializedDbError {
  try {
    const shaped = shapeError(err)
    const summary = summarizeParams(findParams(err), opts.cardIds ?? [])
    if (shaped !== null && typeof shaped === 'object' && !Array.isArray(shaped)) {
      return { ...(shaped as Record<string, unknown>), ...summary }
    }
    return { error: shaped, ...summary }
  } catch (serErr) {
    return {
      serializeFailed: String(serErr),
      raw: String(err),
      paramsCount: 0,
      paramsTypeDistribution: {},
      paramsAnomaly: { hasUndefined: false, hasNull: false, hasInvalidDate: false },
      cardIds: [],
    }
  }
}
