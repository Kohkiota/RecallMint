// source-doc-status — 試験一覧ページ向け OCR 処理状態ヘルパー。
//
// 提供する 4 エクスポート:
//   1. STALE_PROCESSING_MS  — timeout 判定の閾値定数
//   2. deriveExamStatuses   — 純関数: rows → Map<examId, status>
//   3. getExamStatusMap     — DB 取得 + deriveExamStatuses の組み合わせ
//   4. reconcileStaleProcessing — best-effort DB cleanup (stale processing → failed)
//
// 設計方針:
//   - 一覧ページの render を絶対に止めないため、DB 関数はすべて例外を握りつぶす。
//   - 表示 fallback (deriveExamStatuses) と DB cleanup (reconcileStaleProcessing) を
//     分離することで、cleanup 失敗時も表示は正しく維持される。

import { and, eq, lt } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { sourceDocuments, uploadRecords } from '@/lib/db/schema'
import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// STALE_PROCESSING_MS
// ---------------------------------------------------------------------------
// Vercel Pro Function の maxDuration は 600s。 OCR pipeline はその上限内で完了する
// はずだが、予期しない中断 (Vercel 強制終了 / network error など) で status が
// 'processing' のまま残ることがある。
// 600s × 1.5 ≒ 900s = 15 分をマージンとして設定し、それ以上前の 'processing' 行を
// 「事実上 timeout」 として failed 扱いに変換する。
export const STALE_PROCESSING_MS = 15 * 60 * 1000 // 900,000 ms

// ---------------------------------------------------------------------------
// deriveExamStatuses — 純関数
// ---------------------------------------------------------------------------
// DB アクセスなし・副作用なしの純関数として実装し、テスト容易性を担保。
// DB cleanup が失敗しても「表示だけ正しくする」 fallback の役割も兼ねる。
//
// ロジック: exam ごとに createdAt 最新の source_document を起点に判定。
//   - completed → Map に entry なし (完了 exam にはバッジ不要)
//   - failed    → 'failed'
//   - processing かつ 15 分以内 → 'processing'
//   - processing かつ 15 分超   → 'failed' (= stale timeout 残骸の表示 fallback)
export function deriveExamStatuses(
  rows: Array<{
    examId: string
    status: 'processing' | 'completed' | 'failed'
    createdAt: Date
  }>,
  now: Date,
): Map<string, 'processing' | 'failed'> {
  // exam ごとに「最新 (createdAt が最大) の行」を特定する
  const latestByExam = new Map<
    string,
    { status: 'processing' | 'completed' | 'failed'; createdAt: Date }
  >()

  for (const row of rows) {
    const current = latestByExam.get(row.examId)
    // 同一 examId の中で createdAt が最も新しいものだけを保持する
    if (!current || row.createdAt.getTime() > current.createdAt.getTime()) {
      latestByExam.set(row.examId, {
        status: row.status,
        createdAt: row.createdAt,
      })
    }
  }

  const result = new Map<string, 'processing' | 'failed'>()

  for (const [examId, { status, createdAt }] of latestByExam) {
    if (status === 'completed') {
      // completed exam はバッジ不要 — Map に entry を作らない
      continue
    }
    if (status === 'failed') {
      result.set(examId, 'failed')
      continue
    }
    // status === 'processing'
    const ageMs = now.getTime() - createdAt.getTime()
    if (ageMs >= STALE_PROCESSING_MS) {
      // STALE_PROCESSING_MS 超過: timeout 残骸として表示上 failed 扱いにする。
      // DB cleanup (reconcileStaleProcessing) が失敗しても表示は正しく維持される。
      result.set(examId, 'failed')
    } else {
      result.set(examId, 'processing')
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// getExamStatusMap
// ---------------------------------------------------------------------------
// ユーザーの source_documents を最小列で全件取得し、deriveExamStatuses に委譲。
// status での絞り込みをしない理由: 「最新が completed かどうか」を正しく判定するには
// すべての status の行が必要 (過去の failed + 最新 completed → 出さない、など)。
//
// best-effort 設計:
//   - DB エラーで一覧ページの render を止めないため全体を try-catch で包む。
//   - 失敗時は空 Map を返す (バッジなし表示)。reconcileStaleProcessing と同じ方針。
export async function getExamStatusMap(
  userId: string,
  now: Date = new Date(),
): Promise<Map<string, 'processing' | 'failed'>> {
  try {
    const db = getDb()
    const rows = await db
      .select({
        examId: sourceDocuments.examId,
        status: sourceDocuments.status,
        createdAt: sourceDocuments.createdAt,
      })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.userId, userId)) // owner-scope 必須
    return deriveExamStatuses(rows, now)
  } catch (err) {
    // best-effort: 一時的な DB エラーで一覧ページの render を落とさないよう warn のみ。
    // バッジ表示が消えるだけで、exam 一覧自体は正常に表示される。
    logger.warn({ event: 'source_documents.get_status_map.failed', userId, err })
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// reconcileStaleProcessing
// ---------------------------------------------------------------------------
// 15 分以上 'processing' のまま残った source_documents を best-effort で
// status='failed' に変換し、 失敗台帳 (upload_records) に append する。
//
// best-effort 設計:
//   - 全体を try-catch で包み、例外時は logger.warn のみ。throw しない。
//   - 一覧ページの render を落とさないための安全弁。
//   - deriveExamStatuses による表示 fallback が機能するため、この cleanup が
//     失敗しても「表示だけ正しい」状態は維持される。
//
// 二重計上回避:
//   - UPDATE ... RETURNING で実際に processing→failed に変えた行のぶんだけを
//     upload_records に INSERT する (= 0 件更新なら upload_records に触らない)。
export async function reconcileStaleProcessing(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const db = getDb()
    const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS)

    await db.transaction(async (tx) => {
      // 1. stale processing 行を failed に UPDATE し、更新行の id / filename /
      //    fileSizeBytes を返す (二重計上回避のため RETURNING 結果のみを起点にする)
      const updated = await tx
        .update(sourceDocuments)
        .set({
          status: 'failed',
          errorMessage: '処理時間の上限を超えたため中断されました',
        })
        .where(
          and(
            eq(sourceDocuments.userId, userId), // owner-scope 必須
            eq(sourceDocuments.status, 'processing'),
            lt(sourceDocuments.createdAt, staleThreshold),
          ),
        )
        .returning({
          id: sourceDocuments.id,
          filename: sourceDocuments.filename,
          fileSizeBytes: sourceDocuments.fileSizeBytes,
        })

      // 2. 実際に更新された行が 0 件なら upload_records には触らない
      //    (空配列 INSERT は避けつつ、不要な DB round-trip も防ぐ)
      if (updated.length === 0) return

      // 3. 更新した行それぞれについて upload_records に failed 台帳行を append。
      //    markFailed (process.ts) と同じ値の入れ方: pagesProcessed=0, ocrCostYen=0。
      //    月次 quota SUM は status='completed' のみ対象のため、消費には計上されない。
      await tx.insert(uploadRecords).values(
        updated.map((row) => ({
          userId,
          filename: row.filename,
          fileSizeBytes: row.fileSizeBytes,
          pagesProcessed: 0,
          ocrCostYen: 0,
          status: 'failed' as const,
        })),
      )
    })
  } catch (err) {
    // best-effort: cleanup 失敗は warn のみ、throw しない。
    // deriveExamStatuses による表示 fallback が維持されるため影響範囲は最小。
    logger.warn({
      event: 'source_documents.reconcile_stale.failed',
      userId,
      err,
    })
  }
}
