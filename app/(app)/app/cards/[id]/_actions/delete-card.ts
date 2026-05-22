'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards } from '@/lib/db/schema'
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

  // owner-scoped で examId を引く。 0 行 = 不在 / 他 user → 削除せず終了。
  const found = await db
    .select({ examId: cards.examId })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))
    .limit(1)
  const row = found[0]
  if (!row) return { ok: false, error: 'カードが見つかりません' }

  // owner-scoped 単一文 DELETE。 WHERE に user_id を含め他 user の card を構造的に保護。
  await db
    .delete(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))

  revalidatePath(`/app/exams/${row.examId}`)
  return { ok: true, data: { examId: row.examId } }
}
