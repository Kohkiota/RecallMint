// OCR pipeline (Flash → HTTP retry → JSON parse → zod validate)。
//
// 本 file は外部 SDK を直接触らず、 lib/ai/clients/gemini.ts の `callGemini` 経由で
// API 呼び出しする。 test では `vi.mock('@/lib/ai/clients/gemini', ...)` で完全に
// 差し替える前提。
//
// 設計:
// - Flash のみ使用。 transient HTTP error は exponential backoff で最大 2 回 retry する。
// - JSON parse 失敗 / cards=0 / HTTP retry 尽き → 即 throw (Pro へ移らない)。
//   caller (Server Action) 側で source_documents.status='failed' + notifyOps Discord
//   + UI に「混み合っています」表示する。
// - cost は Flash token usage のみ計上。
// - 429 (rate limit) は callWithRetry 内で即 throw (retry も Pro fallback もしない)。

import { z } from 'zod'
import { buildDiscoverPrompt } from './prompts/ocr-extract'
import {
  buildDiscoverResponseJsonSchema,
  type ExtractedCard,
} from './schemas/ocr-response'
import { callGemini, parseRetryAfterMs, type GeminiInputFile } from './clients/gemini'
import { estimateCostYen, type ModelKind } from './cost'
import {
  isRateLimitError,
  isTransientError,
  computeBackoffMs,
} from '@/lib/retry/transient-error'

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

// Vercel Pro function maxDuration は 800s。 pipeline 全体を 720s で自前停止し、
// 残り ~80s を caller 後処理 (cards INSERT + markFailed + notifyOps 等) のバッファとして確保する。
// ※ 800 - 720 = 80s が後処理余裕; Vercel ハード上限 900s より手前で自前停止する設計。
// ②-4a 単一 invocation(2026-08-04): route の maxDuration が 720s になり、この内部
// deadline は同値 = 名目化した(platform kill が先に来るため後処理余裕は残らない)。
// 読み手は headroom の存在を前提にしないこと。S-2 の統合予算(単一 deadlineAt)で置換予定。
// 名目化が実害にならない理由(Codex P1 裁定・2026-08-04): この定数を使うのは
// runOcrPipeline ただ 1 つで、その唯一の呼出元 process.ts は cutover で UI 呼出を
// 撤去済み = 現在到達不能。稼働中の stage-prepared 経路は callImageCropWithRetry を
// 使い overall deadline を元々持たない(= 失われた graceful cleanup は無い)。
export const OCR_OVERALL_DEADLINE_MS = 720_000

// 全体 deadline 超過を通常の pipeline error と instanceof で識別するための専用 class。
// process.ts が catch して timeout 処理経路に分岐するために使う。
export class OcrDeadlineError extends Error {
  constructor(message = `OCR pipeline exceeded overall deadline (${OCR_OVERALL_DEADLINE_MS}ms)`) {
    super(message)
    this.name = 'OcrDeadlineError'
    // V8 以外 (e.g. SpiderMonkey) でも prototype chain を正しく繋ぐため明示設定。
    Object.setPrototypeOf(this, OcrDeadlineError.prototype)
  }
}

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
    thoughtsTokens: number
  }>
}

const MAX_HTTP_RETRIES = 2 // 初回 + 2 retries = 計 3 attempts per model

// 429 / transient 判定は lib/retry/transient-error.ts に抽出 (review-events flush と
// 共有)。 429 ≠ 503 (ルール 5) の分類はそちらの単体 test で担保。

// backoff の静的待機時間。 attempt 0 (1 回目 retry 前) = 5s + jitter(0-2s)、
// attempt 1 (2 回目 retry 前) = 20s + jitter(0-5s)。
// Gemini の一時的 5xx / ネットワーク断は数秒〜十数秒で回復することが多く、
// 旧 500ms/1000ms では再 429 を誘発するため十分な待機時間に延長。
const BACKOFF_BASE_MS = [5_000, 20_000] as const
const BACKOFF_JITTER_MAX_MS = [2_000, 5_000] as const

// サーバー指示の Retry-After は任意の値 (例: 86400s) を返しうるため、
// 上限なしで使うと per-attempt の 220s budget / pipeline 全体の 720s deadline を
// 簡単に吹き飛ばす。 60s に clamp してサーバーコントロールな値を安全範囲に収める。
const RETRY_AFTER_CAP_MS = 60_000

