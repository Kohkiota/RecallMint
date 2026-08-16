import 'server-only'
// 復習 ingest の infra 層 (DB I/O)。純粋 domain (session-aggregate) と分離し、
// orchestrator (ingest-review-events.ts の processAnswerEvents) が両者を束ねる。
//
// 制約:
// - repository は logger を呼ばない (構造化 log は orchestrator の責務)。
// - RLS 下でも owner-scope の `user_id` 条件は query 側にも明示する。
// - ロック順序の全 tx 共通規約は `cards`(ID 昇順)→ `study_days`(day 昇順)。
//   ingest は全経路この順序でのみロックを取るため deadlock は生じない。

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import type { DB } from '@/lib/db'
import { answerEvents, cards, reviewLogs, studyDays } from '@/lib/db/schema'
import type { ReplayCardState } from '@/lib/cards/replay-card'
import type { RatingInt } from '@/lib/fsrs'
import { jstDayRange } from '@/lib/jst'

// study_days の再集計は tx.execute(sql`...`) を使うため、DbExecutor
// (select/insert/update/delete) に execute を足した executor 型を用いる。
// db 直 / tx いずれも PgDatabase 派生ゆえ両者が構造的に適合する。
type SessionExecutor = DbExecutor & Pick<DB, 'execute'>

// ---------------------------------------------------------------------------
// lockCardReplayStates — spec §2.2 手順 3。
// distinct card_id を **ID 昇順** で FOR UPDATE ロックし、同一 card への並走 flush を
// 直列化する。ORDER BY id は複数行ロックの取得順を固定して deadlock を防ぐ既存規律
// (publish-prepared.ts と同型)。owner-scope により不在 / 他人 card は返らない
// (= 呼ぶ側では applied=false 降格の判定材料になる)。
// ---------------------------------------------------------------------------

export function lockCardReplayStates(
  tx: DbExecutor,
  userId: string,
  sortedCardIds: string[],
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
    .where(and(eq(cards.userId, userId), inArray(cards.id, sortedCardIds)))
    .orderBy(cards.id)
    .for('update')
}

// ---------------------------------------------------------------------------
// insertAnswerEvents — spec §2.2 手順 4 前半。
// 受理可能な event を **全件** applied=false で INSERT し、実 INSERT された
// event_id の Set を返す (非新規 = 既存行あり → 呼ぶ側が衝突検証へ回す)。
// ---------------------------------------------------------------------------

