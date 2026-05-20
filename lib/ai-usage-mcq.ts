// 月次 OCR ページ消費 tracker + plan-limits enforce utility。
//
// S1.9.1: 集計元を source_documents から upload_records に切り替えた。
// 旧方式 (source_documents.pages_processed の SUM) は discardUpload が
// source_documents を物理削除すると SUM の集計元が消える = 月次 quota が
// 「返金」 され、 「やり直す」 の繰り返しで月次上限を事実上バイパスできた
// (Bug A)。 upload_records は OCR 完了 / 失敗時に append-only で記録され、
// discard では一切 touch されないため、 月次消費は monotonic。
//
// 集計仕様:
// - upload_records.status = 'completed' の行のみ SUM 対象 (failed は台帳には
//   残るが消費に計上しない)。
// - JST 月境界 = 当月 1 日 00:00:00 JST 〜 翌月 1 日 00:00:00 JST 直前。
//   DB 上は created_at (UTC timestamptz) で比較するため、 月境界を UTC に
//   変換した範囲で WHERE する。
// - upload_records は完了時 append のみで processing 状態の行が存在しないため、
//   旧 source_documents 方式にあった「stale processing 除外」 ロジックは不要。

import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { uploadRecords } from '@/lib/db/schema'
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

// 当月 (JST 月境界) の OCR ページ消費合計。
// upload_records のうち status='completed' かつ created_at が当月内の行の
// pages_processed を SUM する。 `now` は test 注入用。
export async function getCurrentMonthOcrPages(
  userId: string,
  now?: Date,
): Promise<number> {
  const db = getDb()
  const { start, end } = jstMonthBoundsUtc(now)
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${uploadRecords.pagesProcessed}), 0)::int`,
    })
    .from(uploadRecords)
    .where(
      and(
        eq(uploadRecords.userId, userId),
        eq(uploadRecords.status, 'completed'),
        gte(uploadRecords.createdAt, start),
        lt(uploadRecords.createdAt, end),
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
