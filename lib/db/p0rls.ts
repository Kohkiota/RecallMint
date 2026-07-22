// P0RLS SQLSTATE 判定の production 実装。tenant context (SET LOCAL app.user_id) が
// 張られていない経路で app_current_user_id() (migration 0025) が RAISE する custom
// SQLSTATE 'P0RLS' を、catch した error から識別する pure predicate。
//
// なぜ .cause chain を歩くか: drizzle-orm postgres-js driver は raw postgres-js の
// PostgresError (`.code` に SQLSTATE) を DrizzleQueryError でラップし元 error を
// `.cause` に載せる (drizzle-orm/errors.js)。ゆえに top-level と `.cause` chain の
// 両方を見る必要がある。
//
// test-only の tests/integration/pg/setup/rls-assert.ts はこの 2 関数を import して
// 共有する (production は tests/ に依存しない = 依存方向は prod ← test の一方向)。
// I/O なし・依存なしの pure module ゆえ server/test どちらからも安全に import できる。

// error (と cause chain) のどこかに指定 SQLSTATE を持つか。
export function hasSqlState(err: unknown, code: string): boolean {
  if ((err as { code?: unknown } | undefined)?.code === code) return true
  const cause = (err as { cause?: unknown } | undefined)?.cause
  return cause !== undefined && cause !== err ? hasSqlState(cause, code) : false
}

// 'P0RLS' = app_current_user_id() が context 未設定/空文字で RAISE する custom
// SQLSTATE (migration 0025)。tenant context が張られていない経路の loud 検出。
export function isP0RLS(err: unknown): boolean {
  return hasSqlState(err, 'P0RLS')
}
