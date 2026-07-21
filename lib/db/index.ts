// server limit guard — postgres-js / drizzle は net / tls / fs に依存するため client
// bundle に入れてはならない。 import 'server-only' により、 client component から
// 本 module が transitive import された時点で build を loud に失敗させる。
import 'server-only'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null
let _client: ReturnType<typeof postgres> | null = null
let _adminDb: ReturnType<typeof drizzle<typeof schema>> | null = null
let _adminClient: ReturnType<typeof postgres> | null = null

// Supabase Transaction pooler への接続を想定。 prepare: false は Supabase pooler
// (PgBouncer transaction mode) の要件で、 prepared statement キャッシュを無効化する。
// RLS-P1: app runtime は least-privilege role (recallmint_app) で接続する
// (owner 接続は getAdminDb 側)。
export function getDb() {
  if (_db) return _db
  if (!process.env.DATABASE_URL_APP) {
    throw new Error('DATABASE_URL_APP is not set')
  }
  _client = postgres(process.env.DATABASE_URL_APP, { prepare: false })
  _db = drizzle(_client, { schema })
  return _db
}

// owner (postgres) 接続。 migration / operator 用途のみ (grants 付与・DDL 等)。
// app runtime からは呼ばない。 実行時に env が供給される想定で、 未設定なら fail-fast。
export function getAdminDb() {
  if (_adminDb) return _adminDb
  if (!process.env.DATABASE_URL_ADMIN) {
    throw new Error('DATABASE_URL_ADMIN is not set')
  }
  _adminClient = postgres(process.env.DATABASE_URL_ADMIN, { prepare: false })
  _adminDb = drizzle(_adminClient, { schema })
  return _adminDb
}

// RLS-P3 (Task 1): app-role (recallmint_app) 接続はするが tenant context
// (SET LOCAL app.user_id) を張らない経路。 対象は構造的に tenant が未確定な site
// のみ: event dedup (stripe_events / clerk_events は user_id を持たない) /
// pre-tenant resolve (SECURITY DEFINER 関数で内部 id を解決する前) / audit ledger
// (integration_failures) / 匿名 write (contact_messages・user_id nullable)。
// memoized client は getDb() とそのまま共有する (新規 pool を張らない・tenant
// context は tx-local SET LOCAL のため pool 越しの漏洩はない)。 getDb() の raw 呼び
// 出しは後続 task で lint 制限する予定 (tenant 表アクセスを型では防げない — 防壁は
// lint + コメント + review のみ)。
export function getNonTenantDb(): DB {
  return getDb()
}

/**
 * Underlying postgres-js client (app + admin 両方) を close し、 module-level
 * singleton (_db/_client/_adminDb/_adminClient) を null clear する。 未呼出の
 * 側は no-op。
 *
 * 用途: scripts/ 配下の one-shot script (例: seed-perf-exam.ts) で main 完了後に
 * process が exit せず固まる (= connection が open のまま) のを防ぐ lifecycle
 * 管理 helper。 成功 / 失敗 両経路で呼ぶ前提 (try/finally or `.then(s, f)` 等)。
 *
 * app runtime (Next.js / serverless) では呼ばない — request lifecycle 終了時に
 * runtime が自動 close する。 `{ timeout: 5 }` で 5 秒以内に in-flight query を
 * 待ってから force close する (永続 hang 防止)。
 *
 * 両 client の close は `Promise.allSettled` で並行に試みる: 片方の `.end()` が
 * reject しても、 もう片方の `.end()` 呼出は必ず実行される (try/finally を個別に
 * 掛けるだけでは、 前段の throw が後段の if block ごと skip してしまい保護になら
 * ない — allSettled で両方の settle を待ってから判定するのが正しい)。 singleton は
 * await の前に null clear する (reject した側の client を生きたまま memoize し
 * 続けない)。 いずれかが reject した場合、 両方の close 試行が完了した後で最初の
 * reject 理由を rethrow する。
 */
export async function closeDb(): Promise<void> {
  const clients = [_client, _adminClient].filter(
    (c): c is NonNullable<typeof c> => c !== null,
  )
  _client = null
  _db = null
  _adminClient = null
  _adminDb = null
  const results = await Promise.allSettled(clients.map((c) => c.end({ timeout: 5 })))
  const rejected = results.find((r) => r.status === 'rejected')
  if (rejected) throw (rejected as PromiseRejectedResult).reason
}

export type DB = ReturnType<typeof getDb>
