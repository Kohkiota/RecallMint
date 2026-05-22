// GET /api/exams/status — 試験一覧の OCR ステータス polling 専用エンドポイント。
//
// S2.0.7 新設。試験一覧 (Server Component) は 1 回 render すると凍結し、OCR が
// 裏で完了しても「処理中」バッジが自動で消えない。client がこのエンドポイントを
// 軽量 polling し、バッジを live 更新するための最小 read endpoint。
//
// 中身は source_documents の最小 SELECT (examId / status / createdAt、owner-scope、
// 既存 index source_docs_status_idx 直撃) のみ。試験一覧 route 全体 (layout 再
// render / cards JOIN+GROUP BY / reconcile 書き込み tx) を polling から外す。
//
// reconcile: 15 分超の processing 残骸があれば reconcileStaleProcessing を
// ここで実行する (polling 文脈なので await 可)。ページ遷移の render から
// reconcile を撤去した代わりの DB cleanup 経路。
//
// Cache-Control: no-store で polling 結果が proxy/CDN にキャッシュされないよう強制。

import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import { sourceDocuments, type User } from '@/lib/db/schema'
import {
  STALE_PROCESSING_MS,
  deriveExamStatuses,
  reconcileStaleProcessing,
} from '@/lib/exams/source-doc-status'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }

  // -- 認証 --
  // middleware の isProtectedRoute は /app(.*) のみ対象で /api は protect されない。
  // 未ログインは getCurrentUser が UnauthenticatedError を throw するため 401 化する。
  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401, headers })
    }
    throw err
  }
  // Clerk session はあるが users 行が未 sync (sign-up race) → 空 statuses を返す。
  if (!user) {
    return Response.json({ statuses: {} }, { status: 200, headers })
  }

  try {
    const now = new Date()
    // owner-scope 必須。examId / status / createdAt の 3 列のみ取得する。
    const rows = await getDb()
      .select({
        examId: sourceDocuments.examId,
        status: sourceDocuments.status,
        createdAt: sourceDocuments.createdAt,
      })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.userId, user.id))

    // 表示用 status map。deriveExamStatuses が 15 分超 processing を failed に倒す。
    const statuses = deriveExamStatuses(rows, now)

    // 15 分超の processing 残骸があれば DB cleanup を実行する。
    // 表示は deriveExamStatuses が既に failed 扱いにしているため、reconcile は
    // DB 整合 (status=failed / upload_records 台帳 append) のためだけに走る。
    const hasStale = rows.some(
      (row) =>
        row.status === 'processing' &&
        now.getTime() - row.createdAt.getTime() >= STALE_PROCESSING_MS,
    )
    if (hasStale) {
      await reconcileStaleProcessing(user.id, now)
    }

    return Response.json(
      { statuses: Object.fromEntries(statuses) },
      { status: 200, headers },
    )
  } catch (err) {
    // best-effort: polling endpoint の DB エラーで client を壊さない。
    // client は !res.ok のレスポンスを無視し、現状のバッジ表示を維持する。
    logger.warn({ event: 'api.exams.status.failed', userId: user.id, err })
    return Response.json({ error: 'internal' }, { status: 500, headers })
  }
}
