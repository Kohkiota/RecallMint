// 1 回の upload で受け付ける最大ページ数。
// Gemini のタイムアウト制約 (Vercel Function 900s) と実測コストから導出した実用上限。
// client (upload-form) と server (process.ts) の両方で import して一元管理する。
export const OCR_MAX_PAGES = 40
