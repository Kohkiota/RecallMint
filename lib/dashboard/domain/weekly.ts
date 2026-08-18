// weekly — 定義 doc §4-Q(週起点 = 月曜 00:00 JST・先週同期間比 delta)と §4-P が使う
// 30 暦日窓の境界計算。日界は既存 `lib/jst.ts`、日付シフトは既存
// `lib/streak-core.ts:addDays` を使う(§3.1 — 新規定義しない)。
//
// PURE 制約(lib/*/domain 前例に倣う): I/O なし・DB / Dexie を import しない。
// `now` は必ず引数で受け取る。

import { jstDayRange, todayInJst } from '@/lib/jst'
import { addDays } from '@/lib/streak-core'

/** `study_days` 1 行の集計に必要な最小フィールド。 */
export interface StudyDayRow {
  /** JST 'YYYY-MM-DD'(`study_days.day` と同じ表現)。 */
  day: string
  review_count: number
}

/**
 * `now` を含む JST 週の月曜(YYYY-MM-DD)。週起点 = 月曜 00:00 JST(定義 doc §4-Q)。
 * 曜日判定は day 文字列を UTC 正午でなく UTC 深夜としてパースする既存慣例
 * (`lib/streak-core.ts:addDays` と同じ手法)に揃え、JST 実 offset には依存しない
 * (`todayInJst` が既に正しい JST 暦日を出した後の純粋な文字列演算)。
 */
export function mondayOfWeek(now: Date): string {
  const today = todayInJst(now)
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7 // Mon=0, Tue=1, ..., Sun=6
  return addDays(today, -daysSinceMonday)
}

function daysBetween(startDay: string, endDay: string): number {
  const ms =
    new Date(`${endDay}T00:00:00Z`).getTime() -
    new Date(`${startDay}T00:00:00Z`).getTime()
  return Math.round(ms / 86_400_000)
}

function sumReviewCount(
  rows: readonly StudyDayRow[],
  startDay: string,
  endDay: string,
): number {
  let sum = 0
  for (const r of rows) {
    if (r.day >= startDay && r.day <= endDay) sum += r.review_count
  }
  return sum
}

/**
 * 先週同期間比 delta(定義 doc §4-Q)。
 * `delta = sum(review_count, 今週の月曜〜昨日) − sum(review_count, 先週の月曜〜先週の同曜日の前日)`。
 *
 * - 月曜は delta を出さない(「今週の月曜〜昨日」が空集合)→ `null`
 * - 先週同期間に行が 1 件も無い場合も出さない(「解かなかった 0」と「利用前」を
 *   区別できないため)→ `null`
 * - それ以外は差分(問数)を返す。0 は「±0」であって非表示の理由にはしない
 *   (呼び出し元の表示規約 §3.10 の責務 — ここは `null` かどうかだけを判定する)。
 */
export function weeklyDelta(
  rows: readonly StudyDayRow[],
  now: Date,
): number | null {
  const today = todayInJst(now)
  const monday = mondayOfWeek(now)
  // 月曜: 今週の月曜〜昨日が空集合 → null。
  //
  // fix round 1/5 M-3(controller 裁定・記録として残す): この early return は現在の
  // 実装では**観測不能**(削除しても既存 test は落ちない)。理由 — 月曜は必ず
  // `monday > yesterday`(文字列比較)なので `sumReviewCount(rows, monday, yesterday)`
  // の範囲が構造的に空(currentSum は常に 0)になり、かつ同じ理由で `completedDays`
  // が 0 になって `lastWeekEnd < lastWeekMonday` となり `priorRows` も構造的に空に
  // なる — 結果として直下の「先週同期間 0 件」guard が代わりに null を返す。この
  // redundancy は任意の `rows` 入力に対して恒真(fixture 依存ではなく、
  // daysBetween/addDays の現行実装から数学的に導ける)。
  //
  // **それでも明示的に残す**: ①定義 doc §4-Q が「月曜は delta を出さない」を独立の
  // named 要件として明記しており、コードが偶発的な数値の巡り合わせでなく意図を
  // 直接表現すべき。②将来 `daysBetween` / `addDays` の実装が変わった場合にこの
  // 偶発的 redundancy が崩れる可能性があり、明示 guard がその際の safety net になる。
  // **削除しても test が落ちないことを見て「使われていない dead code」と早合点して
  // 消さないこと** — 上記の理由で意図的に残している。
  if (today === monday) return null

  const yesterday = addDays(today, -1)
  const currentSum = sumReviewCount(rows, monday, yesterday)

  const completedDays = daysBetween(monday, yesterday) + 1 // 月曜〜昨日の日数(inclusive)
  const lastWeekMonday = addDays(monday, -7)
  const lastWeekEnd = addDays(lastWeekMonday, completedDays - 1)

  const priorRows = rows.filter(
    (r) => r.day >= lastWeekMonday && r.day <= lastWeekEnd,
  )
  if (priorRows.length === 0) return null // 先週同期間に行が 1 件もない

  const priorSum = priorRows.reduce((sum, r) => sum + r.review_count, 0)
  return currentSum - priorSum
}

/**
 * 苦手タグ(P)の「直近 30 日」窓の開始 instant(定義 doc §4-P)。今日を含む直近 30
 * 暦日 — ローリング 720 時間ではない。式は定義 doc 本文のとおり:
 * `jstDayRange(addDays(todayInJst(now), -29)).startAt`。
 */
export function thirtyDayWindowStart(now: Date): Date {
  return jstDayRange(addDays(todayInJst(now), -29)).startAt
}
