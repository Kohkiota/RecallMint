// PostgreSQL `expr IN ($1::date, $2::date, ...)` 形を生成する helper。
//
// 配列を単一 param で bind する経路 (`sql.param(array)` / Drizzle `inArray`
// の配列 binding 等) は **postgres-js + Supabase Transaction pooler
// (prepare:false) 環境で driver serializer が Array をスカラ扱いし
// `Buffer.byteLength(Array)` で TypeError を起こす** (T-B2 d1987da 事案、
// lesson `2026-06-13-drizzle-sql-template-array-embed.md` 訂正 section)。
// 本 helper は各日付を **個別 param + 明示 `::date` cast** で展開して
// `sql.join` で連結することで配列 bind 経路を踏まず、 driver 層挙動依存を
// 最小化する (Step 0 stg 実機検証 a885199 で確証した採用 X 形)。
//
// 注意:
// - `days` 各要素は `'YYYY-MM-DD'` ISO date format を想定
// - 空配列は `sql\`false\`` で逃がす (空 `IN ()` の SQL syntax error 防止)
// - 500 件超で警戒 log 出力 (PostgreSQL 1 message あたりの param 上限 65535
//   からは余裕があるが、 IN list 膨張時の早期検知 signal とする)

import { sql, type SQL } from 'drizzle-orm'
import { logger } from '@/lib/logger'

const LARGE_THRESHOLD = 500

export function inDateList(expr: SQL, days: string[]): SQL {
  if (days.length === 0) return sql`false`
  if (days.length > LARGE_THRESHOLD) {
    logger.warn({ event: 'in_date_list.large', count: days.length })
  }
  const dayParams = sql.join(
    days.map((d) => sql`${d}::date`),
    sql`, `,
  )
  return sql`${expr} IN (${dayParams})`
}
