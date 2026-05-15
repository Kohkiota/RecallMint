import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { todayInJst } from '@/lib/jst'
import { limitsFor, type Plan } from '@/lib/auth/plan-limits'
import { logger } from '@/lib/logger'
import { notifyOps } from '@/lib/ops'

export class LimitExceededError extends Error {
  constructor(
    public readonly code: 'GLOBAL_LIMIT' | 'USER_LIMIT',
    message: string,
    // post-INCR count + active limit at throw time. Carried on the error so
    // the outer catch in `reserveAiGenSlot` can build the notifyOps payload
    // without re-querying. Both required to keep payload shape consistent.
    public readonly count: number,
    public readonly limit: number,
  ) {
    super(message)
    this.name = 'LimitExceededError'
  }
}

/**
 * Read and validate GEMINI_DAILY_LIMIT.
 * `Number("")` is 0 and `Number("abc")` is NaN — both silently disable the
 * circuit breaker if left unchecked. Validate on read so any silent
 * misconfiguration fails loudly at the earliest opportunity.
 */
function readGlobalLimit(): number {
  const raw = process.env.GEMINI_DAILY_LIMIT
  // Distinguish unset (undefined → use default) from explicitly-set-invalid
  // (including empty string → throw). `raw ? ... : default` would silently
  // accept "" as "not set" which defeats the intent.
  const limit = raw === undefined ? 1000 : Number(raw)
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(
      `GEMINI_DAILY_LIMIT must be a positive number, got: ${JSON.stringify(raw)}`,
    )
  }
  return limit
}

// Module-load validation: fail fast at import if GEMINI_DAILY_LIMIT is set to
// a non-positive or non-numeric value. Protects against silent misconfiguration
// (e.g., typo in .env.local) where the circuit breaker would otherwise be
// completely disabled (NaN compare is always false) or permanently tripped (0
// compare is always true).
readGlobalLimit()

export async function reserveAiGenSlot(
  userId: string,
  userPlan: Plan,
): Promise<void> {
  const db = getDb()
  const date = todayInJst()
  // Re-read at call time to support runtime overrides (e.g., integration tests
  // pumping the cap up/down per scenario). Still validated — any runtime
  // mutation to an invalid value throws before the transaction opens.
  const globalLimit = readGlobalLimit()
  const userLimit = limitsFor(userPlan).aiGenPerDay

  try {
    await db.transaction(async (tx) => {
      // Global counter: atomic UPSERT + RETURNING count.
      // Race-free because PG serializes the UPSERT row lock even on the "insert"
      // path (empty row) — a concurrent caller sees the first caller's insert
      // committed BEFORE its own conflict branch runs.
      // Post-increment check: if count > limit, throw → transaction rolls back
      // → net zero increment. (Previous SELECT-FOR-UPDATE approach had a gap
      // because FOR UPDATE does not lock nonexistent rows.)
      const globalResult = await tx.execute<{ count: number }>(sql`
        INSERT INTO ai_usage (date, count) VALUES (${date}, 1)
        ON CONFLICT (date) DO UPDATE SET count = ai_usage.count + 1
        RETURNING count
      `)
      const globalCount = Number(globalResult.rows[0]?.count ?? 0)
      if (globalCount > globalLimit) {
        throw new LimitExceededError(
          'GLOBAL_LIMIT',
          '本日の AI 例文生成は一時停止中です',
          globalCount,
          globalLimit,
        )
      }

      // Per-user counter: same UPSERT RETURNING pattern.
      // F-3: ai_usage_users.user_id is uuid; explicit ::uuid cast avoids
      // operator does not exist (uuid = text) on the bound parameter.
      const userResult = await tx.execute<{ count: number }>(sql`
        INSERT INTO ai_usage_users (user_id, date, count)
        VALUES (${userId}::uuid, ${date}, 1)
        ON CONFLICT (user_id, date) DO UPDATE SET count = ai_usage_users.count + 1
        RETURNING count
      `)
      const userCount = Number(userResult.rows[0]?.count ?? 0)
      if (userCount > userLimit) {
        throw new LimitExceededError(
          'USER_LIMIT',
          `本日の AI 例文生成枠を使い切りました（${userLimit}件）`,
          userCount,
          userLimit,
        )
      }
    })
  } catch (err) {
    // N-7: surface daily limit reach as a Discord ops signal. The notifyOps
    // call lives OUTSIDE the transaction so a slow/failing Discord webhook
    // does not extend the DB transaction window (connections release once
    // the cap check throws). Inner try/catch makes the best-effort invariant
    // explicit: notifyOps failure must not mask the original LimitExceededError
    // — lib/ops.ts is best-effort today, but this guards against future
    // changes that might let it throw.
    if (err instanceof LimitExceededError) {
      try {
        await notifyOps('AI daily limit reached', {
          kind: err.code === 'GLOBAL_LIMIT' ? 'daily-global' : 'daily-user',
          userId,
          plan: userPlan,
          date,
          count: err.count,
          limit: err.limit,
          environment:
            process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
          timestamp: new Date().toISOString(),
        })
      } catch (notifyErr) {
        logger.warn({ event: 'ops.notify.failed_in_daily_limit', err: notifyErr })
      }
    }
    throw err
  }
}
