// Spec §3.3 / §5.2 / §6.1
// 削除完了 polling endpoint。public auth (Clerk auth() 呼び出しなし)。
// クライアント (sign-out-deleted ページ) が userId を渡し、Clerk → DB 伝播の
// 4 段階ステータスを返す。Cache-Control: no-store で中間キャッシュ防止。

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import type { User } from '@/lib/db/schema'

export const runtime = 'nodejs'

// Clerk userId の正規表現。"user_" + 英数字 1 文字以上。
// format 不一致は 400 で弾く (DB アクセス前に弾くことで無駄なクエリを排除)。
const USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/

type DeletionStatus = 'not_found' | 'pending' | 'clerk_synced' | 'completed'

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const userId = url.searchParams.get('userId')

  // Cache-Control: no-store で polling 結果が proxy/CDN にキャッシュされないよう強制。
  // 400 / 200 両 path に統一付与 (public endpoint で query param 依存の response、
  // 短窓キャッシュも避ける)。
  const headers = { 'Cache-Control': 'no-store' }

  // Spec §6.1: format 不一致 → 400 { error: 'invalid' }
  if (!userId || !USER_ID_PATTERN.test(userId)) {
    return Response.json({ error: 'invalid' }, { status: 400, headers })
  }

  const rows = await getDb()
    .select()
    .from(users)
    .where(eq(users.clerkId, userId))

  const status = computeStatus(rows[0])
  return Response.json({ status }, { status: 200, headers })
}

/**
 * Spec §3.3 deletion status 4 分岐:
 * - users 行なし         → not_found  (Clerk 削除が DB に伝播していない、またはユーザー不存在)
 * - deletedAt IS NULL   → pending    (Clerk webhook 未着)
 * - deletedAt set + active/past_due → clerk_synced (Stripe 未キャンセル)
 * - deletedAt set + canceled or NULL → completed   (削除完了)
 */
function computeStatus(row: User | undefined): DeletionStatus {
  if (!row) return 'not_found'
  if (row.deletedAt == null) return 'pending'
  if (
    row.subscriptionStatus === 'active' ||
    row.subscriptionStatus === 'past_due'
  ) {
    return 'clerk_synced'
  }
  return 'completed'
}
