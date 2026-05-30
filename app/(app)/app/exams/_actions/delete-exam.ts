'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, exams, tombstones } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import type { ActionResult } from '@/lib/actions/result'

// 試験一覧から exam を削除する server action。
//
// Task 6 (S-delete-0): _deleteExam を db.transaction に包み、
// 削除前に tombstone (exam + 配下 card 全件) を網羅 INSERT する。
//
// Spec §4 の実行順序:
//   1. exam 存在・owner 確認 SELECT → 0 行なら早期 return (idempotent)
//   2. 配下 card id 列挙 (FK CASCADE で消える前に)
//   3. tombstone 網羅 INSERT: exam(1件) + card(N件) を onConflictDoNothing で
//   4. exams DELETE → FK CASCADE (source_documents/cards/reviews 連動削除)
//
// 安全性: WHERE user_id = ? で他 user の exam を構造的に保護。
// 不在 / 他 user の examId は silent success (idempotent、 double-click 対策)。
export async function deleteExam(examId: string): Promise<ActionResult> {
  // S-cache-2a: revalidatePath('/app/exams') は撤去。 削除ボタンは /app/exams 上で
  // 押下され、 success 時に `delete-exam-button.tsx` の `router.refresh()` が
  // 同 path を再 fetch するため、 同 path の revalidatePath は redundant。
  // /app/upload は cross-page (upload page の「投入先を選択」 dropdown が active
  // exam 一覧に依存) のため revalidate を残置。
  try {
    return await _deleteExam(examId)
  } finally {
    revalidatePath('/app/upload')
  }
}

async function _deleteExam(examId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()

  // 子 card id は catch 節の serializeDbError に渡すため tx 外に宣言しておく。
  let childCardIds: string[] = []

  try {
    await db.transaction(async (tx) => {
      // §4-1: exam 存在・owner 確認
      // 0 行 = 不在 / 他 user → tombstone 挿入なしで早期 return (idempotent)。
      const examRows = await tx
        .select({ id: exams.id })
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))

      if (examRows.length === 0) {
        // 不在 / 他 user: silent success、tombstone は INSERT しない。
        return
      }

      // §4-2: 配下 card id 列挙 (CASCADE で消える前に記録)
      const childCards = await tx
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.examId, examId), eq(cards.userId, user.id)))

      childCardIds = childCards.map((c) => c.id)

      // §4-3: tombstone 網羅 INSERT (exam 1件 + 配下 card 全件) — mirror 削除反映の不変条件: この tombstone が無いと client mirror から消えない（pull.ts 参照）
      // onConflictDoNothing で再削除時の UNIQUE 制約エラーを吸収。
      // deleted_at は DB クロック (sql`now()`) で統一: tx 内 now() は一定なので
      // exam + 全 card tombstone が同一サーバー時刻で揃う。
      // 増分 pull の削除反映 cursor は DB クロックで統一するため JS Date を廃止。
      const tombstoneRows = [
        { userId: user.id, entityType: 'exam' as const, entityId: examId, deletedAt: sql`now()` },
        ...childCardIds.map((cardId) => ({
          userId: user.id,
          entityType: 'card' as const,
          entityId: cardId,
          deletedAt: sql`now()`,
        })),
      ]

      await tx.insert(tombstones).values(tombstoneRows).onConflictDoNothing()

      // §4-4: exams DELETE → FK CASCADE (source_documents/cards/reviews 連動削除)
      await tx
        .delete(exams)
        .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))
    })

    return { ok: true }
  } catch (err) {
    logger.error({
      event: 'exams.delete.failed',
      examId,
      userId: user.id,
      err: serializeDbError(err, { cardIds: childCardIds }),
    })
    return {
      ok: false,
      error: '試験の削除に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
