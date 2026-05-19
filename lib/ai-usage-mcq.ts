// 月次 OCR ページ消費 tracker + plan-limits enforce utility (S1a / S5 統合)。
//
// source_documents.pages_processed (integer) を JST 月境界で SUM し、 plan-limits
// (`lib/auth/plan-limits.ts`) の `ocrPagesPerMonth` と比較する。 Server Action
// から呼ばれて、 上限超過時の OCR 起動を弾く。
//
// 状態前提:
// - source_documents.status IN ('completed', 'processing') を集計対象とする。
//   ('failed' は失敗 path で消費 0 扱い、 'uploading' は途中段階で集計対象外)
// - JST 月境界 = 当月 1 日 00:00:00 JST 〜 翌月 1 日 00:00:00 JST 直前
//   DB 上は created_at (UTC timestamptz) で比較するため、 月境界を UTC に変換した
//   範囲で WHERE する。

import { and, eq, gte, lt, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { sourceDocuments } from '@/lib/db/schema'
import { limitsFor, type Plan } from '@/lib/auth/plan-limits'

// JST 当月の境界 (UTC で表現) を返す。 now を渡すと test で任意時刻を注入可能。
// 月境界判定の単位は JST 1 日 (UTC+9) で、 例えば「2026-05 月」 は
// 2026-04-30T15:00:00Z (= 2026-05-01T00:00 JST) から
// 2026-05-31T15:00:00Z (= 2026-06-01T00:00 JST) まで。
export function jstMonthBoundsUtc(now?: Date): { start: Date; end: Date } {
  const base = now ?? new Date()
  // JST に shift して YYYY-MM を取得
  const jst = new Date(base.getTime() + 9 * 3600 * 1000)
  const jstYear = jst.getUTCFullYear()
  const jstMonth = jst.getUTCMonth() // 0-11
  // JST 当月 1 日 00:00 を UTC に戻す: JST 00:00 = UTC 前日 15:00
  // Date.UTC(year, month, day, hour) で UTC を直接構築 → 9 時間 引く
  const start = new Date(Date.UTC(jstYear, jstMonth, 1, -9, 0, 0))
  const end = new Date(Date.UTC(jstYear, jstMonth + 1, 1, -9, 0, 0))
  return { start, end }
}

// 当月 (JST 月境界) の OCR ページ消費合計。 status IN ('completed', 'processing')
// のみカウント。 NULL や 'failed' / 'uploading' は除外。
export async function getCurrentMonthOcrPages(
  userId: string,
  now?: Date,
): Promise<number> {
  const db = getDb()
  const { start, end } = jstMonthBoundsUtc(now)
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${sourceDocuments.pagesProcessed}), 0)::int` })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.userId, userId),
        inArray(sourceDocuments.status, ['completed', 'processing'] as const),
        gte(sourceDocuments.createdAt, start),
        lt(sourceDocuments.createdAt, end),
      ),
    )
  return Number(rows[0]?.total ?? 0)
}

export type OcrLimitDecision =
  | { ok: true; remaining: number | null /* null = 公平利用 (Pro) */ }
  | { ok: false; reason: 'exceeded'; current: number; limit: number; requested: number }

// requestedPages を加えると月次上限を超えるか。 Pro (limit=null) は常に ok。
// limit-requested の境界判定: 「current + requested > limit」 で exceeded、 等号は ok
// (= ちょうど上限まで使い切れる)。
export async function canRunOcr(
  userId: string,
  plan: Plan,
  requestedPages: number,
  now?: Date,
): Promise<OcrLimitDecision> {
  const limit = limitsFor(plan).ocrPagesPerMonth
  if (limit === null) {
    // 公平利用 = Pro。 ソフト上限なし、 監視は外側 (ai_usage 全体 + Discord notify)。
    return { ok: true, remaining: null }
  }
  const current = await getCurrentMonthOcrPages(userId, now)
  if (current + requestedPages > limit) {
    return {
      ok: false,
      reason: 'exceeded',
      current,
      limit,
      requested: requestedPages,
    }
  }
  return { ok: true, remaining: limit - current - requestedPages }
}
