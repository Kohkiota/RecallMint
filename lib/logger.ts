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
 */

import { isProduction, runtimeEnv } from '@/lib/env/runtime-env'

type Level = 'info' | 'warn' | 'error'

type Payload = { event: string; [k: string]: unknown }

// T-C3 H6: emit() 内 level filter の priority 表。 数値が大きいほど深刻。
// `LEVEL_PRIORITY[callLevel] < LEVEL_PRIORITY[threshold]` で skip 判定。
const LEVEL_PRIORITY: Record<Level, number> = { info: 0, warn: 1, error: 2 }

// T-C3 H6: env tier ベースの level 既定 + LOG_LEVEL env による override 解釈。
// - LOG_LEVEL が 'info' / 'warn' / 'error' なら env tier に関係なくその値
// - 未指定 / 空 / 不正値 = default tier (production = 'warn' / 非 production = 'info')
// throw guarantee (G-6 spec §3 Assumption 3) 維持: env 読みのみで throw しない。
function resolveLogLevel(): Level {
  const env = process.env.LOG_LEVEL
  if (env === 'info' || env === 'warn' || env === 'error') return env
  return isProduction() ? 'warn' : 'info'
}

// Factory pattern: per-call で seen WeakSet を closure で持つ replacer 関数を返す。
// Error → { name, message, stack } 展開 + 循環参照 → '[Circular]' 置換。
// P4 T5: export 化により ops.ts の byte-exact 重複 makeReplacer を削除。
export function expandError(): (key: string, value: unknown) => unknown {
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
    // T-C3 H6 level filter: LOG_LEVEL 以上のみ通す。 production 既定 = 'warn' で
    // flush.kick 等の常時 info を抑止。 try ブロック内に置くことで env access が
    // 何らかの runtime で throw しても fallback path (catch) で防御される。
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[resolveLogLevel()]) return
    const enriched = {
      level,
      timestamp: new Date().toISOString(),
      environment: runtimeEnv(),
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
  /**
   * catch(err) で受け取った Error をそのまま warn する shortcut。 `err` を Error の
   * まま `expandError` に渡し name/message/stack を構造化保持する
   * (旧 `err: String(err)` で stack を捨てていた inline boilerplate の置換、
   * Sync-fix-1 audit §10.2 (a) #11)。
   */
  warnFromError: (event: string, ctx: Record<string, unknown>, err: unknown) =>
    emit('warn', { event, ...ctx, err }),
}
