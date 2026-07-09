import 'server-only'
// Session aggregate の infra 層 (DB I/O)。 spec §3.3 の意図別 repository。
//
// 各メソッドは Drizzle executor (db 直 or tx) を第 1 引数に取り、その上で
// DB statement を実行する。 純粋 domain (session-aggregate / session-values) と
// 分離し、orchestrator (ingest-review-events.ts の processSession) が両者を束ねる。
//
// 制約 (spec §3.3):
// - repository は logger を呼ばない (serializeDbError warn は orchestrator に残す)。
// - SQL は現 processSession から verbatim 移設 (owner-scope WHERE / ON CONFLICT /
//   VALUES UPDATE / distinct SELECT / count-mismatch throw を一字一句保つ)。
// - 挙動不変 (R phase)。既存 route.test + contract + G1-G5 が回帰の正。

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import type { DB } from '@/lib/db'
import {
  answerEvents,
  cards,
  reviews,
  studyDays,
  studySessions,
  type User,
} from '@/lib/db/schema'
import { inDateList } from '@/lib/db/in-date-list'
import type { ReplayCardState } from '@/lib/cards/replay-card'
import type { RatingInt } from '@/lib/fsrs'

// study_days の distinct 集計は tx.execute(sql`...`) を使うため、DbExecutor
// (select/insert/update/delete) に execute を足した executor 型を用いる。
// db 直 / tx いずれも PgDatabase 派生ゆえ両者が構造的に適合する。
type SessionExecutor = DbExecutor & Pick<DB, 'execute'>

// ---------------------------------------------------------------------------
// loadCardReplayStates — Phase 1 SELECT (owner-scoped)。
// raw rows (id + 全 ReplayCardState 列 + options) を返す。Set 化 / cardStateMap 化は
// 呼ぶ側 (orchestrator + domain) の責務。ingest-review-events.ts:110-135 verbatim。
// ---------------------------------------------------------------------------

export function loadCardReplayStates(
  tx: DbExecutor,
  userId: string,
  cardIds: string[],
) {
  return tx
    .select({
      id: cards.id,
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
      options: cards.options,
    })
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        // owner-scoped IN 絞り込み — orphan / 他 user cards は返らない
        inArray(cards.id, cardIds),
      ),
    )
}

// ---------------------------------------------------------------------------
// insertAnswerEvents — Phase 2a bulk INSERT (ON CONFLICT DO NOTHING)。
// 実際に INSERT された event_id の Set を返す (duplicate は除外される)。
// ingest-review-events.ts:204-219 (+ 222 の Set 化) verbatim。
// ---------------------------------------------------------------------------

export interface AnswerEventInsertRow {
  eventId: string
  sessionId: string
  cardId: string
  userId: string
  selectedAnswerIds: string[]
  isCorrect: boolean
  answeredAt: Date
  elapsedMs: number | null
}

export async function insertAnswerEvents(
  tx: DbExecutor,
  rows: AnswerEventInsertRow[],
): Promise<Set<string>> {
  const insertedRows = await tx
    .insert(answerEvents)
    .values(rows)
    .onConflictDoNothing({ target: answerEvents.eventId })
    .returning({ eventId: answerEvents.eventId })

  return new Set(insertedRows.map((r) => r.eventId))
}

// ---------------------------------------------------------------------------
// insertReviews — Phase 2d reviews bulk INSERT。
// ingest-review-events.ts:282-289 verbatim。
// ---------------------------------------------------------------------------

export interface ReviewInsertRow {
  userId: string
  cardId: string
  rating: RatingInt
  reviewedAt: Date
}

export async function insertReviews(
  tx: DbExecutor,
  rows: ReviewInsertRow[],
): Promise<void> {
  await tx.insert(reviews).values(rows)
}

// ---------------------------------------------------------------------------
// applyCardFinalStates — Phase 2e cards UPDATE (single VALUES UPDATE、owner-scoped)。
// RETURNING 件数 ≠ finalStates.size で count-mismatch を throw する安全網を内包。
// finalStates.size === 0 は no-op。ingest-review-events.ts:297-351 verbatim。
// ---------------------------------------------------------------------------

