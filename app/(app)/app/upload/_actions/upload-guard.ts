import { eq, and, sql, gte } from 'drizzle-orm'
import { exams, sourceDocuments, type User } from '@/lib/db/schema'
import { setTenantContext } from '@/lib/db/tenant-tx'
import { canRunOcr } from '@/lib/ai-usage-mcq'
import { getTodayAiUsageGlobal } from '@/lib/ai-usage-counter'
import { logger } from '@/lib/logger'
import { todayInJst } from '@/lib/jst'
import { STALE_PROCESSING_MS } from '@/lib/exams/derive-exam-statuses'
import type { getDb } from '@/lib/db'

// FormData から受け取った投入先選択 (前端 Destination 型と整合)。
export type Destination =
  | { mode: 'new' }
  | { mode: 'existing'; examId: string }

// guard transaction の戻り値を discriminated union で表現
export type GuardTxResult =
  | { outcome: 'in_progress' }
  | { outcome: 'quota_exceeded'; current: number; limit: number; requested: number }
  | { outcome: 'daily_limit_exceeded'; current: number; limit: number }
  | { outcome: 'exam_not_found'; archived: boolean }
  | { outcome: 'success'; examId: string; examName: string; sourceDocumentId: string }

// GEMINI_DAILY_LIMIT 環境変数を Number に変換。 未設定 / 不正値 / 0 以下は
// null を返し guard を off にする (.env.example で 1000 を default 提示済、
// 想定外の設定で本番が止まることを避ける)。
//
// T-A3 (audit §10.3 (b) #6): production (VERCEL_ENV='production') では未設定 /
// 不正値で fail-fast。 quota 機構が silent に no-op になり実際の Gemini 課金 API へ
// 無制限に流れる事故を防ぐ。 preview / dev は従来通り null fallback (= guard off)。
function parseDailyLimit(raw: string | undefined): number | null {
  // T-A3 (audit §10.3 (b) #6): production では未設定 / 不正値で fail-fast、
  // 非 prod は従来通り null fallback。 throw 文言は audit 参照 (sprint spec が
  // archive されても安定、 review minor #2 反映)。
  const failed = (): null => {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error(
        'GEMINI_DAILY_LIMIT must be set in production (see audit §10.3 (b) #6)',
      )
    }
    return null
  }
  if (!raw) return failed()
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return failed()
  return n
}

