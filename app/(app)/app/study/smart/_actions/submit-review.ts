'use server'

// submitReview — FSRS 評価 1 件を cards/reviews/study_days に書き込む server action。
//
// 設計:
// - auth gate: getCurrentUser() が null なら早期 return (未認証)
// - rating validation: {1,2,3,4} 以外は invalid rating
// - now の一本取り: 冒頭で Date を 1 つ作り、 submitReviewTx に渡して全 step で共有
// - throw は catch して { ok: false, error: 'カードが見つかりません' } に変換
//
// S2.0b-2 fix: 旧実装で導入していた revalidatePath('/app') (dashboard 反映漏れ修正
// 目的) は、 Next.js 15 server action からの呼出が active page (= /app/study/smart)
// の RSC payload まで refresh させ、 SessionRunner の props.cards が submit 直後に
// 変化 → idx=0 + judged 維持で 「次のカード」 が current として描画される regression
// を発生させたため撤回。 dashboard (`/app/page.tsx`) は getCurrentUser() / DB SELECT
// で構成される dynamic page で、 Next.js 15 default `staleTimes.dynamic = 0` により
// client cache されないため、 SessionRunner 完了画面の 「ダッシュボードへ」 Link
// 押下による navigation 時に server で fresh fetch される (= submit 時の明示
// revalidate は不要)。 将来 staleTimes を上書きしたり dashboard を ISR 化する場合は
// 本前提が崩れるので注意 (その時は dashboard 側に `export const dynamic = 'force-dynamic'`
// を明示するか、 SessionRunner unmount 時に明示 invalidation する代替策が必要)。

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
    return { ok: true, data: result }
  } catch (err) {
    logger.error({ event: 'submit_review.error', err, cardId, userId: user.id })
    return { ok: false, error: 'カードが見つかりません' }
  }
}
