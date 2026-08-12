// bulk endpoint (review-events / entity-mutations) の envelope-level error を
// transient / permanent-4xx / permanent-other に分類する server-side helper。
//
// 用途: caller (bulk route) が catch した envelope error を 503 (transient =
// Retry-After 付き) / 400 (permanent-4xx: zod validation error または PERMANENT_PG_CODES
// の PostgreSQL SQLSTATE 5 種) / 503 (permanent-other: unknown DB default) のいずれかに
// 振り分けるための共有 logic。 client retry controller (lib/retry/transient-error.ts) の
// `isTransientError` は HTTP `\b(500|502|503|504)\b` で transient 判定するため、 503 を
// 返す経路と整合する (audit §10.3 (b) #11)。
//
// server-only 不付: Y-1 T5 precedent (`lib/sync/shared/mutation-schemas.ts`) と同じく、
// server route のみが import する単純な pure function で副作用ゼロ。
// `import 'server-only'` 不要 (client bundle に入る経路は構造的にない)。
//
// 列の育て方: 本 file の transient PG code list は spec §2.1 (H1) で OT 裁定確定した
// 初期セット。 production logger 観測 (review_events.bulk.tx_failed /
// entity_mutations.bulk.mutation_failed の serializeDbError 出力で発生 code を集計) で
// 追加すべき code を見つけたら本 set に足す。 permanent 判定は下記 PERMANENT_PG_CODES
// (23514 / 23502 / 22P02 / 22001 / 22003 の 5 種) として実装済み(spec §2 H1 裁定)。
// 23505 unique_violation のような DB 状態依存 code は意図的に含めず、 現状 default =
// transient で倒し続ける(理由は PERMANENT_PG_CODES 直前の comment)。 それ以外の code を
// permanent-4xx へ追加するかどうかは将来分割の余地あり。

import { DrizzleQueryError } from 'drizzle-orm/errors'
import { ZodError } from 'zod'

// transient HTTP 503 retry の固定秒。 load test 結果で後日調整可、 magic number 化せず
// 定数で固定。 client 側 backoff は別管理 (lib/retry/transient-error.ts)、 本値は server
// が Retry-After header で hint する秒数。
export const BULK_TRANSIENT_RETRY_SEC = 30

// PostgreSQL SQLSTATE のうち transient 扱いにする集合 (OT 裁定確定列、 spec §2.1 H1)。
const TRANSIENT_PG_CODES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57014', // statement_timeout / query_canceled
  '08000', // connection_exception (class 08)
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '53300', // too_many_connections
  '57P03', // cannot_connect_now
])

// postgres-js の ConnectionError が name (code) として返す文字列 (types/index.d.ts)。
// 上記 SQLSTATE と異なり、 postgres-js が socket layer で吐く独自 code。
const TRANSIENT_POSTGRESJS_CONN_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
])

// PostgreSQL SQLSTATE のうち permanent-4xx 扱いにする集合 (spec §2、 OT 裁定確定)。
// 判定原理: 「同一 payload の再送が現 schema 契約の下で決して成功しない」かつ
// 「payload の形だけから決定的に失敗する」code のみ。 共有 zod を通過した payload が
// これらの DB 制約で落ちる = client/server 契約 drift バグの signal。
// 42xxx (undefined_table 等の server/deploy 欠陥) や 23503/23505 (DB 状態依存) は
// 意図的に含めない — retry で解消しうるため transient のまま倒す (spec §2 参照)。
// 列の育て方は本 file 冒頭 comment (`:15-22`) の方針と同じ (production log 観測で追加)。
const PERMANENT_PG_CODES: ReadonlySet<string> = new Set([
  '23514', // check_violation
  '23502', // not_null_violation
  '22P02', // invalid_text_representation
  '22001', // string_data_right_truncation
  '22003', // numeric_value_out_of_range
])

// 戻り値型。 caller (bulk route) は `transient` → 503 + Retry-After、 `permanent-4xx` →
// 400 系維持、 `permanent-other` → 503 default (= unknown DB error は silent lost write
// 回避のため transient に倒す、 spec §1.1 目的 3)。 公衆 contract としては
// 「caller は transient or permanent-4xx の 2 分類で扱う」 (permanent-other は内部分類)。
export type BulkErrorClass = 'transient' | 'permanent-4xx' | 'permanent-other'

// 入れ子 chain (Drizzle が cause に native error を包む) を再帰して 4xx → transient PG
// code → 最後に default transient の優先順で判定する。 depth は cycle 安全のため上限。
function classifyChain(err: unknown, depth = 0): BulkErrorClass {
  if (depth > 5) return 'transient'

  // 1. ZodError = 明示 4xx (caller は 400 系を維持)。
  //    Drizzle wrap の cause が ZodError の場合も上位で先に判定したいので、 unwrap
  //    する前に instance check する (チェイン全体を辿って 4xx 性を喪失させない)。
  if (err instanceof ZodError) return 'permanent-4xx'

  // 2. Drizzle wrap (DrizzleQueryError) は cause を再帰 unwrap して判定。
  if (err instanceof DrizzleQueryError) {
    return classifyChain(err.cause, depth + 1)
  }

  // 3. 自身 / cause 上の `.code` で transient PG / postgres-js conn code / permanent PG
  //    code を判定 (両 code 集合は互いに素なので判定順は挙動に影響しない)。
  if (err !== null && typeof err === 'object') {
    const o = err as Record<string, unknown>
    const code = typeof o['code'] === 'string' ? (o['code'] as string) : null
    if (code) {
      if (TRANSIENT_PG_CODES.has(code)) return 'transient'
      if (TRANSIENT_POSTGRESJS_CONN_CODES.has(code)) return 'transient'
      if (PERMANENT_PG_CODES.has(code)) return 'permanent-4xx'
    }
    // 4. cause 上に native PG error が居る場合 (Drizzle 以外の wrap でも整合する) を辿る。
    if (o['cause'] !== undefined && o['cause'] !== null) {
      const inner = classifyChain(o['cause'], depth + 1)
      if (inner !== 'permanent-other') return inner
    }
  }

  // 5. unknown DB error default = transient (spec §1.1 目的 3、 silent lost write 回避)。
  return 'transient'
}

// caller (bulk route) が catch した envelope-level error を分類する。
//
// 公衆 contract (caller 側):
//   const cls = classifyBulkError(err)
//   if (cls === 'transient') → 503 + Retry-After: <BULK_TRANSIENT_RETRY_SEC>
//   if (cls === 'permanent-4xx') → 400 系維持 (zod validation failure 等)
//   それ以外 (= 'permanent-other') → 503 default (silent lost write 回避)
//
// 注: per-mutation の catch (entity-mutations/bulk の loop 内) は別経路 (200 + failed[])
// で扱われる既存挙動を維持。 本 helper は envelope-level の致命 error (tx 開始失敗 /
// connection 全断 / session upsert 失敗 等) のみを対象にする。
export function classifyBulkError(err: unknown): BulkErrorClass {
  return classifyChain(err)
}
