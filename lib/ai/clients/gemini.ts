// @google/genai SDK の薄ラッパー。 module-load 時には API key の存在を要求せず、
// 初回 callGemini 時に env から読む (test では vi.mock 経由で完全に差し替える前提)。
//
// PoC `scripts/ocr-poc/run.ts` の `callGemini` を本実装側で再利用可能な形に分離。
// pipeline 側 (`lib/ai/ocr.ts`) で Flash/Pro 切替 + retry + fallback を担う、
// 本 file は 1 回の API call の責務のみ。

import { GoogleGenAI } from '@google/genai'
import { logger } from '@/lib/logger'
import { isLogGateOpen } from '@/lib/env/log-gate'
import { modelId, type ModelKind } from '../cost'

// OCR は複数ページを一括生成する重い処理であり数分かかることがあるため、
// Vercel Pro function timeout (900s) に収まる範囲で十分な余裕を持った 220s に設定。
// AbortController で client 側から打ち切り、 ocr.ts の isTransientError が
// /timeout/i でマッチして retry 対象と判定できるよう message に "timeout" を残す。
// export 済み(②-4a 単一 invocation S-2): 呼出側が「次の attempt を始めてよいか」を
// 判断するのに 1 attempt の最悪所要時間が要るため。値の複製を避ける(drift すると
// 判断が静かに誤る)。
export const GEMINI_TIMEOUT_MS = 220_000

let _ai: GoogleGenAI | null = null

function getAi(): GoogleGenAI {
  if (_ai) return _ai
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  _ai = new GoogleGenAI({ apiKey })
  return _ai
}

// Test hook: cached client を reset。 production code からは呼ばない。
export function _resetClientForTests(): void {
  _ai = null
}

export type GeminiInputFile = {
  mimeType: string
  // base64-encoded file bytes (PDF or image)
  data: string
}

// generateContent の contents[0].parts の 1 要素。 text または inlineData (画像)。
// ②-4a 探索 (lib/ai/clients/ocr-image-crop-parts.ts の source_id-interleaved parts)
// が GeminiCallInput.parts の型としてもこれを共有する。
export type GeminiContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

export type GeminiCallInput = {
  model: ModelKind
  files: GeminiInputFile[]
  prompt: string
  responseJsonSchema: Record<string, unknown>
  // ②-4a 探索専用 (optional)。 指定時は files/prompt から parts を自動組立てず、
  // この配列をそのまま contents[0].parts に使う (source_id-interleaved parts を
  // 渡すため。spec §5.2)。 files/prompt は型の一貫性のため引き続き必須だが、
  // parts 指定時は未使用。既存 caller はこの field を渡さないため挙動は不変
  // (後方互換、 lib/ai/ocr.ts の本番 pipeline は無改修)。
  parts?: GeminiContentPart[]
}

export type GeminiCallResult = {
  text: string
  inputTokens: number
  outputTokens: number
  // thinking トークン。thinking しないモデル(lite 系)は API 欠測ゆえ 0。
  // cost 計上で output 単価課金に加算する(estimateCostYen 第 4 引数)。
  thoughtsTokens: number
}

// @google/genai SDK の ApiError (generateContent が throw するクラス) は
// status と message のみを持ち、 Retry-After header は SDK 内部の retry ループで
// 消費されてユーザーコードに露出しない (index.mjs の retryRequest を確認済み)。
// 将来 SDK が headers を公開した場合や、 headers を持つ APIError 系クラスが
// 到達した場合に備えて、 Headers インターフェースを探索する実装にしている。
// 現状の標準的な 429 パスでは null を返す。
export function parseRetryAfterMs(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null

  // headers プロパティが Headers (Web API) であれば Retry-After 系 header を探す。
  // retry-after-ms は非標準だが @google/genai 内部でも参照されている形式。
  const maybeHeaders = (err as Record<string, unknown>).headers
  if (maybeHeaders != null && typeof (maybeHeaders as Headers).get === 'function') {
    const headers = maybeHeaders as Headers

    const retryAfterMs = headers.get('retry-after-ms')
    if (retryAfterMs) {
      const ms = parseFloat(retryAfterMs)
      if (!Number.isNaN(ms)) return ms > 0 ? ms : null
    }

    const retryAfter = headers.get('retry-after')
    if (retryAfter) {
      const seconds = parseFloat(retryAfter)
      if (!Number.isNaN(seconds)) return seconds > 0 ? seconds * 1_000 : null

      // HTTP date 形式 (例: "Wed, 21 Oct 2025 07:28:00 GMT")
      const date = Date.parse(retryAfter)
      if (!Number.isNaN(date)) {
        const ms = date - Date.now()
        return ms > 0 ? ms : null
      }
    }
  }

  return null
}

// 1 回の generateContent 呼び出し。 retry / fallback は pipeline 側担当。
export async function callGemini(
  input: GeminiCallInput,
): Promise<GeminiCallResult> {
  const ai = getAi()
  const parts =
    input.parts ??
    [
      ...input.files.map((f) => ({
        inlineData: { mimeType: f.mimeType, data: f.data },
      })),
      { text: input.prompt },
    ]
  // AbortController で SDK の HTTP request を client 側から打ち切る
  // (@google/genai GenerateContentConfig.abortSignal、 client-side cancel)。
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
  let res
  try {
    res = await ai.models.generateContent({
      model: modelId(input.model),
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        // discover mode は additionalProperties が必要なため responseJsonSchema
        // 経路を使う (OpenAPI subset の responseSchema 経路は非採用)。
        responseJsonSchema: input.responseJsonSchema,
        abortSignal: controller.signal,
      },
    })
  } catch (err) {
    // timeout 由来の abort は message に「timeout」 を含む error に正規化する。
    // → ocr.ts の isTransientError が /timeout/i で retry 対象と判定し、
    //   ルール 6 の指数バックオフ retry に乗せる。
    if (controller.signal.aborted) {
      throw new Error(
        `Gemini call timeout: ${GEMINI_TIMEOUT_MS}ms を超過しました`,
      )
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }

  const text = res.text
  if (!text) throw new Error('Gemini returned empty response.text')

  // OCR debug: OCR_DEBUG_LOG=1 のときのみ raw response を log に出す。 prod では
  // LOG_GATE_ALLOW_PROD=1 も併せて要する 2 段 gate (audit §10.3 (b) #5、 lib/env/log-gate.ts)。
  // Vercel log の 1 行サイズ上限対策で先頭 50000 文字に truncate し、 元の長さは
  // textLength に残す。 env 未設定 (本番デフォルト) は no-op。
  if (isLogGateOpen('OCR_DEBUG_LOG')) {
    logger.info({
      event: 'ocr.gemini.response',
      model: input.model,
      textPreview: text.slice(0, 50000),
      textLength: text.length,
    })
  }

  const usage = res.usageMetadata ?? {}
  return {
    text,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    thoughtsTokens: usage.thoughtsTokenCount ?? 0,
  }
}