export async function runUploadGuardTx(
  db: ReturnType<typeof getDb>,
  user: User,
  destination: Destination,
  meta: { filename: string; fileType: 'pdf' | 'image'; totalSize: number; totalPages: number },
): Promise<GuardTxResult> {
  return await db.transaction(async (tx): Promise<GuardTxResult> => {
    // RLS-P2: owner-scoped tx の冒頭で tenant context (app.user_id GUC) を張る。
    await setTenantContext(tx, user.id)

    // (a) advisory xact lock — 同時起動 (ms 窓) の race loser を弾く
    // postgres-js + drizzle: execute<T>() は RowList<T[]> (Array-like) を返す。
    // 旧 neon-serverless の .rows ラッピングは消失したので直接 index access。
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${user.id})) AS locked`,
    )
    const locked = lockResult[0]?.locked
    if (!locked) {
      return { outcome: 'in_progress' }
    }

    // (b) in-flight 行 check — 先行ジョブ走行中 (lock 解放済) の並列起動を弾く
    // STALE_PROCESSING_MS (= 15 分) window: processing 残骸 (stale orphan) による
    // 誤発火を防ぐ。markFailed / 完了 tx が実行されなかった source_document は
    // STALE_PROCESSING_MS 超過後に guard を通過できる
    // (その後 OT が手動 update する想定、 S1.9.1 コメント参照)。
    // STALE_PROCESSING_MS を source-doc-status.ts と共有することで、 UI guard
    // (hasActiveProcessingUpload) と server guard の判定閾値が drift しない。
    const inflightThreshold = new Date(Date.now() - STALE_PROCESSING_MS)
    const inflight = await tx
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.userId, user.id),
          eq(sourceDocuments.status, 'processing'),
          gte(sourceDocuments.createdAt, inflightThreshold),
        ),
      )
      .limit(1)
    if (inflight.length > 0) {
      return { outcome: 'in_progress' }
    }

    // (c) plan-limits guard — 月次 OCR ページ上限
    // RLS-P2 §6.6: canRunOcr / getTodayAiUsageGlobal は guard tx (tx) をそのまま受け取り
    // 別 getDb() 接続を開かない (旧: 純粋 read helper として tx 外接続を掴んでいた → pool 圧)。
    const decision = await canRunOcr(user.id, user.plan, meta.totalPages, tx)
    if (!decision.ok) {
      return {
        outcome: 'quota_exceeded',
        current: decision.current,
        limit: decision.limit,
        requested: decision.requested,
      }
    }

    // (d) GEMINI_DAILY_LIMIT guard — サービス全体の日次 Gemini call 上限
    // CLAUDE.md §AI API 絶対ルール 3: 無料枠運用前提の安全弁。
    // guard off (null) のケースは logger.warn で可視化 (review I-4 準拠)。
    const dailyLimit = parseDailyLimit(process.env.GEMINI_DAILY_LIMIT)
    if (dailyLimit === null) {
      logger.warn({
        event: 'gemini.daily_limit.disabled',
        raw: process.env.GEMINI_DAILY_LIMIT ?? null,
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      })
    } else {
      const todayCount = await getTodayAiUsageGlobal(tx)
      if (todayCount >= dailyLimit) {
        return {
          outcome: 'daily_limit_exceeded',
          current: todayCount,
          limit: dailyLimit,
        }
      }
    }

    // (e) exam 確定 (新規 INSERT or 既存 validate) + source_documents INSERT
    // これらを advisory lock と同一 tx に含めることで、 lock が INSERT commit まで保持される。
    // → lock 解放直後に in-flight 行 check が通過するため、 並列起動を確実に弾ける。
    let resolvedExamId: string
    let resolvedExamName: string
    if (destination.mode === 'new') {
      // 仮 name は JST date + HH:mm 形式。 ユーザーは S2 で rename 可能。
      const today = todayInJst()
      const nowJst = new Date(Date.now() + 9 * 3600 * 1000)
      const hh = String(nowJst.getUTCHours()).padStart(2, '0')
      const mm = String(nowJst.getUTCMinutes()).padStart(2, '0')
      resolvedExamName = `アップロード ${today} ${hh}:${mm}`
      const inserted = await tx
        .insert(exams)
        .values({ userId: user.id, name: resolvedExamName })
        .returning({ id: exams.id })
      resolvedExamId = inserted[0].id
    } else {
      // 既存 exam の所有者 + archived 状態を validate
      const found = await tx
        .select({ id: exams.id, name: exams.name, archivedAt: exams.archivedAt })
        .from(exams)
        .where(and(eq(exams.id, destination.examId), eq(exams.userId, user.id)))
        .limit(1)
      if (found.length === 0) {
        return { outcome: 'exam_not_found', archived: false }
      }
      if (found[0].archivedAt !== null) {
        return { outcome: 'exam_not_found', archived: true }
      }
      resolvedExamId = found[0].id
      resolvedExamName = found[0].name
    }

    const sourceDocInsert = await tx
      .insert(sourceDocuments)
      .values({
        userId: user.id,
        examId: resolvedExamId,
        mode: destination.mode,
        fileType: meta.fileType,
        filename: meta.filename,
        fileSizeBytes: meta.totalSize,
        status: 'processing',
        pagesTotal: meta.totalPages,
      })
      .returning({ id: sourceDocuments.id })

    return {
      outcome: 'success',
      examId: resolvedExamId,
      examName: resolvedExamName,
      sourceDocumentId: sourceDocInsert[0].id,
    }
  })
}
