// POST /api/review-events/bulk — S-cache-1 (§14.8) 新設。
//
// client (SessionRunner) が Dexie に貯めた answer_events を bulk flush する receiver。
// study_sessions upsert + answer_events bulk insert + in-memory FSRS replay +
// cards / reviews / study_days を ONE transaction で一括処理する。
//
// 旧実装 (per-event tx × N) を廃止し、単一 tx + replayCard fold に置き換え。
// N=5 events で ~16s → ~2s 以内を目標。
//
// 冪等化:
// - `session_id` は studySessions PK、 upsert (ON CONFLICT DO UPDATE) で
//   completed_at / status / updated_at を最新値に重ね書き。
// - `event_id` は answerEvents UNIQUE、 INSERT は ON CONFLICT DO NOTHING +
//   returning() で実 insert 行のみ replay 対象とする。
//   重複 event は FSRS 適用も skip (= 安全に再送可能)。
//
// 部分失敗ポリシ:
// - orphan event (card が存在しない / 他 user 所有) → failed[] 収集、200 返却。
// - events tx 全体が throw → tx rollback、全 applicable event を failed[] に追加、
//   200 返却 (event_id 冪等性で次 flush は safe に再試行可)。
// - study_sessions upsert 失敗は 500 (session 同期できないと flush 全体の整合が
//   崩れるため、 client に retry を促す)。
//
// FSRS rating:
// - payload の `events[].rating` (1|2|3|4 = Again/Hard/Good/Easy) を優先利用、
//   未指定なら `is_correct ? 3 (Good) : 1 (Again)` に fallback で derive する。
//
// 認可: middleware は /app(.*) のみ protect。 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す。

import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import {
  answerEvents,
  cards,
  reviews,
  studyDays,
  studySessions,
  type User,
} from '@/lib/db/schema'
import { replayCard, type ReplayCardState } from '@/lib/cards/replay-card'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import type { RatingInt } from '@/lib/fsrs'
import { logger } from '@/lib/logger'
import { todayInJst } from '@/lib/jst'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Payload validation (zod)
// ---------------------------------------------------------------------------

// zod v4: top-level `z.uuid()` / `z.iso.datetime()` を使用 (旧 `z.string().uuid()` /
// `z.string().datetime()` は deprecated)。
const sessionSchema = z.object({
  session_id: z.uuid(),
  exam_id: z.uuid().optional(),
  mode: z.enum(['smart', 'custom']),
  card_ids: z.array(z.uuid()),
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime().optional(),
  status: z.enum(['active', 'completed', 'abandoned']),
})

const eventSchema = z.object({
  event_id: z.uuid(),
  card_id: z.uuid(),
  selected_answer_ids: z.array(z.string()),
  is_correct: z.boolean(),
  answered_at: z.iso.datetime(),
  elapsed_ms: z.number().int().nonnegative().optional(),
  // FSRS rating (1=Again / 2=Hard / 3=Good / 4=Easy)。 未指定なら handler 側で
  // is_correct から derive (route header 参照)。 z.union(literals) を使うのは
  // numeric enum 厳格化 (z.number() より narrow、 type 上も RatingInt と整合)。
  rating: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional(),
})

const payloadSchema = z.object({
  session: sessionSchema,
  // 1 回の flush で 1000 件超は実用上ないため上限を設けて DoS 寄りの巨大 payload を弾く。
  events: z.array(eventSchema).max(1000),
})

type BulkPayload = z.infer<typeof payloadSchema>
type ParsedEvent = z.infer<typeof eventSchema>

// FSRS rating を server が一元的に決める唯一の箇所。 payload 指定を優先し、 未指定は
// is_correct から derive (true→Good(3) / false→Again(1))。 replay と study_days 集計の
// 両方から呼ぶことで、 2 箇所で derive ロジックがズレる静かなバグを防ぐ。
function deriveRating(ev: Pick<ParsedEvent, 'rating' | 'is_correct'>): RatingInt {
  return ev.rating ?? (ev.is_correct ? 3 : 1)
}

