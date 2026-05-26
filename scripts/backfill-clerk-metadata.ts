// 既存 users 行に対し Clerk publicMetadata.{dbUserId, plan} を一斉 backfill する
// one-shot script。 C1 / C2 配備前に作成された user (= publicMetadata 未設定)
// を後追いで埋める用途。
//
// 実行:
//   pnpm tsx scripts/backfill-clerk-metadata.ts --dry-run   # 確認 (Clerk API 不発火)
//   pnpm tsx scripts/backfill-clerk-metadata.ts             # 実行
//
// 動作:
// - users 全行 (deletedAt IS NULL) を SELECT
// - chunk (default 10 件) ごとに syncClerkPublicMetadata を並列呼出
// - chunk 境界で sleep (default 500ms) して Clerk API rate limit を回避
// - 失敗 user は failedUsers[] に積み、 サマリで再実行対象として出力
// - 冪等: Clerk Backend API の updateUserMetadata は同 input で再呼出可能。
//   同 user に再 backfill しても結果は同じ
//
// 安全性:
// - deletedAt セット行は除外 (Clerk user が既に削除済の可能性高、 updateMetadata
//   が 404 で確実に失敗、 ログ noise になる)
// - production 実行は OT が手動 (env を本番用に切替えた上で本 script を実行)

import { isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { syncClerkPublicMetadata } from '@/lib/auth/clerk-metadata'
import type { Plan } from '@/lib/auth/plan-limits'

export type BackfillUserRow = {
  id: string
  clerkId: string
  plan: Plan
}

export type BackfillDeps = {
  fetchUsers: () => Promise<BackfillUserRow[]>
  sync: (input: {
    clerkId: string
    dbUserId: string
    plan: Plan
  }) => Promise<{ ok: boolean }>
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
}

export type BackfillOptions = {
  dryRun: boolean
  chunkSize?: number
  sleepMs?: number
}

export type BackfillResult = {
  total: number
  success: number
  failed: number
  failedUsers: { clerkId: string }[]
}

const DEFAULT_CHUNK_SIZE = 10
const DEFAULT_SLEEP_MS = 500

export async function runBackfill(
  opts: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  const sleepMs = opts.sleepMs ?? DEFAULT_SLEEP_MS

  const rows = await deps.fetchUsers()
  deps.log(`target: ${rows.length} users (dryRun=${opts.dryRun})`)

  let success = 0
  let failed = 0
  const failedUsers: { clerkId: string }[] = []

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    await Promise.all(
      chunk.map(async (row) => {
        if (opts.dryRun) {
          deps.log(
            `would sync: clerkId=${row.clerkId} dbUserId=${row.id} plan=${row.plan}`,
          )
          success++
          return
        }
        const result = await deps.sync({
          clerkId: row.clerkId,
          dbUserId: row.id,
          plan: row.plan,
        })
        if (result.ok) {
          success++
        } else {
          failed++
          failedUsers.push({ clerkId: row.clerkId })
          deps.log(`failed: clerkId=${row.clerkId}`)
        }
      }),
    )
    // 最終 chunk 後は sleep 不要 (次の chunk が存在しない)。 dry-run でも chunk
    // 境界 sleep を効かせるが、 Clerk API call が走らないので体感は速い。
    if (i + chunkSize < rows.length) {
      await deps.sleep(sleepMs)
    }
  }

  deps.log(
    `done. total=${rows.length} success=${success} failed=${failed} (dryRun=${opts.dryRun})`,
  )

  return {
    total: rows.length,
    success,
    failed,
    failedUsers,
  }
}

// ---------------------------------------------------------------------------
// CLI entry: production deps を bind して runBackfill を呼ぶ。 import 経路では
// 実行しないよう `require.main === module` ガード (node 互換)。 ESM bundler 経由
// では `import.meta.url` で判定する pattern もあるが、 tsx は実行時 file path を
// `process.argv[1]` に置くので簡易判定で十分。
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const db = getDb()
  const result = await runBackfill(
    { dryRun },
    {
      fetchUsers: async () => {
        const rows = await db
          .select({
            id: users.id,
            clerkId: users.clerkId,
            plan: users.plan,
          })
          .from(users)
          .where(isNull(users.deletedAt))
        return rows as BackfillUserRow[]
      },
      sync: syncClerkPublicMetadata,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      log: (msg) => console.log(`[backfill] ${msg}`),
    },
  )
  if (result.failed > 0) {
    console.error('[backfill] failedUsers:', result.failedUsers)
    process.exit(1)
  }
}

// process.argv[1] が本 file のとき = CLI 起動。 test import 時は走らない。
if (process.argv[1]?.endsWith('backfill-clerk-metadata.ts')) {
  main().catch((err) => {
    console.error('[backfill] fatal:', err)
    process.exit(1)
  })
}
