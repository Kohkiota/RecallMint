// GET /api/exams/status — 試験一覧の OCR ステータス polling 専用エンドポイント。
//
// S2.0.7 新設。試験一覧 (Server Component) は 1 回 render すると凍結し、OCR が
// 裏で完了しても「処理中」バッジが自動で消えない。client がこのエンドポイントを
// 軽量 polling し、バッジを live 更新するための最小 read endpoint。
//
// 中身は source_documents の DISTINCT ON (exam_id) SELECT (examId / status /
// createdAt、owner-scope、source_docs_user_exam_created_idx 走査) のみ。 exam ごと
// 最新行だけを DB 側で畳むため upload 履歴を全件は読まない (D1 / S2.0c)。 試験一覧
// route 全体 (layout 再 render / cards JOIN+GROUP BY / reconcile 書き込み tx) を
// polling から外す。
//
// reconcile: 15 分超の processing 残骸があれば reconcileStaleProcessing を
// ここで実行する (polling 文脈なので await 可)。ページ遷移の render から
// reconcile を撤去した代わりの DB cleanup 経路。
//
// Cache-Control: no-store で polling 結果が proxy/CDN にキャッシュされないよう強制。
//
// 認証非対称: UnauthenticatedError → 401 (wrapper が処理)。それ以外の auth エラーは
// rethrow (framework default 500、no-store なし)。この挙動は既存の非対称を保存し
// authFailEvent を設定しないことで実現する。

import { and, desc, eq } from 'drizzle-orm'
import { withReadOnlyAuth } from '@/lib/auth/with-read-only-auth'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { sourceDocuments, uploadOperations } from '@/lib/db/schema'
import {
  STALE_PROCESSING_MS,
  deriveDocStatuses,
  deriveExamStatuses,
} from '@/lib/exams/derive-exam-statuses'
import {
  isLiveUploadOperationCondition,
  reconcileStaleProcessing,
} from '@/lib/exams/source-doc-status'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// `?doc=<uuid>` の抽出。 uuid v1-v8 の canonical 形だけを通す(それ以外は null =
// 無視)。 URL 自体が壊れている場合も null(poll を 500 にしない)。
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseDocParam(req: Request): string | null {
  let raw: string | null
  try {
    raw = new URL(req.url).searchParams.get('doc')
  } catch {
    return null
  }
  return raw !== null && UUID_RE.test(raw) ? raw : null
}

