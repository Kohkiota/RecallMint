import { Pool, neonConfig } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import ws from 'ws'
import { logger } from '@/lib/logger'
import * as schema from './schema'

// Neon serverless requires WebSocket in Node runtime (not needed on Edge).
neonConfig.webSocketConstructor = ws

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

/**
 * Lazy Drizzle client singleton using Neon serverless driver (WebSocket).
 * Supports transactions via `db.transaction()` and is safe for Vercel
 * serverless cold starts. Throws on first call if DATABASE_URL is unset.
 */
export function getDb() {
  if (_db) return _db
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set')
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  // G-5-2 + G-6: capture idle client / re-connect errors via structured logger
  pool.on('error', (err: Error) => logger.error({ event: 'db.pool.error', err }))
  _db = drizzle(pool, { schema })
  return _db
}

export type DB = ReturnType<typeof getDb>
