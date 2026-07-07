// Runtime environment helpers (DDD P4 DRY §T5)。
// 依存ゼロ leaf — 何も import しない(循環リスクなし)。
// lib 内の VERCEL_ENV inline を 2 形式に集約する:
//   runtimeEnv()   = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'
//   isProduction() = process.env.VERCEL_ENV === 'production'

/** 現在の実行環境 tier 文字列を返す。VERCEL_ENV → NODE_ENV → 'unknown' の優先順位。 */
export function runtimeEnv(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'
}

/** VERCEL_ENV が厳密に 'production' のとき true。preview / dev / undefined は false。 */
export function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production'
}
