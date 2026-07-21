import 'server-only'
// P2 時点の置き場。Learning context の最終形ではない(spec §3.1 条件 1 — replay-card は lib/cards/ に分散)。
// A-2: selected_answer_ids は対象 card の options に実在する id のみを許容する(server 検証)。

import { z } from 'zod'
import { type User } from '@/lib/db/schema'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { type ReplayCardState } from '@/lib/cards/replay-card'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { logger } from '@/lib/logger'
import {
  cardIdsSchema,
  selectedAnswerIdsSchema,
} from '@/lib/validation/review-session-bounds'
import {
  aggregateStudyDays,
  admitEvents,
  buildCardOptionIndex,
  planReplay,
  replaySession,
} from '@/lib/reviews/domain/session-aggregate'
import {
  applyCardFinalStates,
  insertAnswerEvents,
  insertReviews,
  loadCardReplayStates,
  upsertStudyDays,
} from '@/lib/reviews/session-repository'

// ---------------------------------------------------------------------------
// Payload validation (zod)
// ---------------------------------------------------------------------------

// zod v4: top-level `z.uuid()` / `z.iso.datetime()` を使用 (旧 `z.string().uuid()` /
// `z.string().datetime()` は deprecated)。
const sessionSchema = z.object({
  session_id: z.uuid(),
  exam_id: z.uuid().optional(),
  mode: z.enum(['smart', 'custom']),
  card_ids: cardIdsSchema,
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime().optional(),
  status: z.enum(['active', 'completed', 'abandoned']),
})

const eventSchema = z.object({
  event_id: z.uuid(),
  card_id: z.uuid(),
  selected_answer_ids: selectedAnswerIdsSchema,
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

// deriveRating (FSRS rating の一元決定・P0 §A #7 凍結契約) と Phase 1-2f の
// pure ロジックは lib/reviews/domain/session-aggregate.ts に、SQL は
// lib/reviews/session-repository.ts に分離済 (R2)。processSession は両者を束ねる
// orchestrator に縮退した。

// ---------------------------------------------------------------------------
// processSession — 単一 tx で全 events を処理し failed[] を返す
// ---------------------------------------------------------------------------
// future: multi-session payload 対応の拡張ポイント。 今日は handler から 1 回だけ呼ぶ。

async function processSession(
  user: User,
  session: BulkPayload['session'],
  events: ParsedEvent[],
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
    // RLS-P3: withTenantTx が接続取得 + tenant tx + 冒頭 setTenantContext を担う。
    // 内部 try/catch が rollback-on-throw を握って failed[] を組む契約を保つため、
    // tx 境界はこの関数が withTenantTx で所有する (caller に tx を渡す形にすると
    // throw を握った後に commit されてしまい partial write が残る)。
    await withTenantTx(user.id, async (tx) => {
      // ------------------------------------------------------------------
      // Phase 1 — cards SELECT (owner-scoped) → cardStateMap + option index
      // ------------------------------------------------------------------
      // repo が raw rows を返す。cardStateMap (ReplayCardState を row から組む
      // orchestrator glue) はここに残し、同 rows を domain の buildCardOptionIndex
      // に渡す (A-2 検証用の option id Set)。
      const cardRows = await loadCardReplayStates(tx, user.id, distinctCardIds)

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
      // card_id → 実在 option id の Set(A-2 検証用・fail-closed)。
      const cardOptionIdMap = buildCardOptionIndex(cardRows)

      // orphan exclusion + A-2: rejected は orphanFailed へ (現 wire failed[] と同形)。
      const { applicable: applicableEvents, rejected } = admitEvents(
        events,
        cardOptionIdMap,
      )
      orphanFailed.push(...rejected)

      // applicable events が 0 件なら write フェーズはスキップ
      if (applicableEvents.length === 0) return

      // ------------------------------------------------------------------
      // Phase 2a — answer_events bulk INSERT (ON CONFLICT DO NOTHING)
      // ------------------------------------------------------------------
      // 実際に INSERT された event_id セットを返す (duplicate は除外される)。
      const insertedEventIds = await insertAnswerEvents(
        tx,
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

      // ------------------------------------------------------------------
      // Phase 2b/2c — replay gating (dedup) + in-memory FSRS replay
      // ------------------------------------------------------------------
      // planReplay: insertedEventIds gating + intra-payload dedup + payload 順
      // per-card group。replaySession: 各 group を replayCard で fold し finalStates
      // と reviewRows を組む。groups (Map) の平坦化 = 現 eventsToApply と同 multiset
      // (study_days 集計 = 順不同の加算ゆえ dayMap 値は不変)。
      const groups = planReplay(applicableEvents, insertedEventIds)
      const eventsToApply = [...groups.values()].flat()

      if (eventsToApply.length === 0) return

      const { finalStates, reviewRows } = replaySession(cardStateMap, groups)

      // reviews 行の順序は group 順 (card_id 初出順)。 study_days は eventsToApply から
      // 別途集計するため、 reviews INSERT 順は最終結果に影響しない。

      // ------------------------------------------------------------------
      // Phase 2d — reviews bulk INSERT
      // ------------------------------------------------------------------
      await insertReviews(
        tx,
        reviewRows.map((r) => ({
          userId: user.id,
          cardId: r.cardId,
          rating: r.rating,
          reviewedAt: r.reviewedAt,
        })),
      )

      // ------------------------------------------------------------------
      // Phase 2e — cards UPDATE (single VALUES UPDATE、owner-scoped)
      // finalStates の全エントリを 1 round-trip で UPDATE。件数不一致は repo が throw。
      // finalStates.size === 0 は repo 内で no-op。
      // ------------------------------------------------------------------
      await applyCardFinalStates(tx, user.id, finalStates)

      // ------------------------------------------------------------------
      // Phase 2f — study_days UPSERT (per JST day)
      // ------------------------------------------------------------------
      // eventsToApply を JST date でグループ化して count 集計 (domain)、
      // distinct 集計 SELECT + per-day UPSERT は repo。
      const dayMap = aggregateStudyDays(eventsToApply)

      if (dayMap.size !== 0) {
        await upsertStudyDays(tx, user.id, dayMap)
      }
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

export { payloadSchema, processSession }
export type { BulkPayload, ParsedEvent }
