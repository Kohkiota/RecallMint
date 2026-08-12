// Gemini 2.5 token → JPY cost 推定。
//
// 読み手 (Sprint B (DB 全体掃除) で DB 永続化を廃止した後): upload 失敗時のエラー詳細
// 表示のみ (ocr.ts の costYen → upload-error-types.ts → upload-form.tsx)。旧 source_documents
// / upload_records の ocr_cost_yen 列は読み手ゼロのまま残っていたため migration 0036 で削除した。
//
// 由来: scripts/ocr-poc/cost.ts (commit 26a1c4e、 commit 0a5ec0d で削除済)。
// PoC では「概算」 目的だったが、 本実装でも MVP は同じ単価 + JPY/USD レートで
// 円コストを推定する。 公式値が変わったら本 file の定数を手動更新する。

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

// 小数 4 桁で四捨五入。 integer 丸めだと 1 ページ規模の sub-yen コストが 0 円に
// 潰れ、エラー詳細の表示が「コスト 0」に見えてしまうため 4 桁精度で保持する。
export function estimateCostYen(
  model: ModelKind,
  inputTokens: number,
  outputTokens: number,
  thoughtsTokens = 0,
): number {
  const p = PRICING_USD_PER_1M[model]
  // thinking(thoughtsTokens)は output 単価で課金される(公式・②-0 helper pricing.ts と同式)。
  // thinking しないモデル(lite 系)は欠測 = 0 ゆえ第 4 引数省略で従来どおり。
  const usd =
    (inputTokens / 1_000_000) * p.input +
    ((outputTokens + thoughtsTokens) / 1_000_000) * p.output
  return Math.round(usd * JPY_PER_USD * 10_000) / 10_000
}

// ModelKind 'flash' は主 OCR モデルの歴史的ラベル(②-2 で実体は lite 系へ移行)。
// 実体のモデル ID はこの modelId() の返り値が単一 source — ラベルやコメントに
// 実体 ID を重複させない(二重書きすると次の移行で片方だけ直して矛盾する)。
export function modelId(kind: ModelKind): string {
  return kind === 'flash' ? 'gemini-3.1-flash-lite' : 'gemini-2.5-pro'
}
