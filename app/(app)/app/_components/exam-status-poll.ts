// exam-status-poll — 試験一覧 OCR ステータス polling の純ロジック。
//
// React に依存しない純関数として切り出し、polling の「router.refresh() を
// 1 回発火する遷移判定」をユニットテスト可能にする。source-doc-status.ts の
// deriveExamStatuses と同じ「副作用ロジックを純関数で分離」方針。

export type ExamStatus = 'processing' | 'failed'

// examId → status の map。completed exam は entry を持たない (バッジ不要)。
export type ExamStatusMap = Record<string, ExamStatus>

// statuses のうち status === 'processing' の examId 集合を返す。
export function processingIds(statuses: ExamStatusMap): Set<string> {
  const ids = new Set<string>()
  for (const [examId, status] of Object.entries(statuses)) {
    if (status === 'processing') ids.add(examId)
  }
  return ids
}

// 直前 poll で processing だった examId のうち、最新 poll で processing で
// なくなったもの (= completed で map から消えた / failed に変化) が 1 件でも
// あれば true。「processing → completed/failed」遷移の検知に使う。
export function hasCompletion(
  prevProcessing: Set<string>,
  nextProcessing: Set<string>,
): boolean {
  for (const examId of prevProcessing) {
    if (!nextProcessing.has(examId)) return true
  }
  return false
}
