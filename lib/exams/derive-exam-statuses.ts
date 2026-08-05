// derive-exam-statuses — 試験一覧ページ向け OCR 処理状態の純粋層。
//
// DB アクセスなし・副作用なしの pure module。
//   1. STALE_PROCESSING_MS — timeout 判定の閾値定数
//   2. deriveExamStatuses  — 純関数: rows → Map<examId, status>
//
// DB 関数 (getExamStatusMap / reconcileStaleProcessing / hasLiveUploadOperation)
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
// SourceDocumentStatusRow / isStaleProcessingRow
// ---------------------------------------------------------------------------
// exam 粒度(deriveExamStatuses)と doc 粒度(deriveDocStatuses)の 2 つの導出は
// 同じ入力行から計算し、「processing をいつ failed 表示に倒すか」の規則も同じで
// なければならない — 一方だけが stale 判定を持つと、試験一覧のバッジと upload
// page の poll が同じ source_document について別の結論を出す。規則をこの 1 箇所に
// 置いて両方から使う。
export type SourceDocumentStatusRow = {
  examId: string
  id: string
  status: 'processing' | 'completed' | 'failed'
  createdAt: Date
}

function isStaleProcessingRow(
  row: SourceDocumentStatusRow,
  now: Date,
  liveOpSourceDocumentIds: ReadonlySet<string>,
): boolean {
  return (
    now.getTime() - row.createdAt.getTime() >= STALE_PROCESSING_MS &&
    !liveOpSourceDocumentIds.has(row.id)
  )
}

// ---------------------------------------------------------------------------
// deriveDocStatuses — 純関数(②-4a 単一 invocation S-4)
// ---------------------------------------------------------------------------
// upload page の poll(/api/exams/status の `docStatuses`)用。exam 粒度の
// `statuses` と違い **completed を明示値で返す**(key 不在ではない)— poll する
// client は「まだ結果が無い」と「完了した」を区別する必要があり、key 不在を
// completed とみなす設計だと、まだ作られていない doc / 他人の doc / 取得失敗が
// すべて「完了」に見えてしまう。
//
// stale 判定は deriveExamStatuses と共有(isStaleProcessingRow)。呼出側が渡す
// 行集合の owner-scope は SQL 側の責務(route.ts が user_id で絞る)。
export function deriveDocStatuses(
  rows: Array<SourceDocumentStatusRow>,
  now: Date,
  liveOpSourceDocumentIds: ReadonlySet<string> = new Set(),
): Map<string, 'processing' | 'completed' | 'failed'> {
  const result = new Map<string, 'processing' | 'completed' | 'failed'>()
  for (const row of rows) {
    if (row.status === 'processing') {
      result.set(
        row.id,
        isStaleProcessingRow(row, now, liveOpSourceDocumentIds) ? 'failed' : 'processing',
      )
    } else {
      result.set(row.id, row.status)
    }
  }
  return result
}

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
//   - processing かつ 15 分超 かつ live-op 保護なし → 'failed' (= stale timeout
//     残骸の表示 fallback)
//   - processing かつ 15 分超 だが liveOpSourceDocumentIds に id あり →
//     'processing' (T14a fix round 2・Codex P2#1: reconciler の live-op 除外と
//     表示を一致させる — live な upload_operations(valid lease)を持つ source は
//     lease が切れるまで DB 上も 'processing' のまま残るため、表示だけが
//     独自に 15 分超で failed 化するのは reconciler と矛盾する)
//
// `liveOpSourceDocumentIds` は呼出元(getExamStatusMap)が別 query で用意した
// source_document id の集合(reconcileStaleProcessing と同じ
// isLiveUploadOperationCondition 述語)。 既定は空集合 — legacy 呼出(この
// パラメータを渡さない/渡せない)は今までどおり「15 分超 → failed」のみで判定
// される(挙動不変)。
export function deriveExamStatuses(
  rows: Array<SourceDocumentStatusRow>,
  now: Date,
  liveOpSourceDocumentIds: ReadonlySet<string> = new Set(),
): Map<string, 'processing' | 'failed'> {
  // exam ごとに「最新 (createdAt が最大) の行」を特定する
  const latestByExam = new Map<
    string,
    { id: string; status: 'processing' | 'completed' | 'failed'; createdAt: Date }
  >()

  for (const row of rows) {
    const current = latestByExam.get(row.examId)
    // 同一 examId の中で createdAt が最も新しいものだけを保持する
    if (!current || row.createdAt.getTime() > current.createdAt.getTime()) {
      latestByExam.set(row.examId, {
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
      })
    }
  }

  const result = new Map<string, 'processing' | 'failed'>()

  for (const [examId, { id, status, createdAt }] of latestByExam) {
    if (status === 'completed') {
      // completed exam はバッジ不要 — Map に entry を作らない
      continue
    }
    if (status === 'failed') {
      result.set(examId, 'failed')
      continue
    }
    // status === 'processing'
    if (
      isStaleProcessingRow(
        { examId, id, status, createdAt },
        now,
        liveOpSourceDocumentIds,
      )
    ) {
      // STALE_PROCESSING_MS 超過 かつ live-op 保護なし: timeout 残骸として
      // 表示上 failed 扱いにする。 DB cleanup (reconcileStaleProcessing) が
      // 失敗しても表示は正しく維持される。
      result.set(examId, 'failed')
    } else {
      result.set(examId, 'processing')
    }
  }

  return result
}