// timestamptz bind は ISO string 化してから embed する (Drizzle #5789 回避)。
// null は維持。ingest-review-events.ts:79-81 verbatim。
function toPgTimestamptz(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

export async function applyCardFinalStates(
  tx: DbExecutor,
  userId: string,
  finalStates: Map<string, ReplayCardState>,
): Promise<void> {
  if (finalStates.size !== 0) {
    // per-card tuple リスト (VALUES 節用)
    // 各値はバインドパラメータ (${...}) 経由 — 文字列結合は一切しない。
    // ::cast は静的リテラルのみ (安全)。
    // timestamptz (due / last_review) は ISO string 化してから embed (Drizzle #5789、
    // toPgTimestamptz 参照)。 数値 / boolean / uuid はそのまま bind 可。
    const rows = [...finalStates.entries()].map(([cardId, final]) =>
      sql`(${cardId}::uuid, ${toPgTimestamptz(final.due)}::timestamptz, ${final.stability}::real, ${final.difficulty}::real, ${final.elapsedDays}::int, ${final.scheduledDays}::int, ${final.reps}::int, ${final.lapses}::int, ${final.state}::int, ${final.learningSteps}::int, ${toPgTimestamptz(final.lastReview)}::timestamptz, ${final.answered}::boolean, ${final.lastCorrect}::boolean, ${final.currentStreak}::int)`,
    )
    const valuesList = sql.join(rows, sql`, `)

    // RETURNING cards.id で実 update 件数を取得し、 finalStates と不一致なら throw
    // (tx rollback → 上位 catch が serializeDbError で log)。 SQL 成功で 0 rows update を
    // 黙って通す事故の安全網。
    const updated = await tx
      .update(cards)
      .set({
        due: sql`v.due`,
        stability: sql`v.stability`,
        difficulty: sql`v.difficulty`,
        elapsedDays: sql`v.elapsed_days`,
        scheduledDays: sql`v.scheduled_days`,
        reps: sql`v.reps`,
        lapses: sql`v.lapses`,
        state: sql`v.state`,
        learningSteps: sql`v.learning_steps`,
        lastReview: sql`v.last_review`,
        answered: sql`v.answered`,
        lastCorrect: sql`v.last_correct`,
        currentStreak: sql`v.current_streak`,
        // DB クロックで打刻 (増分 pull cursor 統一、now() は DB 側評価で #5789 と無関係)。
        updatedAt: sql`now()`,
      })
      .from(
        sql`(VALUES ${valuesList}) AS v(id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, learning_steps, last_review, answered, last_correct, current_streak)`,
      )
      .where(
        and(eq(cards.userId, userId), sql`${cards.id} = v.id`),
      )
      .returning({ id: cards.id })

    const updatedIds = new Set(updated.map((r) => r.id))
    if (updatedIds.size !== finalStates.size) {
      const missingCardIds = [...finalStates.keys()].filter(
        (id) => !updatedIds.has(id),
      )
      const mismatch = new Error('bulk update card count mismatch')
      Object.assign(mismatch, {
        expected: finalStates.size,
        updated: updatedIds.size,
        missingCardIds,
      })
      throw mismatch
    }
  }
}

// ---------------------------------------------------------------------------
// upsertStudyDays — Phase 2f study_days UPSERT (per JST day)。
// distinct 集計 SELECT (inDateList + AT TIME ZONE) + per-day UPSERT
// (ON CONFLICT DO UPDATE・SUM increment + distinct 上書き)。dayMap.size === 0 は
// 呼ぶ側で早期 return 済。ingest-review-events.ts:368-416 verbatim。
// ---------------------------------------------------------------------------

export interface DayCount {
  total: number
  correct: number
}

export async function upsertStudyDays(
  tx: SessionExecutor,
  userId: string,
  dayMap: Map<string, DayCount>,
): Promise<void> {
  // T-B2 #1a 再実装 (採用 X、 helper 化): per-day SELECT N+1 を
  // `GROUP BY day` 1 文に集約。 inDateList helper で `IN ($1::date,
  // $2::date, ...)` 形に個別 param 展開し、 driver 層挙動 (postgres-js
  // Array serializer / Drizzle inArray 配列 binding) 依存を最小化する
  // (a885199 stg 実機検証で X 形を確証、 lesson 2026-06-13 訂正
  // section 参照)。 UPSERT は plan 制約「ON CONFLICT DO UPDATE」 構造
  // 維持で per-day ループ (SUM increment + 累積 distinct 上書き)。
  const days = [...dayMap.keys()]
  const distinctRows = await tx.execute(sql`
          SELECT (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date::text AS day,
                 COUNT(DISTINCT card_id)::int AS distinct_count
          FROM reviews
          WHERE user_id = ${userId}::uuid
            AND ${inDateList(sql`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date`, days)}
          GROUP BY (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date
        `)
  const distinctMap = new Map<string, number>()
  for (const row of distinctRows as unknown as Array<{
    day: string
    distinct_count: unknown
  }>) {
    distinctMap.set(row.day, Number(row.distinct_count))
  }

  for (const [day, counts] of dayMap) {
    // event tx 直後の reviews row 不在は実 DB では起きないが、 防御的に
    // fallback (distinctMap.get ?? 0) で distinctCardCount=0 にする。
    const distinct = distinctMap.get(day) ?? 0

    await tx
      .insert(studyDays)
      .values({
        userId,
        day,
        reviewCount: counts.total,
        correctCount: counts.correct,
        distinctCardCount: distinct,
      })
      .onConflictDoUpdate({
        target: [studyDays.userId, studyDays.day],
        set: {
          reviewCount: sql`${studyDays.reviewCount} + ${counts.total}`,
          correctCount: sql`${studyDays.correctCount} + ${counts.correct}`,
          distinctCardCount: distinct,
        },
      })
  }
}

// ---------------------------------------------------------------------------
// upsertSessionGuarded — study_sessions upsert (参照事実 D の R 形)。
// R 実装 = 現 route.ts:93-125 の SQL verbatim (conflictSet = {completedAt, status}
// のみ・setWhere = eq(userId)・.returning() なし) + applied: true 固定返却。
// この task では additive (processSession は使わない・route は Task 4 まで使わない)。
// W (Task 6) が setWhere 遷移述語 / .returning() / applied 実計算に差し替える。
// ---------------------------------------------------------------------------

export interface SessionUpsertInput {
  session_id: string
  exam_id?: string
  mode: 'smart' | 'custom'
  card_ids: string[]
  started_at: string
  completed_at?: string
  status: 'active' | 'completed' | 'abandoned'
}

export async function upsertSessionGuarded(
  db: DbExecutor,
  user: User,
  session: SessionUpsertInput,
): Promise<{ applied: boolean }> {
  await db
    .insert(studySessions)
    .values({
      sessionId: session.session_id,
      userId: user.id,
      examId: session.exam_id ?? null,
      mode: session.mode,
      cardIds: session.card_ids,
      startedAt: new Date(session.started_at),
      completedAt: session.completed_at
        ? new Date(session.completed_at)
        : null,
      status: session.status,
    })
    .onConflictDoUpdate({
      target: studySessions.sessionId,
      // C-1 (S-cache-1 review): tenant 分離。 同 session_id が既に存在し、 かつ
      // 所有 user が認証 user と一致するときだけ UPDATE を許可する。 攻撃者 B が
      // victim A の session_id (uuidv4) を運悪く入手して POST しても、 setWhere
      // が match しないため UPDATE は no-op、 INSERT も既存行と PK 衝突で no-op
      // (= cross-tenant write 完全防止)。 (CLAUDE.md Clerk 5)
      setWhere: eq(studySessions.userId, user.id),
      // I-1 (S-cache-1 review): card_ids は session 開始時に確定する不変値。
      // conflict 上書き対象から外し (initial insert のみ書く)、 status と
      // completed_at だけ最新値で更新する。 「同 session_id への再送で card_ids
      // が空配列に倒れる」 client side race を構造的に防ぐ (§14.8 整合)。
      set: {
        completedAt: session.completed_at
          ? new Date(session.completed_at)
          : null,
        status: session.status,
      },
    })

  // R 形は返り値未消費 (route は Phase 0 で awaited)。W で applied 実計算に差替。
  return { applied: true }
}
