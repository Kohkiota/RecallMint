// pull-delta — 統合 /api/pull の server 内 delta 取得 factory。
// 6 module (cards / exams / tag-categories / tag-options / card-tags / tombstones)
// の同型 WHERE user_id [AND cursor >= since] → map → maxIso パターンを一箇所に集約。
// wire (HTTP レスポンス形状) · route · client には一切出さない server 内部の DRY。
//
// 各 module は getDeltaRows を呼び出して { rows, max } を受け取り、
// 公開 return key (maxUpdatedAt / maxCreatedAt / maxDeletedAt) に rename して返す。
// 公開 delta 関数の名前・signature・return key は各 module で不変に保つ。

import 'server-only'

import { and, eq, gte, SQL } from 'drizzle-orm'
import type { Column } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'
import type { TenantDb } from './tenant-tx'
import { maxIso } from './max-iso'

// DeltaConfig — 各 module が getDeltaRows に渡す設定。
// TRow: DB select の raw row 型 (typeof table.$inferSelect)。
// TClient: mapper 後の client 向け型 (ClientCard / ClientExam / 等)。
export interface DeltaConfig<TRow, TClient> {
  table: AnyPgTable
  userIdCol: Column
  cursorCol: Column
  mapper: (row: TRow) => TClient
  // mapped client row から cursor 文字列 (ISO8601) を取り出す関数。
  // maxIso は mapped rows の client field に対して計算する (現行どおり)。
  cursorValueOf: (row: TClient) => string
}

// getDeltaRows — 各 module 共通の delta 取得 body。
// since 条件式は現行 `if (since)` を verbatim で置く (falsy 値の扱い保持)。
// dbc は必須引数 (optional since より前に置く): withTenantTx が張った tenant
// context 下の tx を受け取り、そこで query を実行する (RLS-P2)。
export async function getDeltaRows<TRow, TClient>(
  config: DeltaConfig<TRow, TClient>,
  userId: string,
  dbc: TenantDb,
  since?: Date,
): Promise<{ rows: TClient[]; max: string | null }> {
  const db = dbc
  const conds: SQL[] = [eq(config.userIdCol, userId)]
  if (since) conds.push(gte(config.cursorCol, since))
  // AnyPgTable を from() に渡すため raw result の型は非特定。
  // TRow は caller の mapper 型から推論されるため、型アサーションは安全。
  const rawRows = (await db.select().from(config.table).where(and(...conds))) as unknown as TRow[]
  const rows = rawRows.map(config.mapper)
  return { rows, max: maxIso(rows.map(config.cursorValueOf)) }
}
