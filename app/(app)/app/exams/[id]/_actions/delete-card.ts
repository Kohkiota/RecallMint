'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import type { ActionResult } from '@/lib/actions/result'
import { logger } from '@/lib/logger'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { applyCardDelete } from '@/lib/cards/apply-card-mutation'

// 試験詳細画面 (/app/exams/[id]) の per-card 削除 server action (spec §3.4)。
//
// 同一 tx 内で:
//   1. cards から cardId + userId で存在確認 (0 rows → idempotent success、tombstone スキップ)
//   2. tombstones INSERT (.onConflictDoNothing() — Drizzle chainable、 re-delete 安全)
//   3. cards DELETE (owner-scoped)
//   4. exams.card_count -= 1 (GREATEST guard、 負にならない)
//
// updatedAt は card 増減で動かさない (create-card.ts B1 と同方針)。
// 最後の 1 枚も削除可 (no ≥1 guard、 空 exam を許容)。
// owner-scope: cardId + userId 全 statement に含める。
//
// ドメイン core (applyCardDelete) は lib/cards/apply-card-mutation.ts に抽出済 (Task 1.1)。
// この wrapper は認証 / transaction 境界 / ActionResult 変換 / logger / revalidatePath を担う。

export async function deleteCard(cardId: string): Promise<ActionResult> {
  try {
    return await _deleteCard(cardId)
  } finally {
    // 削除ボタンの router.refresh() は呼出元 (/app/exams/[id] 詳細) を再 fetch するが、
    // 試験一覧 /app/exams の「カード N 件」 (exams.card_count 由来) は別 route で
    // stale になる。 cardCount を減らすため cross-page で list cache を invalidate する
    // (create-card.ts と同方針。 delete-exam.ts が /app/exams revalidate を落としたのは
    //  exam 行ごと消えて一覧から消滅するためで、 card 削除は exam が残る点が異なる)。
    revalidatePath('/app/exams')
  }
}

async function _deleteCard(cardId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()
  try {
    await db.transaction(async (tx) => {
      await applyCardDelete(tx, cardId, user.id)
    })

    return { ok: true }
  } catch (err) {
    logger.error({
      event: 'cards.delete.failed',
      cardId,
      userId: user.id,
      err: serializeDbError(err, { cardIds: [cardId] }),
    })
    return {
      ok: false,
      error: 'カードの削除に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