export const GET = withReadOnlyAuth(
  {
    // Clerk session はあるが users 行が未 sync (sign-up race) → 空 statuses を返す。
    // docStatuses も空で返す(②-4a S-4): poll する client は「key 不在 = まだ
    // 結果が出ていない」として待ち続ける — completed へ誤って倒さない。
    emptyBody: { statuses: {}, docStatuses: {} },
    // authFailEvent なし → 予期しない auth エラーは rethrow (framework default 500)。
    // この非対称は既存挙動を保存する (他 3 route の 500+no-store 統一とは異なる)。
  },
  async (user, headers, req) => {
    try {
      const now = new Date()
      // ②-4a S-4 fix round 2(Codex P2): poll する client が **自分の doc を名指しで**
      // 問い合わせるための optional param。 下の主 query は DISTINCT ON (exam_id) で
      // exam ごと最新 1 件に縮約するため、同じ exam に 2 件目の upload が入ると
      // 1 件目の doc が `docStatuses` から落ちる。 client は key 不在を「まだ処理中」
      // として扱うので、実際には completed でも絶対上限(20 分)まで待たされる。
      // param 経由で 1 件だけ足せばこの構造的依存が切れる。
      // uuid 形式でなければ**無視**する(400 にしない): poll endpoint は壊れるより
      // 無害側に倒す。 加えて素の文字列を PK 比較に渡すと Postgres が 22P02 で
      // 落ち、poll 全体が 500 になる。
      const requestedDocId = parseDocParam(req)
      // owner-scope 必須。examId / status / createdAt の 3 列のみ取得する。
      // D1 (S2.0c): DISTINCT ON (exam_id) + ORDER BY exam_id, created_at DESC で
      // exam ごと最新の source_document 1 行のみを DB 側で畳む。
      const rows = await withTenantTx(user.id, (tx) =>
        tx
          .selectDistinctOn([sourceDocuments.examId], {
            examId: sourceDocuments.examId,
            id: sourceDocuments.id,
            status: sourceDocuments.status,
            createdAt: sourceDocuments.createdAt,
          })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.userId, user.id))
          .orderBy(sourceDocuments.examId, desc(sourceDocuments.createdAt)),
      )

      // T14a fix round 2(Codex P2#1): live な upload_operations を持つ
      // source_document は reconciler と同じ述語(isLiveUploadOperationCondition)
      // で保護し、15 分超でも processing 表示のまま維持する(getExamStatusMap と
      // 同型の fix — この polling endpoint は独自に同じ query を持つため個別に
      // 適用する必要がある)。 失敗時は空集合に degrade(= legacy と同じ挙動)。
      let liveOpSourceDocumentIds = new Set<string>()
      try {
        const liveRows = await withTenantTx(user.id, (tx) =>
          tx
            .selectDistinct({ sourceDocumentId: uploadOperations.sourceDocumentId })
            .from(uploadOperations)
            .where(
              and(eq(uploadOperations.userId, user.id), isLiveUploadOperationCondition()),
            ),
        )
        liveOpSourceDocumentIds = new Set(
          liveRows
            .map((r) => r.sourceDocumentId)
            .filter((id): id is string => id !== null),
        )
      } catch (err) {
        logger.warn({ event: 'api.exams.status.live_ops_failed', userId: user.id, err })
      }

      // 表示用 status map。deriveExamStatuses が 15 分超 processing を failed に倒す
      // (live-op 保護がある場合を除く)。
      const statuses = deriveExamStatuses(rows, now, liveOpSourceDocumentIds)

      // ②-4a 単一 invocation S-4(spec 2026-08-04 §5): doc 粒度の status を
      // **additive** に足す。 upload page が自分の source_document 1 件を poll して
      // completed で result page へ auto-nav / failed で中断案内を出すための最小
      // 情報で、既存 `statuses`(exam 粒度)と exam-status-live.tsx は無改変。
      // owner-scope は上の SELECT(user_id 絞り)が担保する = 他人の doc は
      // そもそも rows に入らない。
      //
      // fix round 2: 名指しされた doc が DISTINCT ON から漏れている場合だけ、
      // PK 引き 1 件を足す(owner-scope を query 自体でも明示 = 他人の doc は
      // 0 行で返る)。 rows に既に居るなら追加 query は撃たない。
      const docRows = [...rows]
      if (requestedDocId !== null && !rows.some((r) => r.id === requestedDocId)) {
        const extra = await withTenantTx(user.id, (tx) =>
          tx
            .select({
              examId: sourceDocuments.examId,
              id: sourceDocuments.id,
              status: sourceDocuments.status,
              createdAt: sourceDocuments.createdAt,
            })
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.id, requestedDocId),
                eq(sourceDocuments.userId, user.id), // owner-scope 必須
              ),
            )
            .limit(1),
        )
        docRows.push(...extra)
      }
      const docStatuses = deriveDocStatuses(docRows, now, liveOpSourceDocumentIds)

      // 15 分超の processing 残骸があれば DB cleanup を実行する。
      // D1 後 rows は exam ごと最新行のみ。 hasStale は「いずれかの exam の最新が
      // stale processing か」を見る。 reconcile は user の stale processing 行を
      // 全件 status='failed' 化するため、 superseded な古い残骸もまとめて回収される。
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
        {
          statuses: Object.fromEntries(statuses),
          docStatuses: Object.fromEntries(docStatuses),
        },
        { status: 200, headers },
      )
    } catch (err) {
      // best-effort: polling endpoint の DB エラーで client を壊さない。
      // client は !res.ok のレスポンスを無視し、現状のバッジ表示を維持する。
      logger.warn({ event: 'api.exams.status.failed', userId: user.id, err })
      return Response.json({ error: 'internal' }, { status: 500, headers })
    }
  },
)
