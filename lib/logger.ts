/**
 * Structured JSON logger for Vercel Function Logs.
 *
 * Emits one-line JSON per call to console.{log|warn|error} with auto-attached
 * level / timestamp / environment / event fields plus any extra payload metadata.
 * Designed to be Sentry-swap-ready: replace this entire file with a Sentry SDK
 * adapter while keeping the `logger.{info|warn|error}(payload)` interface, and
 * all callsites work unmodified.
 *
 * Architectural constraints (G-6 spec §3 Assumption 2 / Q6 副次決定):
 * - Does NOT import `@/lib/ops` (avoids notifyOps → logger → notifyOps cycle).
 * - Internal implementation is `console.*` + `JSON.stringify` + `expandError`
 *   self implementation only. No external API calls.
 *
 * Throw guarantee (G-6 spec §3 Assumption 3, §4.3 emit outer try/catch):
 * - `logger.{info|warn|error}` never throws. All internal failures (BigInt
 *   serialize, etc) are swallowed by the outer try/catch and emit a fallback
 *   `console.error('[logger fallback] ...')` line. Double-throw is silent
 *   (process crash avoidance).
 *
 * Output JSON shape:
 *   {"level":"error","timestamp":"2026-05-03T...Z","environment":"production",
 *    "event":"webhook.stripe.bad_signature","err":{"name":"...","message":"...","stack":"..."}}
 *
 * Spec: docs/superpowers/specs/2026-05-03-phase1-g-6-structured-logger.md
 */

type Level = 'info' | 'warn' | 'error'

type Payload = { event: string; [k: string]: unknown }

// Factory pattern: per-call で seen WeakSet を closure で持つ replacer 関数を返す。
// Error → { name, message, stack } 展開 + 循環参照 → '[Circular]' 置換。
function expandError(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}

function emit(level: Level, payload: Payload): void {
  try {
    const enriched = {
      level,
      timestamp: new Date().toISOString(),
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      ...payload,
    }
    const json = JSON.stringify(enriched, expandError())
    if (level === 'error') console.error(json)
    else if (level === 'warn') console.warn(json)
    else console.log(json)
  } catch (err) {
    // 最終 fallback: logger 契約「throw しない」を保証 (Section 4 保証 1)。
    try {
      console.error(
        `[logger fallback] failed to format payload: ${String(err)}; event=${String(payload?.event)}`,
      )
    } catch {
      // 二重 throw は silent (process crash 回避、これ以上できることがない layer)。
    }
  }
}

export const logger = {
  /** Info-level structured log. Routes to console.log. Example: `logger.info({ event: 'startup' })` */
  info: (payload: Payload) => emit('info', payload),
  /** Warn-level structured log. Routes to console.warn. Example: `logger.warn({ event: 'ops.notify.fetch_failed', err })` */
  warn: (payload: Payload) => emit('warn', payload),
  /** Error-level structured log. Routes to console.error. Example: `logger.error({ event: 'webhook.stripe.bad_signature', err })` */
  error: (payload: Payload) => emit('error', payload),
}
