// Contact form Server Action 用 rate limit helper (audit §10.3 (b) #15、 T-A7)。
//
// 暫定 storage = in-memory LRU (per warm Vercel serverless instance)。
// Vercel serverless では単一 instance 仮定は成立せず、 multi-instance に load
// balance された場合 instance ごとに別 counter となる。 そのため
// **per-warm-instance の best-effort 抑止** と性格付ける (single source of
// truth な rate limit ではない)。 abuse の主目的 — 同一 IP / signed-in user の
// 連続 spam を 5 req/h 程度で減速させる — は per-instance counter でも
// 達成できる (cold start で counter reset するため攻撃者の最大利得は
// limited)。
//
// TODO (将来差替先): multi-instance 一貫 rate limit が必要になったら以下に置換。
//   - Vercel KV (Redis 互換、 atomic INCR / EXPIRE)
//   - upstash/ratelimit (sliding window 実装内蔵、 edge 互換)
// 差替時は本 helper の export 形を維持 (caller 側変更なし) のため signature
// を `Promise<{ allowed; resetAtMs }>` に拡張する余地を残しておく。
//
// limit = 5 req/h (OT 承認済、 2026-06-12)。
// key = `ip:<addr>` (anonymous) / `userId:<uuid>` (signed-in)、 caller が組立。

const WINDOW_MS = 60 * 60 * 1000 // 1h
const LIMIT = 5
const MAX_KEYS = 1000 // memory leak 防止 (LRU oldest eviction)

// Map は ES2015 仕様で挿入順を保持するため、 先頭 = oldest として oldest
// eviction を実装する。 各 entry の value は最近 LIMIT 件以内の epoch ms。
const store = new Map<string, number[]>()

export interface ContactRateLimitResult {
  allowed: boolean
  /**
   * blocked 時に枠が再び空くまでの epoch ms (= 最古 timestamp + WINDOW_MS)。
   * allowed 時は now + WINDOW_MS (next-window projection、 caller が必要なら
   * Retry-After 等の header 算出に使える) を返す。
   */
  resetAtMs: number
}

export function checkContactRateLimit(
  key: string,
  now: number = Date.now(),
): ContactRateLimitResult {
  const windowStart = now - WINDOW_MS

  // 1) prune old entries (1h 経過 timestamp を filter out)。
  const previous = store.get(key) ?? []
  const recent = previous.filter((ts) => ts > windowStart)

  // 2) limit check。
  if (recent.length >= LIMIT) {
    // map の挿入順 = LRU 的 recency を保つため、 同 key を一旦 delete → set し直す
    // ことで本 access を「最新」 として oldest eviction から守る (block でも
    // 当該 key への access が継続している事実は残す)。
    store.delete(key)
    store.set(key, recent)
    return {
      allowed: false,
      resetAtMs: recent[0] + WINDOW_MS,
    }
  }

  // 3) allow: 現在の timestamp を push。
  recent.push(now)
  store.delete(key)
  store.set(key, recent)

  // 4) LRU eviction (Map size > MAX_KEYS → oldest delete)。
  while (store.size > MAX_KEYS) {
    const oldestKey = store.keys().next().value
    if (oldestKey === undefined) break
    store.delete(oldestKey)
  }

  return {
    allowed: true,
    resetAtMs: now + WINDOW_MS,
  }
}

/**
 * test 専用: in-memory store を全 clear。 production code から呼ばない
 * (`__` prefix で internal API を明示)。
 */
export function __resetContactRateLimitStore(): void {
  store.clear()
}
