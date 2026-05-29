'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, exams } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'
import { buildEmptyCard } from '@/lib/cards/empty-card'
import { logger } from '@/lib/logger'
import { serializeDbError } from '@/lib/db/serialize-db-error'

// 試験詳細画面 (/app/exams/[id]) 末尾「+ カードを追加」用の card 手動作成 action。
// placeholder 値 (edit zod を満たす最小 card、 lib/cards/empty-card.ts) を owner-scoped
// で cards に INSERT し、 同一 transaction で exams.card_count += 1 する。
//
// spec §3.6: card_count は派生キャッシュ。 insert と increment を同一 tx に閉じることが
// 件数整合 (card_count === COUNT(cards)) の唯一の保証。 process.ts の bulk insert と
// 同じ tx + sql increment パターンに合わせる。
// updatedAt は card 増減で動かさない (試験一覧の updatedAt DESC 順を乱さない、
// process.ts B1 と同方針)。
//
// 出題除外 filter は付けない (spec §3.2: 空 card も query 可能、 意図的設計)。

// exam 0-row (不在 / 他 user) を tx 内で検出して rollback させるための sentinel。
const EXAM_NOT_FOUND = Symbol('exam-not-found')

export async function createCard(
  examId: string,
): Promise<ActionResult<{ cardId: string }>> {
  try {
    return await _createCard(examId)
  } finally {
    revalidatePath('/app/exams')
  }
}

async function _createCard(
  examId: string,
): Promise<ActionResult<{ cardId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()
  try {
    const result = await db.transaction(async (tx) => {
      // 1. exam owner 確認 (0 rows → sentinel return で card insert させず rollback)
      const ownerRows = await tx
        .select({ id: exams.id })
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))
      if (ownerRows.length === 0) return EXAM_NOT_FOUND

      // 2. 既存 card の sortKey 集合と件数を取得 (placeholder 採番用)
      const existing = await tx
        .select({ sortKey: cards.sortKey })
        .from(cards)
        .where(and(eq(cards.examId, examId), eq(cards.userId, user.id)))
      const existingSortKeys = existing.map((r) => r.sortKey)
      const existingCount = existing.length

      // 3. placeholder 値生成 (title/sortKey/questionText/options/correctAnswerIds)
      const placeholder = buildEmptyCard(existingSortKeys, existingCount)

      // 4. card INSERT (FSRS + due は schema default、 ここでは set しない)
      const inserted = await tx
        .insert(cards)
        .values({ userId: user.id, examId, sourceDocumentId: null, ...placeholder })
        .returning({ id: cards.id })

      // 5. 同一 tx で card_count += 1 (整合保証の核心)
      await tx
        .update(exams)
        .set({
          cardCount: sql`${exams.cardCount} + 1`,
          updatedAt: sql`${exams.updatedAt}`,
        })
        .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))

      return inserted[0].id
    })

    if (result === EXAM_NOT_FOUND) {
      return { ok: false, error: '試験が見つかりません' }
    }
    return { ok: true, data: { cardId: result } }
  } catch (err) {
    logger.error({
      event: 'cards.create.failed',
      examId,
      userId: user.id,
      err: serializeDbError(err, {}),
    })
    return {
      ok: false,
      error: 'カードの追加に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
