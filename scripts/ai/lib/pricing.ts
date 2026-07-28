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
// spec §10)。未知モデル、または promptTokenCount / candidatesTokenCount が undefined(欠測)
// の場合は null(=N/A)を返す — この2つは成功呼び出しで常に API から返るため、欠測は
// 「呼び出しが usage を報告しなかった」= 真に算出不能を意味する(0 として扱うと安価に見せか
// ける虚偽の数値になる)。一方 thoughtsTokenCount は optional field で、モデルが thinking を
// 行わなかった場合(例: gemini-3.1-flash-lite / gemini-3.5-flash-lite 等の lite 系)は API
// レスポンスから丸ごと省略される。この欠測は「未計測」ではなく「0 課金」を意味するため、
// undefined を null 化せず 0 として扱う(そうしないと thinking をしない安価なモデルほど N/A
// になり、比較したいコスト効率の良いモデルが軒並み算出不能になってしまう)。
export function estimateUsdPerImage(u: GeminiUsage, modelId: string): number | null {
  const price = PRICE_TABLE[modelId]
  if (!price) return null

  const { promptTokenCount, candidatesTokenCount, thoughtsTokenCount } = u
  if (promptTokenCount === undefined || candidatesTokenCount === undefined) {
    return null
  }

  const billedOutputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)
  return (promptTokenCount * price.input) / 1_000_000 + (billedOutputTokens * price.output) / 1_000_000
}
