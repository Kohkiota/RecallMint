// Clerk publicMetadata sync helper。
//
// 役割:
// - webhook handler (Clerk user.created / Stripe subscription 系) が users 行更新
//   と並行して Clerk publicMetadata に `dbUserId` / `plan` を埋め込み、 後続の
//   `auth().sessionClaims` から JWT 経由で読めるようにする (= page.tsx / API route
//   で users SELECT を不要化するための backbone)。
//
// 失敗ポリシ:
// - Clerk API 失敗時は throw せず ok:false で resolve、 notifyOps で観測性のみ確保
//   (webhook handler の「常に 200 を返す」 不変条件と整合)。 stale な JWT plan は
//   次回 webhook or backfill script で reconcile される。
// - **404 のみ silent skip** (cache-fix roadmap ④-4): 既に削除済 / 存在しない user
//   に対する metadata sync は「同期対象不在 = end state 一致 = success」 とみなし、
//   notifyOps を fire しない。 戻り値は `ok:true` で caller の semantics と整合
//   (backfill script の OK counter は「削除済 = backfill 不要」 を OK 側に振る)。
//   主因は user.deleted webhook 処理中の race / 削除済 user 宛 Stripe webhook
//   後着 / backfill script SELECT→PATCH 間の削除。 観測性は `console.debug` 1 行
//   で確保 (Vercel function logs に raw 残置、 default log level の通常運用ノイズ
//   には乗らない)。 設計: docs/superpowers/specs/2026-05-27-notify-ops-404-silent-skip-design.md

import { clerkClient } from '@clerk/nextjs/server'
import { isClerkAPIResponseError } from '@clerk/nextjs/errors'
import { recordIntegrationFailure } from '@/lib/integration-failures'
import { runtimeEnv } from '@/lib/env/runtime-env'
import type { Plan } from './plan-limits'

export type ClerkMetadataInput = {
  clerkId: string
  dbUserId?: string
  plan?: Plan
}

export type ClerkMetadataResult = { ok: boolean }

export async function syncClerkPublicMetadata(
  input: ClerkMetadataInput,
): Promise<ClerkMetadataResult> {
  const { clerkId, dbUserId, plan } = input
  const metadata: Record<string, unknown> = {}
  if (dbUserId !== undefined) metadata.dbUserId = dbUserId
  if (plan !== undefined) metadata.plan = plan
  // Clerk Backend API は publicMetadata を top-level merge する仕様 (PATCH /v1/users/{id}/metadata)。
  // よって渡した key だけ更新され、 渡さなかった key は維持される (e.g. plan のみ送れば dbUserId は不変)。
  // 何も渡されなかったら API 呼ばずに ok:true (caller での undefined 流入を安全化)
  if (Object.keys(metadata).length === 0) return { ok: true }

  try {
    const client = await clerkClient()
    await client.users.updateUserMetadata(clerkId, { publicMetadata: metadata })
    return { ok: true }
  } catch (err) {
    // Clerk 404 silent skip: user 不在 = 同期不要 (file header 失敗ポリシ参照)。
    // notifyOps を fire せず、 軽量観測性のため console.debug 1 行だけ残す。
    if (isClerkAPIResponseError(err) && err.status === 404) {
      console.debug('clerk-metadata: user not found, skipped silently', {
        clerkId,
      })
      return { ok: true }
    }
    // workflow=null: この site は user.created 初期 sync / Stripe plan sync の複数
    // 文脈から呼ばれ、site 単独で文脈を特定できないため catalog は workflow=null。
    // 後段の手動 SQL では context.keys で傾向推測のみ可能 (['plan'] = Stripe plan
    // sync / ['dbUserId','plan'] = 初期 sync or backfill script。初期 sync と backfill
    // は同一 keys ゆえ厳密判別は不能・許容)。詳細: integration-failures.ts clerk_sync entry。
    await recordIntegrationFailure({
      key: 'clerk_sync',
      clerkId,
      userId: dbUserId,
      errorMessage: err instanceof Error ? err.message : String(err),
      subject: 'clerk publicMetadata sync failed',
      context: {
        clerkId,
        keys: Object.keys(metadata),
        error: err instanceof Error ? err.message : String(err),
        environment: runtimeEnv(),
        timestamp: new Date().toISOString(),
      },
    })
    return { ok: false }
  }
}
