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

import { clerkClient } from '@clerk/nextjs/server'
import { notifyOps } from '@/lib/ops'
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
    await notifyOps('clerk publicMetadata sync failed', {
      clerkId,
      keys: Object.keys(metadata),
      error: err instanceof Error ? err.message : String(err),
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
    return { ok: false }
  }
}
