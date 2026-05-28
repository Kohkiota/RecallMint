// submitReviewTx — drizzle transaction 内で cards/reviews/study_days を一括更新する
// 純関数 (副作用: DB 書き込みのみ、外部 API 不呼び出し)。
// 現在の呼出元は bulk receiver (app/api/review-events/bulk/route.ts) の per-event tx。
//
// 「correct」定義: rating >= 2 (Again=不正解、Hard/Good/Easy=正解)。
// now の一本取り: 呼び出し元が作った Date を受け取り、全 step に同 instance を渡す。

import { and, eq, sql } from 'drizzle-orm'
import type { Card as FsrsCard } from 'ts-fsrs'
import { rate, type RatingInt } from '@/lib/fsrs'
import { getDb } from '@/lib/db'
import { cards, reviews, studyDays } from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'

// drizzle transaction callback の第 1 引数 (tx) の型を DB 型から導出する。
// Parameters<...>[0] = callback fn 型、さらにその Parameters[0] = tx 型。
type DrizzleTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

interface SubmitReviewTxParams {
  userId: string
  cardId: string
  rating: RatingInt
  now: Date
}

export interface SubmitReviewTxResult {
  correct: boolean
}

export async function submitReviewTx(
  tx: DrizzleTx,
  { userId, cardId, rating, now }: SubmitReviewTxParams,
  // [TEMP-MEASURE 2026-05-28 cache-fix 問題 3 Step 1] optional timings collector。
  // 出力は呼び元 (bulk route) が logger に書く。 計測 campaign 後に撤去。
  timingsOut?: Record<string, number>,
  timingsPrefix?: string,
): Promise<SubmitReviewTxResult> {
  const m = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (!timingsOut) return fn()
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      timingsOut[`${timingsPrefix ?? 'subtx'}-${name}`] = Math.round(
        performance.now() - t0,
      )
    }
  }

  // (1) owner-scoped SELECT cards (FSRS 列 + streak 関連)
  const rows = await m('select-cards', async () => tx
    .select({
      id: cards.id,
      userId: cards.userId,
      due: cards.due,
      stability: cards.stability,
      difficulty: cards.difficulty,
      elapsedDays: cards.elapsedDays,
      scheduledDays: cards.scheduledDays,
      reps: cards.reps,
      lapses: cards.lapses,
      state: cards.state,
      learningSteps: cards.learningSteps,
      lastReview: cards.lastReview,
      answered: cards.answered,
      lastCorrect: cards.lastCorrect,
      currentStreak: cards.currentStreak,
    })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .limit(1))

  if (rows.length === 0) {
    throw new Error('card not found')
  }
  const card = rows[0]

  // (2) DB row → ts-fsrs Card 型に変換して rate() 呼び出し
  // ts-fsrs Card は snake_case (elapsed_days, scheduled_days, learning_steps)、
  // DB 列は camelCase (elapsedDays, scheduledDays, learningSteps)
  const fsrsCard: FsrsCard = {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    // ts-fsrs Card.elapsed_days は v6.0.0 で削除予定 (@deprecated)。
    // v5 では代替フィールドが未公開のため引き続き使用し、lint を明示的に抑制する。
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview ?? undefined,
  }
  const result = rate(fsrsCard, rating, now)
  const next = result.card // RecordLogItem.card = 更新後の Card state

  // (3) cards UPDATE (FSRS 全列 + answered + last_correct + current_streak)
  const correct = rating >= 2
  await m('update-cards', async () => tx
    .update(cards)
    .set({
      due: next.due,
      stability: next.stability,
      difficulty: next.difficulty,
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
      learningSteps: next.learning_steps,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state,
      lastReview: next.last_review ?? now,
      answered: true,
      lastCorrect: correct,
      currentStreak: correct ? card.currentStreak + 1 : 0,
    })
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId))))

  // (4) reviews INSERT (append-only)
  await m('insert-reviews', async () => tx.insert(reviews).values({
    userId,
    cardId,
    rating,
    reviewedAt: now,
  }))

  // (5) study_days UPSERT
  // 当日 (JST) の distinct card 数を reviews から再集計 (今回の INSERT を含む)。
  // reviewed_at は timestamptz なので JST date 抽出には AT TIME ZONE が必要。
  // (T3 で streak.ts から AT TIME ZONE を削除する方針だが、本箇所は reviews 表への
  // 直接集計のため維持: submit-review-tx の固有要件)
  const day = todayInJst(now)
  const distinctRows = await m('select-distinct', async () => tx.execute(sql`
    SELECT COUNT(DISTINCT card_id)::int AS c FROM reviews
    WHERE user_id = ${userId}::uuid
      AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = ${day}::date
  `))
  const distinct = Number(distinctRows[0]?.c ?? 0)

  await m('upsert-study-days', async () => tx
    .insert(studyDays)
    .values({
      userId,
      day,
      reviewCount: 1,
      correctCount: correct ? 1 : 0,
      distinctCardCount: distinct,
    })
    .onConflictDoUpdate({
      target: [studyDays.userId, studyDays.day],
      set: {
        reviewCount: sql`${studyDays.reviewCount} + 1`,
        correctCount: sql`${studyDays.correctCount} + ${correct ? 1 : 0}`,
        distinctCardCount: distinct,
      },
    }))

  return { correct }
}
