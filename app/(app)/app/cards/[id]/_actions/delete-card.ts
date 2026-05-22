'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, exams } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// card 単体の物理削除 server action。 deleteExam pattern 踏襲。
// 削除前に redirect 先 (元の exam 詳細) 用の examId を owner-scoped で取得する。
// reviews は cards.id ON DELETE CASCADE で連動削除されるため、 アプリ側で
// 個別 DELETE しない。
export async function deleteCard(
  cardId: string,
): Promise<ActionResult<{ examId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()

  // B1 (S2.0c): owner-scoped SELECT → DELETE → exams.card_count -1 を同一
  // transaction で実行する。 0 行 (不在 / 他 user) なら何もせず null を返す。
  const examId = await db.transaction(async (tx) => {
    // owner-scoped で examId を引く。 0 行 = 不在 / 他 user → 削除せず終了。
    const found = await tx
      .select({ examId: cards.examId })
      .from(cards)
      .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))
      .limit(1)
    const row = found[0]
    if (!row) return null

    // owner-scoped 単一文 DELETE。 WHERE に user_id を含め他 user の card を構造的に保護。
    await tx
      .delete(cards)
      .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))

    // 削除した 1 件ぶん card_count を減算。 GREATEST で負値を防ぐ (件数が正しければ
    // 常に >= 1 から減算されるが、 万一の drift でも負の件数表示に落とさない)。
    await tx
      .update(exams)
      .set({
        cardCount: sql`GREATEST(${exams.cardCount} - 1, 0)`,
        // card_count は派生キャッシュ。 更新で exams.updatedAt ($onUpdate) を
        // 動かさず、 試験一覧の並び順を card 削除で乱さない (B1 は perf 最適化)。
        updatedAt: sql`${exams.updatedAt}`,
      })
      .where(and(eq(exams.id, row.examId), eq(exams.userId, user.id)))

    return row.examId
  })

  if (examId === null) return { ok: false, error: 'カードが見つかりません' }

  revalidatePath(`/app/exams/${examId}`)
  return { ok: true, data: { examId } }
}
