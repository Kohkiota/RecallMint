// @google/genai SDK の薄ラッパー。 module-load 時には API key の存在を要求せず、
// 初回 callGemini 時に env から読む (test では vi.mock 経由で完全に差し替える前提)。
//
// PoC `scripts/ocr-poc/run.ts` の `callGemini` を本実装側で再利用可能な形に分離。
// pipeline 側 (`lib/ai/ocr.ts`) で Flash/Pro 切替 + retry + fallback を担う、
// 本 file は 1 回の API call の責務のみ。

import { GoogleGenAI } from '@google/genai'
import { modelId, type ModelKind } from '../cost'

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
  const res = await ai.models.generateContent({
    model: modelId(input.model),
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      // discover mode は additionalProperties が必要なため responseJsonSchema
      // 経路を使う (OpenAPI subset の responseSchema 経路は非採用)。
      responseJsonSchema: input.responseJsonSchema,
    },
  })
  const text = res.text
  if (!text) throw new Error('Gemini returned empty response.text')
  const usage = res.usageMetadata ?? {}
  return {
    text,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  }
}
