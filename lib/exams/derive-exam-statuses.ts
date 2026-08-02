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
// PREPARED_RETENTION_MS
// ---------------------------------------------------------------------------
// ②-4a T14a(spec §11「grace > operation が非終端で再開可能な最大保持期間」)。
// 「非終端で再開可能な最大保持期間」= 7 日。 canonical な定義をここに置く理由:
// `app/(app)/app/upload/_actions/claim-operation.ts`(7 日保持 cap の claim-time
// 判定)と本 file 下流の `reconcileStaleProcessing`(T14a fix round 1: 非終端
// upload_operations による stale sweep 除外を「再開可能な間だけ」に絞る
// window-aware 判定)の**両方**がこの値を要求するが、eslint Block A
// (`lib/`/`components/` は `app/` layer を import 禁止)により `lib/exams/*` から
// `app/(app)/app/upload/_lib/constants.ts` を参照できない。 ゆえに `lib/` 側に
// 正本を置き、`app/(app)/app/upload/_lib/constants.ts` はこれを re-export する
// (upload 側の既存 import 経路を変えない)。 GC grace(現行 30 日・画像 GC v2)より
// 確実に短くする不変条件(grace > 保持)を保つ値として 7 日を採用。
export const PREPARED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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
//     'processing' (T14a fix round 2・Codex P2#1: reconciler の window-aware
//     除外と表示を一致させる — live な upload_operations を持つ source は
//     7 日 retention の間 DB 上も 'processing' のまま残るため、表示だけが
//     独自に 15 分超で failed 化するのは reconciler と矛盾する)
//
// `liveOpSourceDocumentIds` は呼出元(getExamStatusMap)が別 query で用意した
// source_document id の集合(reconcileStaleProcessing と同じ
// isLiveUploadOperationCondition 述語)。 既定は空集合 — legacy 呼出(この
// パラメータを渡さない/渡せない)は今までどおり「15 分超 → failed」のみで判定
// される(挙動不変)。
export function deriveExamStatuses(
  rows: Array<{
    examId: string
    id: string
    status: 'processing' | 'completed' | 'failed'
    createdAt: Date
  }>,
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
    const ageMs = now.getTime() - createdAt.getTime()
    if (ageMs >= STALE_PROCESSING_MS && !liveOpSourceDocumentIds.has(id)) {
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
