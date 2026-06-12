// Spec §3.3 / §5.2 / §6.1
// 削除完了 polling endpoint。public auth (Clerk auth() 呼び出しなし)。
// クライアント (sign-out-deleted ページ手前の delete-button polling) が **signed
// token** を渡し、Clerk → DB 伝播の 4 段階ステータスを返す。 Cache-Control: no-store
// で中間キャッシュ防止。
//
// audit §10.4 #11 / T-A9 重要 fix: 旧仕様は `userId` query param を直接受領 →
// 他者の userId で polling 可能 = 削除 status 漏洩。 HMAC-SHA256 + ttl 24h signed
// token (lib/security/deletion-token.ts) で予測可能性を排除し、 token 保持者
// (= 削除を実行した本人) のみが自身の status を確認できる。

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { users } from '@/lib/db/schema'
import type { User } from '@/lib/db/schema'
import { verifyDeletionToken } from '@/lib/security/deletion-token'

export const runtime = 'nodejs'

// Clerk userId の正規表現。"user_" + 英数字 1 文字以上。
// token を decode した後の defense-in-depth check。 通常 token は server-side で
// 生成されており format 一致が保証されるが、 secret 漏洩後の改ざん経路で
// 防御層として残す。
const USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/

type DeletionStatus = 'not_found' | 'pending' | 'clerk_synced' | 'completed'

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')

  // Cache-Control: no-store で polling 結果が proxy/CDN にキャッシュされないよう強制。
  // 400 / 401 / 410 / 200 全 path に統一付与 (public endpoint で query param 依存の
  // response、 短窓キャッシュも避ける)。
  const headers = { 'Cache-Control': 'no-store' }

  if (!token) {
    return Response.json({ error: 'invalid' }, { status: 400, headers })
  }

  // T-A9: signed token verify。 format / hmac mismatch = 401、 ttl 超過 = 410 Gone。
  const result = verifyDeletionToken(token)
  if (!result.ok) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers })
  }
  if (result.expired) {
    return Response.json({ error: 'token_expired' }, { status: 410, headers })
  }
  const userId = result.userId

  // defense in depth: token 内 userId が Clerk format に従うことを確認 (改ざん経路で
  // SQL に流す前の最終 guard)。
  if (!USER_ID_PATTERN.test(userId)) {
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
