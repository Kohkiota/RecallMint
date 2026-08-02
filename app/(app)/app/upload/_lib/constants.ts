// Upload UI 制限値。 body size 上限は 2 段で決まる点に注意 (再発防止):
//   1. Next.js framework default = **1MB**。 `next.config.ts` の
//      `experimental.serverActions.bodySizeLimit` で明示 raise しないと、
//      Server Action 本体に到達する前に framework 層で 413 が投げられる。
//   2. Vercel platform hard limit = **4.5MB** (vercel.com/docs/functions/limitations
//      "Request body size")。 これ以上は platform 側で FUNCTION_PAYLOAD_TOO_LARGE。
// 本 client cap (4MB) は `next.config.ts` の `bodySizeLimit: '4.5mb'` と整合させた
// 値: 4MB + multipart overhead ≒ 4.1MB 弱で 4.5MB platform 上限の内側に収まる。
// Vercel Pro 関数 timeout (900s) も合わせて踏まえた client 側検証用。

// 1 file 圧縮後の目安。 画像は browser-image-compression で maxSizeMB に渡す値。
export const MAX_IMAGE_FILE_MB = 0.5
export const MAX_IMAGE_WIDTH_OR_HEIGHT = 2048

// 合計 (圧縮後画像 + PDF 原本) の上限。 Vercel platform body 上限 4.5MB + Next.js
// `bodySizeLimit: '4.5mb'` 設定 (next.config.ts) と整合させた client cap。
// 安全マージンを取り 4MB。
export const TOTAL_UPLOAD_LIMIT_MB = 4

// PDF 1 file の page 数上限 (per-file 上限、 per-upload 合計上限 OCR_MAX_PAGES とは別軸)。
// 超過時は該当ファイルを error 表示し submit 不可にする。
export const MAX_PDF_PAGES = 40

// 各定数の bytes 換算 (MB は 1_000_000、 1024 系統一しない 平易化重視)。
export const MB = 1_000_000
export const TOTAL_UPLOAD_LIMIT_BYTES = TOTAL_UPLOAD_LIMIT_MB * MB

// ②-4a T6(claim-operation.ts)の lease TTL(spec §2)。claim/takeover 時に
// `lease_expires_at = now + LEASE_TTL_MS` を設定し、期限切れ lease は次の claim
// 呼出が takeover できる(claimable WHERE の一部)。spec §2 の注記どおり、現行
// Vercel 関数上限(800s)< この lease(15分)ゆえ「lease 保持中に同一実行が生存し
// 続ける」通常ケースは起きない —lease はライブネス保証ではなく、
// 状態機械の正当性(fencing の CAS token)を担保するための値。
// claim-operation.ts はファイル先頭に 'use server' を持つため定数を直接 export
// できず(Next.js の "use server" file 制約 — 非 async 関数の export は compile
// error)、この directive 無し共有 file に置く(claim-operation.ts / iso test の
// 両方がここから import する)。
export const LEASE_TTL_MS = 15 * 60 * 1000

// ②-4a T8b(stage-prepared.ts)の retryable-failed backoff(暫定値)。 Gemini
// call が technical に失敗した(rate-limited / transient 尽き / JSON parse 不能
// 等)operation を再 claim 可能にするまでの待機時間。 spec §2 は
// `attempt_count++`/`next_retry_at`/`last_error_code` を記録する、とだけ定め
// 具体的な backoff 式は規定していない(exponential 化・7 日 terminal 化は T14
// の範囲)。 固定 1 分は「ユーザーが手動 retry しても Gemini を秒間隔で叩かない」
// 最小限の安全弁として選んだ暫定値 — T14 で式ごと再設計されうる前提で単独
// 定数として持つ(HTTP-level retry の backoff とは別軸、混同しない)。
export const RETRYABLE_BACKOFF_MS = 60 * 1000

// ②-4a T14a(claim-operation.ts)の「非終端で再開可能な最大保持期間」(spec §11:
// 「grace > operation が非終端で再開可能な最大保持期間」/ 「retryable prepared
// 保持 最大 7 日 / 7 日超で terminal_failed・payload NULL 化」)。 measured from
// `upload_operations.created_at`(insert 時のみ設定される不変フィールド — 他の
// どの update も書き換えない。 claim-operation.ts / prepare-upload.ts で確認済)。
// GC grace(現行 30 日・画像 GC v2)より確実に短くする不変条件を保つ値として 7 日を
// 採用(30 日 > 7 日 を維持したまま運用値を変える場合は両方を見直す)。
//
// T14a fix round 1(Codex P1): 正本は `lib/exams/derive-exam-statuses.ts` に
// 置く(`lib/exams/source-doc-status.ts` の `reconcileStaleProcessing` も同じ
// 値を要求するが、eslint Block A が `lib/` からの `app/` layer import を禁止
// するため lib 側で定義せざるを得ない)。 ここは再 export のみ — upload 側の
// 既存 import 経路(`claim-operation.ts` 等)を変えないための互換維持。
export { PREPARED_RETENTION_MS } from '@/lib/exams/derive-exam-statuses'

// ②-4a T14a(publish-prepared.ts Step B)の crop フェーズ全体の time budget
// (spec §11 deadline)。 新 prepare→publish 方式では OCR(stage-prepared.ts・
// 別 invocation)と crop(publishPreparedUpload の Step B・本 invocation)が
// 別の server action 呼出に分かれているため、 現行 `OCR_OVERALL_DEADLINE_MS`
// (ocr.ts・720s・OCR 専用)をそのまま流用しない — この定数は crop フェーズ専用の
// 独立予算(この呼出の開始時刻起点・per-invocation。 operation 全体を跨ぐ
// deadline は持たない — 2026-08-02 OT 確定)。 暫定値 — cutover 後の実測で見直す。
export const CROP_PHASE_BUDGET_MS = 600 * 1000

// crop 1 件を新たに試みるために要求する最低残り予算(spec §11「crop 最低予算」・
// soft pre-crop gate)。 暫定値 — cutover 後の実測で見直す(2026-08-02 OT 確定:
// 時間予算の精緻化は測定前に決め打ちしない)。
export const CROP_MIN_REMAINING_MS = 5 * 1000