async function callWithRetry(
  model: ModelKind,
  files: GeminiInputFile[],
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  onAttempt?: (model: ModelKind) => Promise<void> | void,
  // rng は jitter 生成に使う乱数関数。 デフォルトは Math.random。
  // test では固定値を渡して待機時間を決定論的に検証する。
  rng: () => number = Math.random,
): Promise<{ text: string; inputTokens: number; outputTokens: number; thoughtsTokens: number }> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
    // onAttempt は callGemini 直前で発火。 成功・失敗・retry すべて 1 回ずつ計上
    // するため retry 内側にも置く (Flash 初回 + retry × 2 = 最大 3 回計上)。
    // callback 失敗 (例: DB エラー) で本処理を巻き込まないよう try/catch で
    // 握りつぶし、 logger 委譲は caller 側に任せる。
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
      // Retry-After header があればサーバー指示を優先。 なければ static + jitter。
      // SDK が現状 headers を露出しないため通常は null だが、 将来対応に備えて配線。
      const retryAfterMs = parseRetryAfterMs(err)
      const backoffMs =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
          : computeBackoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_JITTER_MAX_MS, rng)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw lastErr
}

export function parseOcrResponse(text: string): ExtractedCard[] {
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

// pipeline 本体。 runOcrPipeline の deadline wrapper から呼ばれる。
// Flash retry / backoff / parse / validate を含む全処理。
async function runPipelineInner(
  files: GeminiInputFile[],
  opts?: {
    onAttempt?: (model: ModelKind) => Promise<void> | void
    rng?: () => number
  },
): Promise<OcrPipelineResult> {
  const prompt = buildDiscoverPrompt()
  const schema = buildDiscoverResponseJsonSchema()

  const modelChain: ModelKind[] = ['flash']
  const tokenUsage: OcrPipelineResult['tokenUsage'] = []
  let cards: ExtractedCard[] = []
  let flashError: string | undefined

  // Flash with retry。 失敗 (HTTP error / JSON parse fail / 0 cards / 429) は即 throw。
  try {
    const flash = await callWithRetry(
      'flash',
      files,
      prompt,
      schema,
      opts?.onAttempt,
      opts?.rng,
    )
    tokenUsage.push({
      model: 'flash',
      inputTokens: flash.inputTokens,
      outputTokens: flash.outputTokens,
      thoughtsTokens: flash.thoughtsTokens,
    })
    cards = parseOcrResponse(flash.text)
    if (cards.length === 0) throw new Error('Flash returned 0 cards')
  } catch (e) {
    flashError = e instanceof Error ? e.message : String(e)

    // callWithRetry が re-throw した 429 のときのみここに到達する (rate limit 専用経路)。
    // 0 cards / parse fail / HTTP retry 尽きは isRateLimitError=false のため下の
    // 汎用 throw に落ちる。 いずれの失敗経路も Pro へは移らず即 throw する。
    if (isRateLimitError(e)) {
      throw new Error(
        `OCR pipeline failed (Flash rate limited): ${flashError}`,
      )
    }
    throw new Error(`OCR pipeline failed (Flash: ${flashError})`)
  }

  const costYen = tokenUsage.reduce(
    (sum, u) =>
      sum + estimateCostYen(u.model, u.inputTokens, u.outputTokens, u.thoughtsTokens),
    0,
  )

  return { cards, modelChain, costYen, flashError, tokenUsage }
}

export async function runOcrPipeline(
  files: GeminiInputFile[],
  opts?: {
    // 各 Gemini call (Flash 初回 + retry すべて) の直前に呼ばれる。
    // caller (Server Action) はここで ai_usage / ai_usage_users counter を加算する。
    // callback 失敗は内部で握りつぶす (ベストエフォート計上)。
    onAttempt?: (model: ModelKind) => Promise<void> | void
    // backoff jitter 用乱数関数。 通常は省略 (Math.random)。
    // test から固定値を渡すことで待機時間を決定論的に検証できる。
    rng?: () => number
  },
): Promise<OcrPipelineResult> {
  // Promise.race で pipeline と deadline timer を競わせ、先に決着した方の結果を返す。
  // deadline 到達時は OcrDeadlineError を reject し、 caller が timeout 経路に分岐できる。
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new OcrDeadlineError())
    }, OCR_OVERALL_DEADLINE_MS)
  })

  try {
    return await Promise.race([runPipelineInner(files, opts), deadlinePromise])
  } finally {
    // 正常完了・pipeline throw・deadline いずれの経路でも必ず timer を解放する。
    // 注: deadline race は外側 Promise を resolve/reject してタイマーを解放するだけであり、
    // in-flight の Gemini fetch そのものはキャンセルしない。 実際の中断は per-attempt の
    // 220s AbortController か Vercel function timeout に委ねられる。
    clearTimeout(deadlineTimer)
  }
}
