// card-count — exams.card_count 派生キャッシュの ±N 更新を 1 箇所に集約するヘルパ。
//
// 3 呼び出し元 (card create +1 / card delete -1 / OCR bulk +N) が同一の UPDATE 形を
// 書いていたのを本ヘルパに寄せる。 count 演算は各 site の従来挙動と同値
// (delta>0 = 素加算 / delta<0 = GREATEST 負ガード)。 render 上 literal→param に
// 正規化されるが bind 値は同じ (spec §3.5)。
//
// card_count は派生キャッシュ。 更新で exams.updatedAt ($onUpdate) を動かさず
// (updatedAt 自己参照)、 試験一覧の updatedAt DESC 順を card 増減で乱さない
// (B1 は perf 最適化であり list 並び順を変える feature ではない)。
//
// delta contract: 呼び出し元は非ゼロのみを渡す (0 分岐は持たない — YAGNI, spec §3.5)。

import { and, eq, sql } from 'drizzle-orm'
import { exams } from '@/lib/db/schema'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'

/**
 * owner-scoped で exams.card_count を delta 分ずらす。
 *   delta > 0 → card_count + delta (素加算)
 *   delta < 0 → GREATEST(card_count + delta, 0) (負ガード、delta は既に負なので実質減算)
 * updatedAt は自己参照で据え置き、WHERE は id + userId owner-scope。
 */
export async function bumpExamCardCount(
  tx: DbExecutor,
  args: { examId: string; userId: string; delta: number },
): Promise<void> {
  const { examId, userId, delta } = args
  const cardCount =
    delta < 0
      ? sql`GREATEST(${exams.cardCount} + ${delta}, 0)`
      : sql`${exams.cardCount} + ${delta}`
  await tx
    .update(exams)
    .set({
      cardCount,
      updatedAt: sql`${exams.updatedAt}`,
    })
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
}
