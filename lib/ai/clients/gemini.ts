// @google/genai SDK の薄ラッパー。 module-load 時には API key の存在を要求せず、
// 初回 callGemini 時に env から読む (test では vi.mock 経由で完全に差し替える前提)。
//
// PoC `scripts/ocr-poc/run.ts` の `callGemini` を本実装側で再利用可能な形に分離。
// pipeline 側 (`lib/ai/ocr.ts`) で Flash/Pro 切替 + retry + fallback を担う、
// 本 file は 1 回の API call の責務のみ。

import { GoogleGenAI } from '@google/genai'
import { logger } from '@/lib/logger'
import { modelId, type ModelKind } from '../cost'

// CLAUDE.md AI 絶対ルール 6「タイムアウト必須 (30 秒)」。 1 回の Gemini call が
// 30 秒以内に応答しなければ AbortController で client 側から打ち切る。
const GEMINI_TIMEOUT_MS = 30_000

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

export type GeminiCallInput = {
  model: ModelKind
  files: GeminiInputFile[]
  prompt: string
  responseJsonSchema: Record<string, unknown>
}

export type GeminiCallResult = {
  text: string
  inputTokens: number
  outputTokens: number
}

// 1 回の generateContent 呼び出し。 retry / fallback は pipeline 側担当。
export async function callGemini(
  input: GeminiCallInput,
): Promise<GeminiCallResult> {
  const ai = getAi()
  const parts = [
    ...input.files.map((f) => ({
      inlineData: { mimeType: f.mimeType, data: f.data },
    })),
    { text: input.prompt },
  ]
  // 30 秒 timeout。 abortSignal で SDK の HTTP request を client 側から打ち切る
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

  // OCR debug: OCR_DEBUG_LOG=1 (staging 専用) のときのみ raw response を log に出す。
  // Vercel log の 1 行サイズ上限対策で先頭 50000 文字に truncate し、 元の長さは
  // textLength に残す。 env 未設定 (本番デフォルト) は no-op。
  if (process.env.OCR_DEBUG_LOG === '1') {
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
  }
}