// Drizzle の sql template に JS Date を直接 embed すると postgres-js の timestamptz
// serializer (OID 1184) が bypass され、 encode 経路で Buffer.byteLength(Date) が
// TypeError (ERR_INVALID_ARG_TYPE) になる (Drizzle #5789、 2026-05-29 stg smoke で確定)。
// timestamptz bind は ISO string 化してから embed する (::timestamptz cast で Postgres が
// parse、 null は維持)。 helper は throw しない (Invalid Date guard は本 fix の scope 外)。
function toPgTimestamptz(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

// ---------------------------------------------------------------------------
// processSession — 単一 tx で全 events を処理し failed[] を返す
// ---------------------------------------------------------------------------
// future: multi-session payload 対応の拡張ポイント。 今日は handler から 1 回だけ呼ぶ。

async function processSession(
  db: ReturnType<typeof getDb>,
  user: User,
  session: BulkPayload['session'],
  events: ParsedEvent[],
  measure: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
): Promise<{ failed: string[] }> {
  // events が空の場合は tx に入らず即返却
  if (events.length === 0) {
    return { failed: [] }
  }

  // Phase 1: orphan exclusion に使う distinct card_id セット
  const distinctCardIds = [...new Set(events.map((e) => e.card_id))]

  const orphanFailed: string[] = []
  let txFailed: string[] = []

  try {
    await db.transaction(async (tx) => {
      // ------------------------------------------------------------------
      // Phase 1 — cards SELECT (owner-scoped)
      // ------------------------------------------------------------------
      const cardRows = await measure('select-cards', async () =>
        tx
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
          })
          .from(cards)
          .where(
            and(
              eq(cards.userId, user.id),
              // owner-scoped IN 絞り込み — orphan / 他 user cards は返らない
              inArray(cards.id, distinctCardIds),
            ),
          ),
      )

      // card_id → ReplayCardState マップを構築
      const cardStateMap = new Map<string, ReplayCardState>()
      for (const row of cardRows) {
        cardStateMap.set(row.id, {
          due: row.due,
          stability: row.stability,
          difficulty: row.difficulty,
          elapsedDays: row.elapsedDays,
          scheduledDays: row.scheduledDays,
          reps: row.reps,
          lapses: row.lapses,
          state: row.state as 0 | 1 | 2 | 3,
          learningSteps: row.learningSteps,
          lastReview: row.lastReview,
          answered: row.answered,
          lastCorrect: row.lastCorrect,
          currentStreak: row.currentStreak,
        })
      }

      // orphan exclusion: card が返ってこなかった event は failed[] へ
      const applicableEvents: ParsedEvent[] = []
      for (const ev of events) {
        if (!cardStateMap.has(ev.card_id)) {
          orphanFailed.push(ev.event_id)
        } else {
          applicableEvents.push(ev)
        }
      }

      // applicable events が 0 件なら write フェーズはスキップ
      if (applicableEvents.length === 0) return

      // ------------------------------------------------------------------
      // Phase 2a — answer_events bulk INSERT (ON CONFLICT DO NOTHING)
      // ------------------------------------------------------------------
      const insertedRows = await measure('insert-events', async () =>
        tx
          .insert(answerEvents)
          .values(
            applicableEvents.map((ev) => ({
              eventId: ev.event_id,
              sessionId: session.session_id,
              cardId: ev.card_id,
              userId: user.id,
              selectedAnswerIds: ev.selected_answer_ids,
              isCorrect: ev.is_correct,
              answeredAt: new Date(ev.answered_at),
              elapsedMs: ev.elapsed_ms ?? null,
            })),
          )
          .onConflictDoNothing({ target: answerEvents.eventId })
          .returning({ eventId: answerEvents.eventId }),
      )

      // 実際に INSERT された event_id セット (duplicate は除外される)
      const insertedEventIds = new Set(insertedRows.map((r) => r.eventId))

      // ------------------------------------------------------------------
      // Phase 2b — replay gating: payload 順を守りつつ dedup
      // ------------------------------------------------------------------
      // - insertedEventIds にある → 新規 insert 確定 → apply
      // - ない → duplicate (既処理) → skip (failed には追加しない)
      // - consumedSet: 同 payload 内の重複 event_id を最初の出現のみ apply
      const consumedSet = new Set<string>()
      const eventsToApply = applicableEvents.filter((ev) => {
        if (!insertedEventIds.has(ev.event_id)) return false // duplicate → skip
        if (consumedSet.has(ev.event_id)) return false // intra-payload dedup
        consumedSet.add(ev.event_id)
        return true
      })

      if (eventsToApply.length === 0) return

      // ------------------------------------------------------------------
      // Phase 2c — in-memory FSRS replay (per card group)
      // ------------------------------------------------------------------
      // card_id ごとにグループ化。 グループ内は payload 順を保持する。
      type ReviewRow = { cardId: string; rating: RatingInt; reviewedAt: Date }
      const allReviewRows: ReviewRow[] = []
      // cards UPDATE に使う: cardId → final state
      const finalStates = new Map<string, ReplayCardState>()

      // グループ化 (insertion order で Map → payload 順保持)
      const grouped = new Map<string, ParsedEvent[]>()
      for (const ev of eventsToApply) {
        const arr = grouped.get(ev.card_id) ?? []
        arr.push(ev)
        grouped.set(ev.card_id, arr)
      }

      await measure('replay', async () => {
        for (const [cardId, groupEvents] of grouped) {
          const initial = cardStateMap.get(cardId)!
          const replayEvents = groupEvents.map((ev) => ({
            // payload rating 優先、未指定は is_correct から derive
            rating: deriveRating(ev),
            answeredAt: new Date(ev.answered_at),
          }))
          const { final, reviews: reviewsOut } = replayCard(initial, replayEvents)
          finalStates.set(cardId, final)
          // reviews 行を eventsToApply 順に戻すため groupEvents と reviewsOut を zip
          for (let i = 0; i < groupEvents.length; i++) {
            allReviewRows.push({
              cardId,
              rating: reviewsOut[i].rating,
              reviewedAt: reviewsOut[i].reviewedAt,
            })
          }
        }
        return undefined
      })

      // reviews 行の順序は group 順 (card_id 初出順)。 study_days は eventsToApply から
      // 別途集計するため、 reviews INSERT 順は最終結果に影響しない。

      // ------------------------------------------------------------------
      // Phase 2d — reviews bulk INSERT
      // ------------------------------------------------------------------
      await measure('insert-reviews', async () =>
        tx.insert(reviews).values(
          allReviewRows.map((r) => ({
            userId: user.id,
            cardId: r.cardId,
            rating: r.rating,
            reviewedAt: r.reviewedAt,
          })),
        ),
      )

      // ------------------------------------------------------------------
      // Phase 2e — cards UPDATE (single VALUES UPDATE、owner-scoped)
      // finalStates の全エントリを 1 round-trip で UPDATE する。
      // UPDATE cards SET ... FROM (VALUES (...), ...) AS v(id, ...) WHERE
      //   cards.id = v.id AND cards.user_id = $userId
      // ------------------------------------------------------------------
      await measure('update-cards', async () => {
        if (finalStates.size === 0) return undefined

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
            and(eq(cards.userId, user.id), sql`${cards.id} = v.id`),
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

        return undefined
      })

      // ------------------------------------------------------------------
      // Phase 2f — study_days UPSERT (per JST day)
      // ------------------------------------------------------------------
      await measure('study-days', async () => {
        // eventsToApply を JST date でグループ化して count 集計
        type DayCount = { total: number; correct: number }
        const dayMap = new Map<string, DayCount>()
        for (const ev of eventsToApply) {
          const day = todayInJst(new Date(ev.answered_at))
          const rating = deriveRating(ev)
          const existing = dayMap.get(day) ?? { total: 0, correct: 0 }
          existing.total += 1
          if (rating >= 2) existing.correct += 1
          dayMap.set(day, existing)
        }

        for (const [day, counts] of dayMap) {
          // reviews table から JST date 別 distinct card_id を再集計
          // (今回の reviews INSERT を含む)
          const distinctRows = await tx.execute(sql`
            SELECT COUNT(DISTINCT card_id)::int AS c FROM reviews
            WHERE user_id = ${user.id}::uuid
              AND (reviewed_at AT TIME ZONE 'Asia/Tokyo')::date = ${day}::date
          `)
          const distinct = Number(
            ((distinctRows as unknown) as Array<{ c: unknown }>)[0]?.c ?? 0,
          )

          await tx
            .insert(studyDays)
            .values({
              userId: user.id,
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
        return undefined
      })
    })
  } catch (err) {
    // tx 内部で予期しないエラー → rollback 済み。 applicable events を全て failed に。
    // orphan は既に orphanFailed に積んでいる。
    // [OBSERVABILITY A] native DB error を可視化するため serializeDbError で plain object 化。
    // logger の expandError は Error instance を {name,message,stack} に潰すため、 そのまま
    // 渡すと postgres-js の code/severity/detail/hint/constraint_name が消える。
    logger.warn({
      event: 'review_events.bulk.tx_failed',
      sessionId: session.session_id,
      userId: user.id,
      err: serializeDbError(err, { cardIds: events.map((e) => e.card_id) }),
    })
    txFailed = events
      .filter((ev) => !orphanFailed.includes(ev.event_id))
      .map((ev) => ev.event_id)
  }

  return { failed: [...orphanFailed, ...txFailed] }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // -- 認証 --
  let user: User | null
  try {
    user = await getCurrentUser()
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return Response.json({ error: 'unauthenticated' }, { status: 401 })
    }
    throw err
  }
  if (!user) {
    // Clerk session はあるが users 行未 sync (sign-up race)。 401 と区別して
    // client に「user 行が来るまで待って再送」 を促す。 sync_status は pending
    // のままにする想定。
    return Response.json({ error: 'user_not_synced' }, { status: 401 })
  }

  // [TEMP-MEASURE 2026-05-28 cache-fix 問題 3 Step 1] per-phase timing 計測 (logger 出力)。
  // production の log を汚さないため stg/preview/dev のみ出力。 計測 campaign 後に revert。
  const measureEnabled = process.env.VERCEL_ENV !== 'production'
  const timings: Record<string, number> = {}
  const measure = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      timings[name] = Math.round(performance.now() - t0)
    }
  }
  const tStart = performance.now()
  // marker: deploy 反映 + logger 動作 + route 到達を 1 fetch で確認できる単独 marker。
  if (measureEnabled) {
    logger.info({ event: 'review_events.bulk.request', userId: user.id })
  }

  // -- payload parse + validation --
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = payloadSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  const { session, events } = parsed.data as BulkPayload

  const db = getDb()

  // -- Phase 0: study_sessions upsert (events tx の外) --
  // PK = session_id。 同 session_id への再送は status / completed_at を
  // 最新値で上書き (updated_at は $onUpdate で自動)。
  // Phase 0 失敗 → 500 (session sync 不整合を防ぐため events は処理しない)。
  try {
    await measure('session-upsert', async () => db
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
      }))
  } catch (err) {
    logger.error({
      event: 'review_events.bulk.session_upsert_failed',
      sessionId: session.session_id,
      userId: user.id,
      err,
    })
    return Response.json({ error: 'session_upsert_failed' }, { status: 500 })
  }

  // -- Phase 1+2: events を単一 tx で処理 --
  const { failed } = await processSession(db, user, session, events, measure)

  timings['total'] = Math.round(performance.now() - tStart)
  if (measureEnabled) {
    logger.info({
      event: 'review_events.bulk.timing',
      userId: user.id,
      sessionId: session.session_id,
      eventCount: events.length,
      timings,
    })
  }
  return Response.json({ ok: true, failed }, { status: 200 })
}
