// ②-4a Task 8b: source_id-interleaved Gemini call + retry/backoff。
// 唯一の呼出元は OCR phase(`./upload-pipeline.ts`)。
//
// directive 無しの独立 module(テスト容易性のため — 既存 constants.ts /
// daily-limit.ts / asset-limits.ts / source-image-verify.ts と同じパターン)。
//
// 設計: 本番 OCR pipeline (`lib/ai/ocr.ts` の private `callWithRetry`)を書き換え
// ずに retry/backoff の規律だけを踏襲する薄い呼び出しループ(task brief: 「reuse
// the retry/backoff discipline ... either extract/reuse its helpers or a thin
// ②-4a call loop」→ 後者を選択。 ocr.ts は export しておらず、production file を
// 触らずに済む)。 429 (rate limit) 判定 / transient 判定 / backoff 計算は
// `lib/retry/transient-error.ts`(ocr.ts と共有済の既存 util)をそのまま再利用する
// — 分類ロジックは重複させない。 数値定数(retry 回数・backoff 秒数)のみ ocr.ts
// と同値で独立定義する(ocr.ts が export していないため。 同じ Gemini backend を
// 叩く以上、 運用挙動を揃える目的で値は意図的に一致させている — drift したら
// 両方読み比べる)。
//
// CLAUDE.md AI 絶対ルール 2: 429 受信で即停止・リトライ禁止(isRateLimitError は
// retry ループに一切乗せず即 throw)。
import {
  callGemini,
  parseRetryAfterMs,
  GEMINI_TIMEOUT_MS,
  type GeminiContentPart,
  type GeminiCallResult,
} from '@/lib/ai/clients/gemini'
import {
  isRateLimitError,
  isTransientError,
  computeBackoffMs,
} from '@/lib/retry/transient-error'

// ocr.ts の callWithRetry と同値(初回 + 2 retries = 計 3 attempts)。
const MAX_HTTP_RETRIES = 2
const BACKOFF_BASE_MS = [5_000, 20_000] as const
const BACKOFF_JITTER_MAX_MS = [2_000, 5_000] as const
const RETRY_AFTER_CAP_MS = 60_000

/**
 * ②-4a 探索 Gemini call(source_id-interleaved parts・figure crop 探索
 * schema)を、 本番 pipeline と同じ retry/backoff 規律(Flash 固定・transient は
 * 指数 backoff で最大 2 回 retry・429 は即 throw)で実行する。
 *
 * `onAttempt` は各 call 直前(初回 + retry すべて)に発火する — caller
 * がここで `incrementAiUsage` を呼ぶ(spec §3 の日次 cap
 * 配線)。 callback 失敗は本処理を止めない(ベストエフォート計上、 ocr.ts の
 * callWithRetry と同じ try/catch 握り潰し)。
 *
 * `deadlineAt`(②-4a 単一 invocation S-2)は retry ループが呼出側の time budget を
 * 食い破らないための打ち切り基準。 **必須**: 旧経路(別 invocation で OCR し、
 * 全体 deadline を持たなかった)は S-5 で撤去済で、未指定にしてよい呼出元はもう
 * 存在しない。 optional のまま残すと、将来の呼出元が黙って打ち切りガードを
 * 外せてしまう(= invocation が platform に打ち切られ失敗理由がどこにも残らない)。
 *
 * `rng` は jitter 生成用(test から固定値を渡して決定論的に検証する。 デフォルト
 * は Math.random、 ocr.ts と同じ注入点)。
 */
export async function callImageCropWithRetry(
  parts: GeminiContentPart[],
  responseJsonSchema: Record<string, unknown>,
  deadlineAt: Date,
  onAttempt?: () => Promise<void> | void,
  rng: () => number = Math.random,
): Promise<GeminiCallResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
    if (onAttempt) {
      try {
        await onAttempt()
      } catch {
        // counter 書き込み失敗は本処理を止めない(ベストエフォート計上)。
      }
    }
    try {
      // files/prompt は GeminiCallInput の型上必須だが、 parts 指定時は未使用
      // (lib/ai/clients/gemini.ts の callGemini 実装コメント参照)。
      return await callGemini({
        model: 'flash',
        files: [],
        prompt: '',
        responseJsonSchema,
        parts,
      })
    } catch (err) {
      lastErr = err
      // ルール 2: 429 は即時停止。 retry しない。
      if (isRateLimitError(err)) throw err
      if (!isTransientError(err) || attempt === MAX_HTTP_RETRIES) throw err
      const retryAfterMs = parseRetryAfterMs(err)
      const backoffMs =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
          : computeBackoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_JITTER_MAX_MS, rng)
      // **retry を始める前**に残余を見る(呼出側の pre-call gate 1 回だけでは効かない
      // — backoff + 追加 attempt の合計は最大 3×GEMINI_TIMEOUT_MS + 2×RETRY_AFTER_CAP_MS
      // = 780s で、720s の maxDuration すら超えうる)。 次の attempt は最悪
      // GEMINI_TIMEOUT_MS 掛かるため、backoff 込みでそれを賄えない残余なら retry せず
      // 打ち切る(入ってしまうと invocation が platform に打ち切られ、失敗理由が
      // どこにも残らない)。 backoff の前に判定するのは、どうせ打ち切る待ち時間を
      // 予算から使わないため。 初回 attempt の可否判断は呼出側の責務。
      if (deadlineAt.getTime() - Date.now() - backoffMs < GEMINI_TIMEOUT_MS) {
        // 打ち切りは直前の失敗をそのまま伝播する(呼出側の error 分類を変えない)。
        throw err
      }
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw lastErr
}