export interface AnswerEventInsertRow {
  eventId: string
  userId: string
  cardId: string
  sessionId: string | null
  selectedAnswerIds: string[]
  isCorrect: boolean
  rating: RatingInt
  answeredAt: Date
  elapsedMs: number | null
  applied: boolean
  createdAt: Date
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
// verifyEventCollisions — spec §2.2 手順 4 後半の 2 段検証。
//
// ① 所有権: 非新規 event_id が own-scope SELECT に不在 = 他 user の行と衝突
//    (RLS を迂回して owner を覗きに行かない。owner 情報は知り得ないし出さない)。
// ② 内容一致: own 既存行と immutable fields を app 層で正規化比較する。
//    - answered_at は `min(再送 raw, 既存行 created_at)` = 初回 insert と同じ clamp 式を
//      既存行の受信時刻で再評価した値と比較する。正当な再送は raw が同一なので必ず
//      一致し、初回に clamp された event の再送が受信時刻差で偽陽性にならない。
//    - session_id / elapsed_ms は undefined ↔ NULL を正規化して比較する。
//    - selected_answer_ids は配列順込みの等値。
// 一致 = 正当な再送 (failed に載せない) / 不一致 = failed[] (既存行は不変 = 先勝ち)。
// ---------------------------------------------------------------------------

export interface CollisionCandidate {
  eventId: string
  cardId: string
  sessionId: string | null
  selectedAnswerIds: string[]
  isCorrect: boolean
  rating: RatingInt
  /** clamp 前の raw answered_at (既存行の created_at で clamp し直して比較する)。 */
  rawAnsweredAt: Date
  elapsedMs: number | null
}

export async function verifyEventCollisions(
  tx: DbExecutor,
  userId: string,
  candidates: CollisionCandidate[],
): Promise<string[]> {
  if (candidates.length === 0) return []

  const existingRows = await tx
    .select({
      eventId: answerEvents.eventId,
      cardId: answerEvents.cardId,
      sessionId: answerEvents.sessionId,
      selectedAnswerIds: answerEvents.selectedAnswerIds,
      isCorrect: answerEvents.isCorrect,
      rating: answerEvents.rating,
      answeredAt: answerEvents.answeredAt,
      elapsedMs: answerEvents.elapsedMs,
      createdAt: answerEvents.createdAt,
    })
    .from(answerEvents)
    .where(
      and(
        eq(answerEvents.userId, userId),
        inArray(
          answerEvents.eventId,
          candidates.map((c) => c.eventId),
        ),
      ),
    )
  const ownRows = new Map(existingRows.map((r) => [r.eventId, r]))

  const failed: string[] = []
  for (const candidate of candidates) {
    const existing = ownRows.get(candidate.eventId)
    if (existing === undefined || !matchesExisting(candidate, existing)) {
      failed.push(candidate.eventId)
    }
  }
  return failed
}

type ExistingAnswerEventRow = {
  cardId: string
  sessionId: string | null
  selectedAnswerIds: string[]
  isCorrect: boolean
  rating: number
  answeredAt: Date
  elapsedMs: number | null
  createdAt: Date
}

function matchesExisting(
  candidate: CollisionCandidate,
  existing: ExistingAnswerEventRow,
): boolean {
  const clampedAnsweredAt = Math.min(
    candidate.rawAnsweredAt.getTime(),
    existing.createdAt.getTime(),
  )
  return (
    candidate.cardId === existing.cardId &&
    candidate.sessionId === existing.sessionId &&
    candidate.isCorrect === existing.isCorrect &&
    candidate.rating === existing.rating &&
    candidate.elapsedMs === existing.elapsedMs &&
    clampedAnsweredAt === existing.answeredAt.getTime() &&
    candidate.selectedAnswerIds.length === existing.selectedAnswerIds.length &&
    candidate.selectedAnswerIds.every(
      (id, i) => id === existing.selectedAnswerIds[i],
    )
  )
}

// ---------------------------------------------------------------------------
// markApplied — spec §2.2 手順 7。順序ガードを通った event を applied=true にする。
// ---------------------------------------------------------------------------

export async function markApplied(
  tx: DbExecutor,
  userId: string,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return
  await tx
    .update(answerEvents)
    .set({ applied: true })
    .where(
      and(
        eq(answerEvents.userId, userId),
        inArray(answerEvents.eventId, eventIds),
      ),
    )
}

// ---------------------------------------------------------------------------
// insertReviewLogs — spec §5 手順 7.5 (markApplied 直後・recomputeStudyDays 前)。
// 適用された event の ts-fsrs ReviewLog を bulk INSERT する (spec §3.1 の 17 列)。
// plain INSERT (onConflict なし) — 同一 event の再適用は Sprint A の既存冪等 2 段
// (payload 内 dedupe + onConflictDoNothing) が構造的に排除するため、23505 は
// fold 二重適用という上流バグの loud 検出とする (spec §4)。
// ---------------------------------------------------------------------------

export interface ReviewLogInsertRow {
  eventId: string
  userId: string
  cardId: string
  rating: RatingInt
  stateBefore: 0 | 1 | 2 | 3
  dueBefore: Date
  stabilityBefore: number
  difficultyBefore: number
  elapsedDays: number
  lastElapsedDays: number
  scheduledDays: number
  learningSteps: number
  review: Date
  stateAfter: 0 | 1 | 2 | 3
  stabilityAfter: number
  difficultyAfter: number
  createdAt: Date
}

export async function insertReviewLogs(
  tx: DbExecutor,
  rows: ReviewLogInsertRow[],
): Promise<void> {
  if (rows.length === 0) return
  await tx.insert(reviewLogs).values(rows)
}

// ---------------------------------------------------------------------------
// applyCardFinalStates — spec §2.2 手順 6 (single VALUES UPDATE、owner-scoped)。
// RETURNING 件数 ≠ finalStates.size で count-mismatch を throw する安全網を内包。
// finalStates.size === 0 は no-op。
// ---------------------------------------------------------------------------

// timestamptz bind は ISO string 化してから embed する (Drizzle #5789 回避)。null は維持。
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
    const rows = [...finalStates.entries()].map(([cardId, final]) =>
      sql`(${cardId}::uuid, ${toPgTimestamptz(final.due)}::timestamptz, ${final.stability}::double precision, ${final.difficulty}::double precision, ${final.elapsedDays}::int, ${final.scheduledDays}::int, ${final.reps}::int, ${final.lapses}::int, ${final.state}::int, ${final.learningSteps}::int, ${toPgTimestamptz(final.lastReview)}::timestamptz, ${final.answered}::boolean, ${final.lastCorrect}::boolean, ${final.currentStreak}::int)`,
    )
    const valuesList = sql.join(rows, sql`, `)

