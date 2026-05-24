'use server'

// submitReview — FSRS 評価 1 件を cards/reviews/study_days に書き込む server action。
//
// 設計:
// - auth gate: getCurrentUser() が null なら早期 return (未認証)
// - rating validation: {1,2,3,4} 以外は invalid rating
// - now の一本取り: 冒頭で Date を 1 つ作り、 submitReviewTx に渡して全 step で共有
// - throw は catch して { ok: false, error: 'カードが見つかりません' } に変換

import { revalidatePath } from 'next/cache'

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { logger } from '@/lib/logger'
import { submitReviewTx } from '@/lib/cards/submit-review-tx'
import type { ActionResult } from '@/lib/actions/result'
import type { RatingInt } from '@/lib/fsrs'

export async function submitReview(
  cardId: string,
  rating: number,
): Promise<ActionResult<{ correct: boolean }>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  if (![1, 2, 3, 4].includes(rating)) {
    return { ok: false, error: 'invalid rating' }
  }

  const db = getDb()
  const now = new Date()

  try {
    const result = await db.transaction(async (tx) =>
      submitReviewTx(tx, {
        userId: user.id,
        cardId,
        rating: rating as RatingInt,
        now,
      }),
    )
    revalidatePath('/app')
    return { ok: true, data: result }
  } catch (err) {
    logger.error({ event: 'submit_review.error', err, cardId, userId: user.id })
    return { ok: false, error: 'カードが見つかりません' }
  }
}
