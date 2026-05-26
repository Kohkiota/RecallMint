import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

// Supabase Transaction pooler への接続を想定。 prepare: false は Supabase pooler
// (PgBouncer transaction mode) の要件で、 prepared statement キャッシュを無効化する。
export function getDb() {
  if (_db) return _db
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set')
  }
  const client = postgres(process.env.DATABASE_URL, { prepare: false })
  _db = drizzle(client, { schema })
  return _db
}

export type DB = ReturnType<typeof getDb>
