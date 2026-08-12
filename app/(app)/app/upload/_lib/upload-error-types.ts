// 失敗時の error code (UI 側で分岐に使用、 T4 詳細表示用 details も含む)。
//   AUTH:                    認証なし / user.id 取得失敗
//   INVALID_INPUT:           formData の mode / examId / files が不正
//   EXAM_NOT_FOUND:          既存 exam が見つからない
//   UPLOAD_IN_PROGRESS:      同一 user の OCR ジョブが既に走行中 (S1.9.4)
//                            advisory xact lock 取得失敗 (ms 窓の race) または
//                            in-flight processing 行が存在 (先行ジョブ走行中) の
//                            いずれかで発生する。
//   PAGE_LIMIT_EXCEEDED:     1 回の upload の合算 totalPages が OCR_MAX_PAGES (40) 超過
//   SIZE_LIMIT_EXCEEDED:     1 回の upload の合算 totalSize が TOTAL_UPLOAD_LIMIT_BYTES (4MB) 超過
//   QUOTA_EXCEEDED:          月次 OCR ページ上限 超過
//   GEMINI_DAILY_LIMIT_EXCEEDED: サービス全体の 1 日 Gemini call 上限超過 (S1.8)
//   GEMINI_FAILED:           OCR pipeline (Flash) 失敗
//   SAVE_FAILED:             OCR は成功したが DB 保存 (cards INSERT) 失敗
//   OTHER:                   上記いずれにも該当しない予期しないエラー
export type ProcessUploadErrorCode =
  | 'AUTH'
  | 'INVALID_INPUT'
  | 'EXAM_NOT_FOUND'
  | 'UPLOAD_IN_PROGRESS'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'GEMINI_DAILY_LIMIT_EXCEEDED'
  | 'GEMINI_FAILED'
  | 'SAVE_FAILED'
  | 'OTHER'

// 開発環境 (staging / preview / development) のみで UI 表示する詳細情報。
// production では client に渡されるが UI には表示されない (T4 環境変数判定)。
export type ProcessUploadErrorDetails = {
  rawError?: string
  sourceDocumentId?: string
  costYen?: number
  modelChain?: string[]
  // QUOTA_EXCEEDED 専用 fields
  current?: number
  limit?: number
  requested?: number
}
