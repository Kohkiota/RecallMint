'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, type CardOption } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'
import { parseUpdateCardInput, type UpdateCardInput } from '@/lib/validation/card'

// card 編集 page の保存 server action。 owner-scoped UPDATE で editable 5 列のみ
// 更新する。 correct_answer_ids は入力で受け取らず options[].is_correct から
// 再生成する (tech-spec §2.5.2 のデノーマ、 client 改竄に対しても堅牢)。
// deleteExam pattern 踏襲: auth gate → owner-scoped query → revalidatePath。
export async function updateCard(
  cardId: string,
  input: UpdateCardInput,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = parseUpdateCardInput(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const data = parsed.data

  // 編集 UI の camelCase 入力を DB の CardOption (snake_case) 形へ変換。
  // explanation は値がある option だけに付ける (空は省略して jsonb を肥やさない)。
  const options: CardOption[] = data.options.map((o) => ({
    id: o.id,
    text: o.text,
    is_correct: o.isCorrect,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }))
  const correctAnswerIds = options.filter((o) => o.is_correct).map((o) => o.id)

  const db = getDb()
  const updated = await db
    .update(cards)
    .set({
      title: data.title,
      questionText: data.questionText,
      options,
      correctAnswerIds,
      // 空の card 解説は null に正規化 (explanation_text は nullable)。
      explanationText: data.explanationText || null,
    })
    .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))
    .returning({ examId: cards.examId })

  const row = updated[0]
  if (!row) return { ok: false, error: 'カードが見つかりません' }

  revalidatePath(`/app/cards/${cardId}`)
  revalidatePath(`/app/exams/${row.examId}`)
  return { ok: true }
}
