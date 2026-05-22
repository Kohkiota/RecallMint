// OCR pipeline (Flash → HTTP retry → Pro fallback → JSON parse → zod validate)。
//
// 本 file は外部 SDK を直接触らず、 lib/ai/clients/gemini.ts の `callGemini` 経由で
// API 呼び出しする。 test では `vi.mock('@/lib/ai/clients/gemini', ...)` で完全に
// 差し替える前提。
//
// 設計:
// - Flash → 同モデルで transient HTTP error は exponential backoff で最大 2 回 retry
// - JSON parse 失敗 / cards=0 → Pro へ fallback (Pro 側でも HTTP retry 独立適用)
// - Pro でも失敗 → throw (caller = Server Action 側で source_documents.status='failed'
//   + notifyOps Discord + UI に 「混み合っています」 表示)
// - cost は modelChain ベースで per-model token から合算 (Flash 試行 + Pro 試行
//   両方計上、 PoC `--fallback` 挙動踏襲)

import { z } from 'zod'
import { buildDiscoverPrompt } from './prompts/ocr-extract'
import {
  buildDiscoverResponseJsonSchema,
  type ExtractedCard,
} from './schemas/ocr-response'
import { callGemini, type GeminiInputFile } from './clients/gemini'
import { estimateCostYen, type ModelKind } from './cost'

// JSON Schema (Gemini 側 enforcement) に加え、 zod による runtime validation を
// 別途行う。 SDK schema 強制が弱い field (custom_props の anyOf 等) や型 narrow
// のために必要。
const optionSchema = z.object({
  id: z.string(),
  text: z.string(),
  is_correct: z.boolean(),
  explanation: z.string().optional(),
})
const imageSchema = z.object({
  key: z.string(),
  target: z.string(),
  alt: z.string(),
  source_ref: z.string().optional(),
})
const cardSchema = z.object({
  title: z.string(),
  sort_key: z.string().optional(),
  question_text: z.string(),
  options: z.array(optionSchema),
  correct_answer_ids: z.array(z.string()),
  explanation_text: z.string().optional(),
  images: z.array(imageSchema),
  custom_props: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
})
const responseSchema = z.object({
  cards: z.array(cardSchema),
})

export type OcrPipelineResult = {
  cards: ExtractedCard[]
  modelChain: ModelKind[]
  costYen: number
  flashError?: string
  // per-model token usage (debug / notifyOps payload 用)。
  tokenUsage: Array<{
    model: ModelKind
    inputTokens: number
    outputTokens: number
  }>
}

const MAX_HTTP_RETRIES = 2 // 初回 + 2 retries = 計 3 attempts per model

// SDK error の status code / status 文字列は message に含まれる前提 (本実装 SDK
// では code が instance property に出ないことが多く、 message string match が
// pragmatic)。

// 429 (rate limit / quota 超過) 判定。 CLAUDE.md AI 絶対ルール 5「429 受信時は
// 即時停止、 リトライ禁止」 の対象 — retry も Pro fallback もせず即 throw する。
// 429 数字 / "rate limit" / RESOURCE_EXHAUSTED いずれかで判定。
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /\b429\b/.test(msg) ||
    /rate ?limit/i.test(msg) ||
    /resource_exhausted/i.test(msg)
  )
}

// transient (= 指数バックオフ retry 対象) な HTTP error 判定。
// 429 は含めない — ルール 5 により即時停止扱い (isRateLimitError が担当)。
// 5xx (500/502/503/504) と timeout / unavailable のみ retry する。
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /\b(500|502|503|504)\b/.test(msg) ||
    /timeout/i.test(msg) ||
    /unavailable/i.test(msg)
  )
}

