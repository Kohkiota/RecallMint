// Gemini モデルの公式標準単価 ($/1M tokens) と、1 画像あたりの実コスト算出。
// 出典 https://ai.google.dev/gemini-api/docs/pricing (standard/同期 tier)、取得日 2026-07-28。
// ②-0 OCR regression 基盤(T6 compare / T7 box2d-viz が消費する pure 関数)。

export type ModelPrice = { input: number; output: number }

export const PRICE_TABLE: Record<string, ModelPrice> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
}

export type GeminiUsage = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
}

// 課金 output = candidatesTokenCount + thoughtsTokenCount(公式: thinking は output 単価・
// spec §10)。未知モデル、または算出に必要な token count のいずれかが undefined(欠測)の
// 場合は null(=N/A)を返す — 欠測を 0 として扱うと安価に見せかける虚偽の数値になるため。
export function estimateUsdPerImage(u: GeminiUsage, modelId: string): number | null {
  const price = PRICE_TABLE[modelId]
  if (!price) return null

  const { promptTokenCount, candidatesTokenCount, thoughtsTokenCount } = u
  if (
    promptTokenCount === undefined ||
    candidatesTokenCount === undefined ||
    thoughtsTokenCount === undefined
  ) {
    return null
  }

  const billedOutputTokens = candidatesTokenCount + thoughtsTokenCount
  return (promptTokenCount * price.input) / 1_000_000 + (billedOutputTokens * price.output) / 1_000_000
}