    // RETURNING cards.id で実 update 件数を取得し、 finalStates と不一致なら throw
    // (tx rollback)。 SQL 成功で 0 rows update を黙って通す事故の安全網。
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
      .where(and(eq(cards.userId, userId), sql`${cards.id} = v.id`))
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
// recomputeStudyDays — spec §5。対象 day を applied=true event から **絶対値で再集計**
// する (加算意味論は廃止)。
//
// 手順:
//   1. day 昇順に行を確保 (INSERT .. ON CONFLICT DO NOTHING)
//   2. 同じ昇順で FOR UPDATE ロック
//   3. VALUES CTE で対象 day のみ range scan して再集計 → 絶対値 UPDATE
// 1-2 が必須なのは、card 行ロックが**同一 card しか直列化しない**ため。同一 user・
// 異なる card・同一 day の 2 flush が並走すると、双方が相手の未 commit event を含まない
// 集計値を後勝ちで上書きしうる (full 再集計でも消えない lost update)。day 行を先に
// ロックすると後続 tx の再集計 SELECT は先行 commit 後に走り、正しい合計を読む。
//
// JST 境界は SQL の AT TIME ZONE ではなく jstDayRange() の timestamptz を bind する
// (JS/SQL 二重実装の解消)。日付 param は個別 param + 明示 ::date cast で展開する —
// 配列を単一 param で bind する経路は postgres-js の serializer 依存で壊れた前例がある。
// ---------------------------------------------------------------------------

export async function recomputeStudyDays(
  tx: SessionExecutor,
  userId: string,
  days: string[],
): Promise<void> {
  if (days.length === 0) return
  // 重複 day は静かに畳む。再集計は絶対値なので同じ day を 2 回並べても結果は変わらず、
  // 呼び側の重複を throw に昇格させると client の再送ループを生むだけになる。
  // (下の postcondition を「ロック網羅性」の主張だけに絞るためでもある)
  const sortedDays = [...new Set(days)].sort()

  await tx
    .insert(studyDays)
    .values(sortedDays.map((day) => ({ userId, day })))
    .onConflictDoNothing({ target: [studyDays.userId, studyDays.day] })

  const dayList = sql.join(
    sortedDays.map((day) => sql`${day}::date`),
    sql`, `,
  )
  const lockedRows = await tx
    .select({ day: studyDays.day })
    .from(studyDays)
    .where(and(eq(studyDays.userId, userId), sql`${studyDays.day} IN (${dayList})`))
    .orderBy(studyDays.day)
    .for('update')

  // ロック行が要求 day 数に満たない = 直後の再集計 UPDATE が該当 day に一切マッチせず
  // 黙って集計を取りこぼす (silent undercount)。applyCardFinalStates の
  // count-mismatch throw と同型の loud fail に倒して tx を rollback させる。
  const lockedDays = new Set(lockedRows.map((r) => r.day))
  if (lockedDays.size !== sortedDays.length) {
    const mismatch = new Error('study_days lock row count mismatch')
    Object.assign(mismatch, {
      expected: sortedDays.length,
      locked: lockedDays.size,
      missingDays: sortedDays.filter((d) => !lockedDays.has(d)),
    })
    throw mismatch
  }

  const dayTuples = sql.join(
    sortedDays.map((day) => {
      const { startAt, endAt } = jstDayRange(day)
      return sql`(${day}::date, ${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)`
    }),
    sql`, `,
  )
  await tx.execute(sql`
    WITH days(day, start_at, end_at) AS (VALUES ${dayTuples}),
    agg AS (
      SELECT d.day AS day,
             count(*)::int AS review_count,
             count(*) FILTER (WHERE ae.is_correct)::int AS correct_count,
             count(DISTINCT ae.card_id)::int AS distinct_card_count
      FROM days d
      JOIN answer_events ae
        ON ae.user_id = ${userId}::uuid AND ae.applied
       AND ae.answered_at >= d.start_at AND ae.answered_at < d.end_at
      GROUP BY d.day
    )
    UPDATE study_days sd
       SET review_count = agg.review_count,
           correct_count = agg.correct_count,
           distinct_card_count = agg.distinct_card_count
      FROM agg
     WHERE sd.user_id = ${userId}::uuid AND sd.day = agg.day
  `)
}
