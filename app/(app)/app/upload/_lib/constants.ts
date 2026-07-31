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

// ②-4a T4(prepare-upload.ts)の upload_operations「live」判定のうち
// awaiting_sources の経過時間しきい値(暫定値、spec §11・T14 で正本確定)。
// prepare-upload.ts はファイル先頭に 'use server' を持つため定数を直接 export
// できず(Next.js の "use server" file 制約 — 非 async 関数の export は compile
// error)、この directive 無し共有 file に置く(prepare-upload.ts / iso test の
// 両方がここから import する)。
// 旧 source_documents の 15 分窓(STALE_PROCESSING_MS)はそのまま流用しない —
// 新状態機械は prepared の 7 日 retry を持ち意味が異なるため独立値として定義。
export const PREPARE_AWAITING_TTL_MS = 15 * 60 * 1000

// ②-4a T6(claim-operation.ts)の lease TTL(spec §2)。claim/takeover 時に
// `lease_expires_at = now + LEASE_TTL_MS` を設定し、期限切れ lease は次の claim
// 呼出が takeover できる(claimable WHERE の一部)。spec §2 の注記どおり、現行
// Vercel 関数上限(800s)< この lease(15分)ゆえ「lease 保持中に同一実行が生存し
// 続ける」通常ケースは起きない —lease はライブネス保証ではなく、
// 状態機械の正当性(fencing の CAS token)を担保するための値。
// claim-operation.ts はファイル先頭に 'use server' を持つため定数を直接 export
// できず(PREPARE_AWAITING_TTL_MS と同じ Next.js 制約)、この directive 無し
// 共有 file に置く(claim-operation.ts / iso test の両方がここから import する)。
export const LEASE_TTL_MS = 15 * 60 * 1000

