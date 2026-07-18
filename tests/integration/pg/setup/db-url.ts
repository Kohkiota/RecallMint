// PG 統合テスト専用の接続先を単一箇所に集約する安全境界。 stg/prod を絶対に叩かない
// ための guard を同居させる。 localhost は名前解決依存 (IPv4/IPv6・/etc/hosts で別 host
// へ向きうる) ため許可せず、 127.0.0.1 完全一致のみ許す。

export const TEST_DATABASE_URL =
  'postgres://postgres:postgres@127.0.0.1:5432/recallmint_test'

// URL が local test DB (127.0.0.1:5432/recallmint_test) を指すことを検証し、 満たさなければ
// throw する。 検査した URL そのものを接続に使う前提 — 別 URL で接続する TOCTOU を作らない。
// throw メッセージには host/port/db のみ出し、 secret/password は出さない。
export function assertLocalTestDb(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`assertLocalTestDb: URL を parse できません`)
  }
  const dbName = parsed.pathname.replace(/^\//, '')
  const detail = `host=${parsed.hostname} port=${parsed.port} db=${dbName}`
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`assertLocalTestDb: protocol が postgres(ql): でない (${detail})`)
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(`assertLocalTestDb: host が 127.0.0.1 でない (${detail})`)
  }
  if (parsed.port !== '5432') {
    throw new Error(`assertLocalTestDb: port が 5432 でない (${detail})`)
  }
  if (dbName !== 'recallmint_test') {
    throw new Error(`assertLocalTestDb: DB 名が recallmint_test でない (${detail})`)
  }
}

// TEST_DATABASE_URL を guard に通した上で process.env.DATABASE_URL に代入する。
// ??= でなく代入 — 既存 fake env (vitest.setup.ts) より real test DB を優先させ、
// getDb() が確実に test DB を掴むことを保証する。
export function hardSetTestDatabaseUrl(): void {
  assertLocalTestDb(TEST_DATABASE_URL)
  process.env.DATABASE_URL = TEST_DATABASE_URL
}
