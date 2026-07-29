// Gemini 2.5 token → JPY cost 推定 (本実装側、 source_documents / upload_records の
// ocr_cost_yen 計上用)。
//
// 由来: scripts/ocr-poc/cost.ts (commit 26a1c4e、 commit 0a5ec0d で削除済)。
// PoC では「概算」 目的だったが、 本実装でも MVP は同じ単価 + JPY/USD レートで
// 円コストを推定する。 公式値が変わったら本 file の定数を手動更新する。
// S1.9.2: ocr_cost_yen 列が numeric(10,4) 化されたため (S1.9.1)、 integer 丸めを
// 廃止し小数 4 桁で保持する。

// USD per 1M tokens (公式値が変わったら手動更新)。
// flash = 主 OCR モデル。②-2 で lite 系モデルへ移行し単価も lite 値へ更新した
// (実体のモデル ID は modelId() が単一 source ゆえここでは綴らない)。lite 単価の
// 出典 = scripts/ai/lib/pricing.ts PRICE_TABLE の lite 系エントリ。ここは JPY 本体
// 計上(ModelKind キー)ゆえ pricing.ts(USD eval・model 文字列キー)とは別テーブル
// だが lite 単価は一致させる(drift 注意)。
const PRICING_USD_PER_1M: Record<
  ModelKind,
  { input: number; output: number }
> = {
  flash: { input: 0.25, output: 1.5 },
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

// ModelKind 'flash' は主 OCR モデルの歴史的ラベル(②-2 で実体は lite 系へ移行)。
// 実体のモデル ID はこの modelId() の返り値が単一 source — ラベルやコメントに
// 実体 ID を重複させない(二重書きすると次の移行で片方だけ直して矛盾する)。
export function modelId(kind: ModelKind): string {
  return kind === 'flash' ? 'gemini-3.1-flash-lite' : 'gemini-2.5-pro'
}
