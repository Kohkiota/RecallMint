// Gemini API call counter (per-user 日次 + グローバル日次)。
//
// CLAUDE.md §AI API 絶対ルール 3 の GEMINI_DAILY_LIMIT guard を支える基盤。
// `ai_usage` (グローバル) と `ai_usage_users` (ユーザー別) を JST 日付で UPSERT。
//
// 設計:
// - 1 つの transaction で両 table を UPSERT (片方だけ成功する状態を作らない)。
// - 既存 row があれば `count = count + N` で加算 (onConflictDoUpdate)。
// - JST 日境界は `lib/jst.ts` の `todayInJst` を利用 (date PK は JST 'YYYY-MM-DD')。
// - 重要 Fix 該当 (外部副作用 = Gemini call との同期 counter): 1 call 1 count を厳守。
//
// 集計対象 = Gemini API call 試行回数 (成功・失敗・retry すべて 1 回ずつ計上)。
// OCR pipeline 内の `callWithRetry` から `onAttempt` callback 経由で呼ばれる。

import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { aiUsage, aiUsageUsers } from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'

export async function incrementAiUsage(
  userId: string,
  count = 1,
  now?: Date,
): Promise<void> {
  const db = getDb()
  const today = todayInJst(now)

  await db.transaction(async (tx) => {
    await tx
      .insert(aiUsage)
      .values({ date: today, count })
      .onConflictDoUpdate({
        target: aiUsage.date,
        set: { count: sql`${aiUsage.count} + ${count}` },
      })

    await tx
      .insert(aiUsageUsers)
      .values({ userId, date: today, count })
      .onConflictDoUpdate({
        target: [aiUsageUsers.userId, aiUsageUsers.date],
        set: { count: sql`${aiUsageUsers.count} + ${count}` },
      })
  })
}

// 当日 (JST) のグローバル AI 呼び出し合計。 GEMINI_DAILY_LIMIT guard で利用。
// row が無ければ 0 を返す。
export async function getTodayAiUsageGlobal(now?: Date): Promise<number> {
  const db = getDb()
  const today = todayInJst(now)
  const rows = await db
    .select({ count: aiUsage.count })
    .from(aiUsage)
    .where(eq(aiUsage.date, today))
    .limit(1)
  return rows[0]?.count ?? 0
}
