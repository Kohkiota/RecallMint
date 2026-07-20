import 'server-only'
import { sql } from 'drizzle-orm'
import type { DB } from './index'

// db.transaction のコールバックが受け取る tx ハンドル型。RLS 対象の repository /
// apply 層はこの型のみを受け取り、tx の外 (raw getDb()) を掴まない。
export type TenantTx = Parameters<Parameters<DB['transaction']>[0]>[0]

// RLS 対象の read/write helper が受け取る接続ハンドル。通常は withTenantTx が
// 渡す TenantTx。DB を許すのは非 tx 文脈からの呼出互換のため (Phase 3 で
// TenantTx のみへ絞る想定・spec §4.1)。
export type TenantDb = DB | TenantTx

// tx-local に app.user_id GUC を設定する。第 3 引数 true = SET LOCAL 相当
// (COMMIT/ROLLBACK で消滅)。値は (uuid)::uuid::text で cast し、不正形式を
// 設定時点で loud fail させる (対象表 query まで潜伏させない。spec §2.1)。
// policy USING/WITH CHECK が (SELECT app_current_user_id()) でこの GUC を読む。
export async function setTenantContext(tx: TenantTx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.user_id', ${userId}::uuid::text, true)`)
}

// owner-scoped な処理を 1 tx に包み、冒頭で tenant context を張る。RLS 有効表への
// 全アクセスはこの中で行う。fn の戻り値・throw は透過する。
export async function withTenantTx<T>(
  db: DB,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantContext(tx, userId)
    return fn(tx)
  })
}
