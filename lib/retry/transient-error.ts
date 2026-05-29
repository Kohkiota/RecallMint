// transient error 分類 + 指数 backoff 計算の共有 util。
//
// OCR pipeline (lib/ai/ocr.ts) と review-events flush (lib/sync/review-flush.ts) の
// 両方が参照する。 元実装は ocr.ts に private 関数として存在したものを抽出した
// (挙動は不変)。 SDK error の status code / status 文字列は message に含まれる前提で
// string match する (SDK では code が instance property に出ないことが多く pragmatic)。
//
// CLAUDE.md AI 絶対ルール 5「429 受信時は即時停止、 リトライ禁止」 に厳密に従い、
// 429 (rate limit) は isTransientError から除外して isRateLimitError が専任で判定する
// (= 429 ≠ 503)。 HTTP status 数値を渡す呼出側 (review-flush) は String 化されて
// 同じ regex で判定される。

// 429 (rate limit / quota 超過) 判定。 retry も fallback もせず即停止する対象。
// 429 数字 / "rate limit" / RESOURCE_EXHAUSTED いずれかで判定。
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /\b429\b/.test(msg) ||
    /rate ?limit/i.test(msg) ||
    /resource_exhausted/i.test(msg)
  )
}

// transient (= backoff retry 対象) な error 判定。
// 429 は含めない — ルール 5 により即時停止扱い (isRateLimitError が担当)。
// 5xx (500/502/503/504) / timeout / unavailable に加え、 network layer の
// 一時的断絶 (ECONNRESET / ECONNREFUSED / ENOTFOUND / EAI_AGAIN /
// "fetch failed" / "socket hang up") も retry 対象とする。
// これらは DNS 障害・接続断など外部要因で自然回復が期待できるため。
// 注: 汎用 /\bnetwork\b/ は "403 Forbidden: API key network policy violation"
// 等の非 transient 4xx を誤って retry 対象にするため除外。
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /\b(500|502|503|504)\b/.test(msg) ||
    /timeout/i.test(msg) ||
    /unavailable/i.test(msg) ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /socket hang up/i.test(msg)
  )
}

// 指数 backoff の待機時間 (ms) を計算する。 base[attempt] に jitter[attempt] × rng() を
// 加算する。 rng は test で固定値を渡して決定論的に検証できる (default Math.random)。
// attempt は 0 始まり (1 回目 retry 前 = attempt 0)。
export function computeBackoffMs(
  attempt: number,
  baseMs: readonly number[],
  jitterMaxMs: readonly number[],
  rng: () => number = Math.random,
): number {
  return baseMs[attempt] + rng() * jitterMaxMs[attempt]
}
