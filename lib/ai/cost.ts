// Gemini 2.5 token → JPY cost 推定 (本実装側、 source_documents / upload_records の
// ocr_cost_yen 計上用)。
//
// 由来: scripts/ocr-poc/cost.ts (commit 26a1c4e、 commit 0a5ec0d で削除済)。
// PoC では「概算」 目的だったが、 本実装でも MVP は同じ単価 + JPY/USD レートで
// 円コストを推定する。 公式値が変わったら本 file の定数を手動更新する。
// S1.9.2: ocr_cost_yen 列が numeric(10,4) 化されたため (S1.9.1)、 integer 丸めを
// 廃止し小数 4 桁で保持する。

// USD per 1M tokens (2026-05 時点の概算、 公式値が変わったら手動更新)
const PRICING_USD_PER_1M: Record<
  ModelKind,
  { input: number; output: number }
> = {
  flash: { input: 0.3, output: 2.5 },
  pro: { input: 1.25, output: 10.0 },
}

const JPY_PER_USD = 150

export type ModelKind = 'flash' | 'pro'

// 小数 4 桁で四捨五入 (DB 列 ocr_cost_yen は numeric(10,4))。 integer 丸めだと
// 1 ページ規模の sub-yen コストが 0 円に潰れ集計が不正確になるため、 4 桁精度で
// 保持する。
export function estimateCostYen(
  model: ModelKind,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING_USD_PER_1M[model]
  const usd =
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output
  return Math.round(usd * JPY_PER_USD * 10_000) / 10_000
}

export function modelId(kind: ModelKind): string {
  return kind === 'flash' ? 'gemini-2.5-flash' : 'gemini-2.5-pro'
}
