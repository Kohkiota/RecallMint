// server limit guard — postgres-js / drizzle は net / tls / fs に依存するため client
// bundle に入れてはならない。 import 'server-only' により、 client component から
// 本 module が transitive import された時点で build を loud に失敗させる。
import 'server-only'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null
let _client: ReturnType<typeof postgres> | null = null

// Supabase Transaction pooler への接続を想定。 prepare: false は Supabase pooler
// (PgBouncer transaction mode) の要件で、 prepared statement キャッシュを無効化する。
export function getDb() {
  if (_db) return _db
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set')
  }
  _client = postgres(process.env.DATABASE_URL, { prepare: false })
  _db = drizzle(_client, { schema })
  return _db
}

/**
 * Underlying postgres-js client を close し、 module-level singleton (_db/_client)
 * を null clear する。 getDb() が未呼出なら no-op。
 *
 * 用途: scripts/ 配下の one-shot script (例: seed-perf-exam.ts) で main 完了後に
 * process が exit せず固まる (= connection が open のまま) のを防ぐ lifecycle
 * 管理 helper。 成功 / 失敗 両経路で呼ぶ前提 (try/finally or `.then(s, f)` 等)。
 *
 * app runtime (Next.js / serverless) では呼ばない — request lifecycle 終了時に
 * runtime が自動 close する。 `{ timeout: 5 }` で 5 秒以内に in-flight query を
 * 待ってから force close する (永続 hang 防止)。
 *
 * try/finally で null clear を必ず実行する設計: `_client.end()` が稀に reject した
 * 場合でも singleton を null に戻し、 dead wrapper を再 getDb() で掴ませないため。
 */
export async function closeDb(): Promise<void> {
  if (!_client) return
  try {
    await _client.end({ timeout: 5 })
  } finally {
    _client = null
    _db = null
  }
}

export type DB = ReturnType<typeof getDb>
