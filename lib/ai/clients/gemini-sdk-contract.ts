// @google/genai SDK 型契約: response/param 形の compile-time pin。
//
// 目的: `@google/genai` の版上げで response/param の field が rename / 削除 / 非互換な
// retype をされた場合に `pnpm typecheck` を fail させる、実行されない型のみのガード。
// lib/ai/clients/gemini.ts (callGemini) が実際に読む field と、比較 script
// (docs/superpowers/plans/2026-07-28-ocr-regression-foundation.md T3/T6 相当) が
// 追加で読む thoughtsTokenCount / finishReason を対象にする。
//
// このファイルはどこからも実行時 import されない (下部の export は type-only) ため
// 実行時には評価すらされないが、念のため中身は「呼ばれない関数」に閉じ、 SDK client
// の生成 / API call を一切行わない。
//
// 厳密な型一致 (equality) ではなく「その field が存在し、期待する広い型へ代入可能か」
// のみを見る — SDK 側の無害な narrowing (例: 既存の代入と依然として compatible な
// union へ narrowing されるだけのケース) で false-fail しないため。 field の rename /
// 削除は「そもそも存在しない property」として、非互換な retype は「代入不能」として、
// どちらも型エラーで検知できる。
//
// field チェックは値の binding をせず `expr satisfies T` の式文で行う (この file は
// 数年単位で生き続ける regression guard であり、 binding すると `_` prefix でも
// エディタ上は "declared but never read" のグレーアウトになり、無関係な cleanup で
// 誤って削除される事故を招くため)。
//
// ファイル名に `.test.` を含めない: Vitest の `**/*.test.ts` glob に収集されず (=
// テストとしては実行されない) が、 tsconfig.json の `include: ["**/*.ts", ...]` には
// 含まれるため `pnpm typecheck` (tsc --noEmit) では検査対象になる。

import type {
  FinishReason,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
} from '@google/genai'

// config 形は実際の generateContent 引数型 (`GenerateContentParameters['config']`) から
// 導出する。独自に config interface を手書きすると、 SDK 側の実際の型と乖離しても
// 気づけないため避ける。
type GeminiRequestConfig = NonNullable<GenerateContentParameters['config']>

// lib/ai/clients/gemini.ts の callGemini が読む response field。
// 呼ばれない (compile-time 検査専用)。 各行は `expr satisfies T` の式文のみで
// binding を作らない — field が存在しなければ TS2339、代入不能な retype なら
// satisfies の型エラーで検知する。
function _assertGeminiResponseFieldsShape(res: GenerateContentResponse): void {
  // `const text = res.text` (gemini.ts) が読む。 getter だが構造的には
  // `string | undefined` へ代入可能であることのみを見る。
  res.text satisfies string | undefined

  // `const usage = res.usageMetadata ?? {}` (gemini.ts) が読む。
  res.usageMetadata satisfies GenerateContentResponseUsageMetadata | undefined
  res.usageMetadata?.promptTokenCount satisfies number | undefined
  res.usageMetadata?.candidatesTokenCount satisfies number | undefined
  // 比較 script (T3/T6) がコスト計算で読む。 gemini.ts 本体は未使用。
  res.usageMetadata?.thoughtsTokenCount satisfies number | undefined

  // 比較 script (T3/T6) が正常完了 / 出力上限到達 / 安全停止の判別に読む。
  res.candidates?.[0]?.finishReason satisfies FinishReason | undefined
}

// gemini.ts の `config: { responseMimeType, responseJsonSchema, abortSignal }`
// (callGemini 内の ai.models.generateContent 呼び出し) が実際に埋めている field。
// `satisfies` を実 generateContent 引数型 (GeminiRequestConfig) に対して掛け、
// 存在 + 代入可能性 (excess property check で rename/削除も検知) を見る。
function _assertGeminiRequestConfigShape(): void {
  ;({
    responseMimeType: 'application/json',
    responseJsonSchema: {} as Record<string, unknown>,
    abortSignal: new AbortController().signal,
  } satisfies GeminiRequestConfig)
}

// 上記 2 関数は呼ばれないが、この type-only export (runtime 出力ゼロ、`export type`
// は erasable) で `typeof` 参照することでエディタ上の "declared but never read" 表示
// を消す。 これにより無関係な cleanup での誤削除リスクを下げる。 呼び出しも
// client 生成も一切発生しない (型システムのみで消費される)。
export type _GeminiSdkContract = [
  typeof _assertGeminiResponseFieldsShape,
  typeof _assertGeminiRequestConfigShape,
]
