// scripts 専用の Gemini raw 呼び出し。 本番 lib/ai/clients/gemini.ts の callGemini と
// 同じ HTTP 呼び出し形状 (parts / config.responseJsonSchema / abortSignal) を踏襲しつつ、
// 本番の modelId() 変換や retry/fallback 判定は経由しない 1 回呼び出しの薄いラッパー。
// ②-0 OCR regression 基盤 (capture / model-compare / box_2d-viz スクリプトが共有)。
//
// 本番との違い:
// - modelId は呼び出し側が渡す raw string をそのまま使う (modelId() 変換を通さない)。
// - retry は一切しない (429 含め single call・そのまま throw)。
// - usage は欠測フィールドを 0 に潰さず undefined のまま返す (N/A 判別を下流に残す)。
// - timeout は AbortController の signal 送出 (best-effort cancel) だけに頼らず、
//   Promise.race で wrapper 自身の promise を timeoutMs で必ず settle させる。
//   SDK が abortSignal を無視して request を握り続けても呼び出し側を無限に待たせない
//   (無人実行の capture/compare batch script には外側の Vercel function timeout の
//   ような backstop が無いための保険)。

import { GoogleGenAI } from '@google/genai'
import type { GeminiInputFile } from '@/lib/ai/clients/gemini'

// OCR は複数ページの重い生成で数分かかることがあるため、 本番 (lib/ai/clients/gemini.ts)
// と同じ 220s をデフォルトにする。 呼び出し側は timeoutMs で上書き可能。
export const DEFAULT_TIMEOUT_MS = 220_000

let _ai: GoogleGenAI | null = null

function getAi(): GoogleGenAI {
  if (_ai) return _ai
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  _ai = new GoogleGenAI({ apiKey })
  return _ai
}

export type GeminiRawCallInput = {
  modelId: string
  files: GeminiInputFile[]
  prompt: string
  responseJsonSchema: Record<string, unknown>
  timeoutMs?: number
}

export type GeminiRawUsage = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export type GeminiRawCallResult = {
  text: string
  finishReason: string | undefined
  usage: GeminiRawUsage
}

// 1 回の generateContent 呼び出し。 retry / fallback なし (呼び出し側の責務)。
export async function callGeminiRaw(
  p: GeminiRawCallInput,
): Promise<GeminiRawCallResult> {
  const ai = getAi()
  const parts = [
    ...p.files.map((f) => ({
      inlineData: { mimeType: f.mimeType, data: f.data },
    })),
    { text: p.prompt },
  ]
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  // best-effort cancel (本番 gemini.ts と同型)。 SDK が abortSignal を尊重すれば
  // ここで HTTP request 自体も打ち切られる。
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  // wrapper 自身の promise を timeoutMs で必ず settle させるための reject 用 promise。
  // controller の abort event に同期的に載せる (setTimeout callback → abort() →
  // このリスナーが同一 tick で reject するため、 SDK 側が abortSignal を無視して
  // 何秒待っても resolve/reject しない場合でも Promise.race がここで確定する)。
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`Gemini call timeout: ${timeoutMs}ms を超過しました`))
    })
  })
  let res
  try {
    res = await Promise.race([
      ai.models.generateContent({
        model: p.modelId,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: p.responseJsonSchema,
          abortSignal: controller.signal,
        },
      }),
      timeoutPromise,
    ])
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Gemini call timeout: ${timeoutMs}ms を超過しました`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }

  // SDK が abortSignal を無視して abort 後に resolve するケースへの防御:
  // abort 済みなら、たとえ res が届いていても成功として採用しない
  // (Promise.race 自体が timeoutPromise 側の reject を先に採用するため通常はここへ
  // 到達しないが、 二重の safety net として残す)。
  if (controller.signal.aborted) {
    throw new Error(`Gemini call timeout: ${timeoutMs}ms を超過しました`)
  }

  const text = res.text
  if (!text) throw new Error('Gemini returned empty response.text')

  // FinishReason は @google/genai の string union enum。 下流は素の string として
  // 扱いたいので明示的に string | undefined へ寄せる。
  const finishReason = res.candidates?.[0]?.finishReason as string | undefined

  // usageMetadata の各フィールドは欠測時 undefined のまま返す (0 に潰さない)。
  // 欠測 = 「そのカウントが N/A」であり「0 トークン」ではないため、 下流の集計/表示で
  // 区別できる必要がある。
  const usageMetadata = res.usageMetadata
  const usage: GeminiRawUsage = {
    promptTokenCount: usageMetadata?.promptTokenCount,
    candidatesTokenCount: usageMetadata?.candidatesTokenCount,
    thoughtsTokenCount: usageMetadata?.thoughtsTokenCount,
    totalTokenCount: usageMetadata?.totalTokenCount,
  }

  return { text, finishReason, usage }
}
