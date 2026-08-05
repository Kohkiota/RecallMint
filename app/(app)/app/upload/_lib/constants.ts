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
// route の maxDuration(720s・page.tsx)< この lease(15分)ゆえ「lease 保持中に
// 同一実行が生存し続ける」通常ケースは起きない —lease はライブネス保証ではなく、
// 状態機械の正当性(fencing の CAS token)を担保するための値。
// ②-4a 単一 invocation 経路(submit-upload.ts)は同じ不等式を「実行中 invocation の
// 生存表明」として使う(720s + margin 180s ≤ この値・pin test で機械強制)。
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

// ②-4a 単一 invocation 経路(submit-upload.ts → upload-pipeline.ts)の統合 time
// budget(spec 2026-08-04 §11)。 起点は **action 入口時刻**(sync tx の消費分も
// 予算内)。 route の maxDuration(720s・page.tsx)より 60s 短い。
//
// **この 60s 差だけでは超過を防げない**(canonical review I-1・実際の算術):
// 1 回の Gemini call は最悪 `GEMINI_TIMEOUT_MS`(220s)、`callImageCropWithRetry` は
// 初回 + 2 retries = 3 attempts で backoff は Retry-After 有りなら最大 60s×2 /
// 無しなら 5s + 20s(+ jitter 最大 7s)。 ゆえに Gemini phase 単体の最悪値は
//   Retry-After 有り: 3×220 + 2×60 = **780s**(maxDuration 720s すら超える)
//   Retry-After 無し: 3×220 + 25〜32 = **685〜692s**(本予算 660s を超える)
// で、呼出直前の残余チェック 1 回では防げない(pre-call 時点では残余が足りている)。
// → 実効的な歯止めは `callImageCropWithRetry` の `deadlineAt`(retry ループの内側で
// 「残余 < GEMINI_TIMEOUT_MS なら次の attempt を始めない」)。 本定数はそこへ渡す
// 予算の起点であり、60s 差は「最後の attempt が timeout 一杯まで走っても
// maxDuration に届かない」ための余白ではなく、terminal 化 + log の書込に要する余白。
//
// **暫定値 — cutover 後の実測で見直す**(2026-08-02 OT 方針: 時間予算の精緻化は
// 測定前に決め打ちしない。phase 別所要時間を logger.warn で出しているのが材料)。
export const UPLOAD_PIPELINE_BUDGET_MS = 660 * 1000

// ②-4a 単一 invocation S-4: upload page の完了検知 poll(/api/exams/status の
// `docStatuses`)。 5 秒間隔は spec 2026-08-04 §5 の確定値。
export const DOC_STATUS_POLL_INTERVAL_MS = 5 * 1000

// poll の縮退条件 1: 連続で fetch に失敗した回数(ネットワーク断 / 5xx)。到達したら
// poll を止めて「試験一覧で確認」へ倒す(既存 kick session の「error で無限 poll」を
// 再現しない)。
export const DOC_STATUS_POLL_MAX_FETCH_FAILURES = 6

// poll の縮退条件 2: 絶対上限。 `processing` が返り続ける hard-death ケース
// (after() の callback が死に、lease 失効 → reconciler 収束を待つ間)で poll が
// 無限に続くのを防ぐ(Codex #7)。 **暫定値**(時間予算と同じく実測後に見直す)。
export const DOC_STATUS_POLL_LIMIT_MS = 20 * 60 * 1000

// ②-4a 単一 invocation S-4: 「この upload がどうなったか今この場では確定できない」
// ときの**公開文言(単一の正)**。 spec 論点 A の確定事項どおり **待ち時間の数値を
// 書かない / 試験の削除を案内しない**。
//
// 適用面は 4 つ(同じ状況を別の言い方で説明しないための単一定義):
//   ① upload page の poll が `failed` を返したとき
//   ② `submitUpload` が `in_progress`(別 op が valid lease を保持)を返したとき
//   ③ `/app/upload` 再訪時の「処理中」カード(hasActiveProcessingUpload)
//   ④ result page の失敗パネル(S-3 で導入)
// ②③ に同じ文言を当てるのは、どちらも「生きている実行」と「死んだが lease が
// まだ切れていない実行」を **アプリ側から区別できない**ため — 「実行中です」と
// 断定すると、既に死んでいる場合に嘘になる。
export const UPLOAD_INTERRUPTED_NOTICE =
  '処理が中断された可能性があります。 しばらく待ってから再度お試しください。 処理状況は試験一覧で確認できます。'

// crop 1 件を新たに試みるために要求する最低残り予算(spec §11「crop 最低予算」・
// soft pre-crop gate)。 暫定値 — cutover 後の実測で見直す(2026-08-02 OT 確定:
// 時間予算の精緻化は測定前に決め打ちしない)。
export const CROP_MIN_REMAINING_MS = 5 * 1000

