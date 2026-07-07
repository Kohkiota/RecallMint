// derive-exam-statuses — 試験一覧ページ向け OCR 処理状態の純粋層。
//
// DB アクセスなし・副作用なしの pure module。
//   1. STALE_PROCESSING_MS — timeout 判定の閾値定数
//   2. deriveExamStatuses  — 純関数: rows → Map<examId, status>
//
// DB 関数 (getExamStatusMap / reconcileStaleProcessing / hasActiveProcessingUpload)
// は lib/exams/source-doc-status.ts に残置し、この pure symbol を import して使う。

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
