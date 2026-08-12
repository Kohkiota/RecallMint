// 同一 user を 2 本の独立接続から同時に叩くための helper (FSRS 整合 Sprint A Task 6)。
//
// 新規 client を張らず app-role pool (getDb() の postgres-js client) を使うのは、
// 検証対象の processAnswerEvents が内部で withTenantTx → getDb() を掴み、test 側から
// 接続を注入できないため。drizzle の postgres-js transaction は client.begin() =
// pool から専有接続を取るので、同時発行した 2 tx は別 backend で走る (= 独立接続)。
// tenant context は withTenantTx が tx-local に張るため各 tx が自分の GUC を持つ。
//
// この前提 (2 tx = 2 backend) が崩れて 1 接続に serialize されると、並行 pin は
// 直列実行の結果と区別が付かなくなり全部空振りする。measureConcurrentBackends は
// その前提を実 PG から読み出して pin するための自己検証で、並行 test の非空振り根拠。
import { sql } from 'drizzle-orm'

import { withTenantTx } from '@/lib/db/tenant-tx'

// 全員が到達するまで待つ合流点。1 接続に serialize されていると 2 人目が来ないため
// 待ち続ける形になるので、timeout で loud に失敗させる (無限 hang を作らない)。
function createBarrier(parties: number, timeoutMs = 5_000): () => Promise<void> {
  let remaining = parties
  let release!: () => void
  let fail!: (e: Error) => void
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const timer = setTimeout(
    () => fail(new Error(`barrier timeout: ${remaining}/${parties} 未到達`)),
    timeoutMs,
  )
  gate.catch(() => {})
  return async () => {
    remaining -= 1
    if (remaining === 0) {
      clearTimeout(timer)
      release()
    }
    await gate
  }
}

/**
 * 同一 user の tenant tx を 2 本同時に開き、それぞれの PG backend pid を返す。
 *
 * barrier を置けるのは両 tx とも行ロックを取らないため (FOR UPDATE を含む実 flush に
 * barrier を置くと 2 本目が 1 本目の commit まで進めず deadlock する — green 経路には
 * 決して持ち込まない)。
 */
export async function measureConcurrentBackends(userId: string): Promise<number[]> {
  const arrive = createBarrier(2)
  const probe = () =>
    withTenantTx(userId, async (tx) => {
      const rows = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid()::int AS pid`,
      )
      await arrive()
      return rows[0]!.pid
    })
  return Promise.all([probe(), probe()])
}
