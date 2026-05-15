// Gemini 2.5 価格 (USD per 1M tokens, 2026-05 時点の概算)。
// 公式値が変わったら手動更新する。PoC のコスト推定用なので厳密性は求めない。
const PRICING_USD_PER_1M: Record<'flash' | 'pro', { input: number; output: number }> = {
  flash: { input: 0.3, output: 2.5 },
  pro: { input: 1.25, output: 10.0 },
}

const JPY_PER_USD = 150

export type ModelKind = 'flash' | 'pro'

export function estimateCostYen(
  model: ModelKind,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING_USD_PER_1M[model]
  const usd = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
  return Math.round(usd * JPY_PER_USD * 1000) / 1000
}

export function modelId(kind: ModelKind): string {
  return kind === 'flash' ? 'gemini-2.5-flash' : 'gemini-2.5-pro'
}
