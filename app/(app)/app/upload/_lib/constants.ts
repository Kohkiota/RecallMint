// Upload UI 制限値。 Vercel Server Action body 上限 (4.5MB) + Vercel Pro 関数
// timeout (900s) を踏まえた client 側検証用。

// 1 file 圧縮後の目安。 画像は browser-image-compression で maxSizeMB に渡す値。
export const MAX_IMAGE_FILE_MB = 0.5
export const MAX_IMAGE_WIDTH_OR_HEIGHT = 2048

// 合計 (圧縮後画像 + PDF 原本) の上限。 Vercel Server Action body 上限 4.5MB の
// 安全マージンを取り 4MB。
export const TOTAL_UPLOAD_LIMIT_MB = 4

// PDF 1 file の page 数上限 (per-file 上限、 per-upload 合計上限 OCR_MAX_PAGES とは別軸)。
// 超過時は該当ファイルを error 表示し submit 不可にする。
export const MAX_PDF_PAGES = 40

// 各定数の bytes 換算 (MB は 1_000_000、 1024 系統一しない 平易化重視)。
export const MB = 1_000_000
export const TOTAL_UPLOAD_LIMIT_BYTES = TOTAL_UPLOAD_LIMIT_MB * MB