async function callWithRetry(
  model: ModelKind,
  files: GeminiInputFile[],
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  onAttempt?: (model: ModelKind) => Promise<void> | void,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
    // onAttempt は callGemini 直前で発火。 成功・失敗・retry すべて 1 回ずつ計上
    // するため retry 内側にも置く (Flash 1st + Flash retry × 2 + Pro 1st + Pro retry × 2
    // 最大 6 回計上の可能性あり)。 callback 失敗 (例: DB エラー) で本処理を巻き
    // 込まないよう try/catch で握りつぶし、 logger 委譲は caller 側に任せる。
    if (onAttempt) {
      try {
        await onAttempt(model)
      } catch {
        // counter 書き込み失敗は OCR 本処理を止めない (ベストエフォート計上)
      }
    }
    try {
      return await callGemini({ model, files, prompt, responseJsonSchema })
    } catch (err) {
      lastErr = err
      // ルール 5: 429 (rate limit) は即時停止。 retry せず即 throw する。
      if (isRateLimitError(err)) throw err
      if (!isTransientError(err) || attempt === MAX_HTTP_RETRIES) throw err
      // attempt2 (最終) は throw 済のため実待機は 500 / 1000 の 2 回のみ。
      const backoffMs = 500 * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw lastErr
}

function parseAndValidate(text: string): ExtractedCard[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}`)
  }
  const result = responseSchema.safeParse(parsed)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `response shape invalid at ${first?.path.join('.') ?? '<root>'}: ${first?.message ?? 'unknown'}`,
    )
  }
  return result.data.cards
}

export async function runOcrPipeline(
  files: GeminiInputFile[],
  opts?: {
    // 各 Gemini call (Flash 初回 + retry, Pro 初回 + retry すべて) の直前に
    // 呼ばれる。 caller (Server Action) はここで ai_usage / ai_usage_users counter
    // を加算する。 callback 失敗は内部で握りつぶす (ベストエフォート計上)。
    onAttempt?: (model: ModelKind) => Promise<void> | void
  },
): Promise<OcrPipelineResult> {
  const prompt = buildDiscoverPrompt()
  const schema = buildDiscoverResponseJsonSchema()

  const modelChain: ModelKind[] = []
  const tokenUsage: OcrPipelineResult['tokenUsage'] = []
  let cards: ExtractedCard[] = []
  let flashError: string | undefined

  // Step 1: Flash with retry
  modelChain.push('flash')
  try {
    const flash = await callWithRetry('flash', files, prompt, schema, opts?.onAttempt)
    tokenUsage.push({
      model: 'flash',
      inputTokens: flash.inputTokens,
      outputTokens: flash.outputTokens,
    })
    cards = parseAndValidate(flash.text)
    if (cards.length === 0) throw new Error('Flash returned 0 cards')
  } catch (e) {
    flashError = e instanceof Error ? e.message : String(e)

    // ルール 5: Flash が 429 (rate limit) なら Pro fallback もせず即停止する。
    // Pro へ移ると rate-limit 中の API を再度叩くことになり「即時停止」 に反する。
    if (isRateLimitError(e)) {
      throw new Error(
        `OCR pipeline failed (Flash rate limited, Pro fallback skipped): ${flashError}`,
      )
    }

    // Step 2: Pro fallback (HTTP retry も Pro 側で独立に適用)
    modelChain.push('pro')
    let pro
    try {
      pro = await callWithRetry('pro', files, prompt, schema, opts?.onAttempt)
    } catch (proErr) {
      const proMsg = proErr instanceof Error ? proErr.message : String(proErr)
      throw new Error(
        `OCR pipeline failed (Flash: ${flashError}; Pro: ${proMsg})`,
      )
    }
    tokenUsage.push({
      model: 'pro',
      inputTokens: pro.inputTokens,
      outputTokens: pro.outputTokens,
    })
    try {
      cards = parseAndValidate(pro.text)
    } catch (parseErr) {
      const parseMsg =
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      throw new Error(
        `OCR pipeline failed (Flash: ${flashError}; Pro parse: ${parseMsg})`,
      )
    }
    if (cards.length === 0) {
      throw new Error(
        `OCR pipeline failed (Flash: ${flashError}; Pro: 0 cards extracted)`,
      )
    }
  }

  const costYen = tokenUsage.reduce(
    (sum, u) => sum + estimateCostYen(u.model, u.inputTokens, u.outputTokens),
    0,
  )

  return { cards, modelChain, costYen, flashError, tokenUsage }
}
