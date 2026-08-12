import 'server-only'
// 復習 ingest の orchestrator (spec §2.2 の 9 手順)。純粋 domain (session-aggregate) と
// infra (session-repository) を単一 withTenantTx で束ねる。
//
// 受理可能な event は card 不在・option 不一致でも **すべて insert** し (applied=false)、
// 200 応答で client は synced 化する = 再送が構造的に止まる。failed[] に載るのは
// event_id 衝突 (所有権 or 内容不一致) だけ。
// tx throw は握らず透過する (route が classifyBulkError で 503 / 400 に分岐する)。

import { z } from 'zod'
import { type User } from '@/lib/db/schema'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { todayInJst } from '@/lib/jst'
import { logger } from '@/lib/logger'
import {
  answerEventWireSchema,
  type AnswerEventWire,
} from '@/lib/sync/shared/answer-event-schema'
import {
  buildCardOptionIndex,
  foldSession,
  planFold,
} from '@/lib/reviews/domain/session-aggregate'
import {
  applyCardFinalStates,
  insertAnswerEvents,
  lockCardReplayStates,
  markApplied,
  recomputeStudyDays,
  verifyEventCollisions,
  type AnswerEventInsertRow,
} from '@/lib/reviews/session-repository'
import type { ReplayCardState } from '@/lib/cards/replay-card'

// ---------------------------------------------------------------------------
// Payload validation (zod) — event schema は client 送信前検証と共有 1 定義。
// 1 回の flush で 1000 件超は実用上ないため上限を設けて巨大 payload を弾く。
// ---------------------------------------------------------------------------

const payloadSchema = z.object({
  events: z.array(answerEventWireSchema).max(1000),
})

// 端末時計異常として拾う skew の下限。通常の NTP skew を大きく超える値のみを
// 観測対象にする (それ以下はノイズ)。列は増やさず log だけ出す (spec §2.3)。
const CLOCK_SKEW_WARN_MS = 60_000

// ---------------------------------------------------------------------------
// processAnswerEvents
// ---------------------------------------------------------------------------

export async function processAnswerEvents(
  user: User,
  events: AnswerEventWire[],
  receivedAt: Date,
): Promise<{ failed: string[] }> {
  // 手順 1: payload 内 event_id 重複は先勝ち dedupe。内容不一致の重複は監査痕跡を残す。
  const deduped = new Map<string, AnswerEventWire>()
  for (const ev of events) {
    const first = deduped.get(ev.event_id)
    if (first === undefined) {
      deduped.set(ev.event_id, ev)
      continue
    }
    if (!sameWireEvent(first, ev)) {
      logger.warn({
        event: 'review_events.bulk.duplicate_event_id_mismatch',
        userId: user.id,
        eventId: ev.event_id,
      })
    }
  }

  // events が空 (or 全部 dedupe されて 0 件になることはない) なら tx に入らず即返却。
  if (deduped.size === 0) return { failed: [] }

  // 手順 2: clamp。`eff = min(answered_at, receivedAt)` で未来時計を断ち、
  // created_at と同一時刻源にして CHECK (answered_at <= created_at) を厳密成立させる。
  // 下界 clamp はしない (過去 event はオフライン蓄積の正当ケース)。
  const rows: AnswerEventInsertRow[] = []
  const rawAnsweredAt = new Map<string, Date>()
  for (const ev of deduped.values()) {
    const raw = new Date(ev.answered_at)
    const skewMs = raw.getTime() - receivedAt.getTime()
    if (skewMs > CLOCK_SKEW_WARN_MS) {
      logger.warn({
        event: 'review_events.bulk.clock_skew',
        userId: user.id,
        eventId: ev.event_id,
        skewMs,
      })
    }
    rawAnsweredAt.set(ev.event_id, raw)
    rows.push({
      eventId: ev.event_id,
      userId: user.id,
      cardId: ev.card_id,
      sessionId: ev.session_id ?? null,
      selectedAnswerIds: ev.selected_answer_ids,
      isCorrect: ev.is_correct,
      rating: ev.rating,
      answeredAt: skewMs > 0 ? receivedAt : raw,
      elapsedMs: ev.elapsed_ms ?? null,
      applied: false,
      createdAt: receivedAt,
    })
  }

  return withTenantTx(user.id, async (tx) => {
    // 手順 3: distinct card_id を ID 昇順で FOR UPDATE (同一 card の並走 flush を直列化)。
    const sortedCardIds = [...new Set(rows.map((r) => r.cardId))].sort()
    const cardRows = await lockCardReplayStates(tx, user.id, sortedCardIds)

    const cardStates = new Map<string, ReplayCardState>()
    for (const row of cardRows) {
      cardStates.set(row.id, {
        due: row.due,
        stability: row.stability,
        difficulty: row.difficulty,
        elapsedDays: row.elapsedDays,
        scheduledDays: row.scheduledDays,
        reps: row.reps,
        lapses: row.lapses,
        state: row.state,
        learningSteps: row.learningSteps,
        lastReview: row.lastReview,
        answered: row.answered,
        lastCorrect: row.lastCorrect,
        currentStreak: row.currentStreak,
      })
    }
    const optionIndex = buildCardOptionIndex(cardRows)
    const lockedCardIds = new Set(optionIndex.keys())

    // 手順 4: 全 event を applied=false で INSERT → 非新規は 2 段検証で failed[] を組む。
    const insertedEventIds = await insertAnswerEvents(tx, rows)
    const failed = await verifyEventCollisions(
      tx,
      user.id,
      rows
        .filter((r) => !insertedEventIds.has(r.eventId))
        .map((r) => ({
          eventId: r.eventId,
          cardId: r.cardId,
          sessionId: r.sessionId,
          selectedAnswerIds: r.selectedAnswerIds,
          isCorrect: r.isCorrect,
          rating: r.rating,
          rawAnsweredAt: rawAnsweredAt.get(r.eventId)!,
          elapsedMs: r.elapsedMs,
        })),
    )
    if (failed.length > 0) {
      logger.warn({
        event: 'review_events.bulk.event_id_collision',
        userId: user.id,
        eventIds: failed,
      })
    }

    // 手順 5: 新規 ∧ card ロック済み ∧ A-2 pass のみを per-card 整列して fold。
    const newRows = rows.filter((r) => insertedEventIds.has(r.eventId))
    const plan = planFold(newRows, lockedCardIds, optionIndex)
    const { finalStates, appliedEventIds } = foldSession(cardStates, plan)

    // 手順 6-7: cards UPDATE → applied 反転。
    await applyCardFinalStates(tx, user.id, finalStates)
    await markApplied(tx, user.id, [...appliedEventIds])

    // 手順 8: 今回 applied になった event が跨る JST day を絶対値で再集計。
    const appliedDays = new Set<string>()
    for (const row of newRows) {
      if (appliedEventIds.has(row.eventId)) {
        appliedDays.add(todayInJst(row.answeredAt))
      }
    }
    await recomputeStudyDays(tx, user.id, [...appliedDays])

    // applied=false の理由を構造化 log に残す (order_gate = 厳密に古い event)。
    const orderGateSkipped = newRows
      .filter(
        (r) =>
          !appliedEventIds.has(r.eventId) &&
          !plan.skipped.some((s) => s.eventId === r.eventId),
      )
      .map((r) => ({ eventId: r.eventId, cardId: r.cardId }))
    if (plan.skipped.length > 0 || orderGateSkipped.length > 0) {
      logger.warn({
        event: 'review_events.bulk.not_applied',
        userId: user.id,
        skipped: plan.skipped,
        orderGateSkipped,
      })
    }

    return { failed }
  })
}

// payload 内 duplicate の内容一致判定。answered_at は ISO 表現差を吸収するため epoch ms 比較。
function sameWireEvent(a: AnswerEventWire, b: AnswerEventWire): boolean {
  return (
    a.card_id === b.card_id &&
    a.session_id === b.session_id &&
    a.is_correct === b.is_correct &&
    a.rating === b.rating &&
    a.elapsed_ms === b.elapsed_ms &&
    new Date(a.answered_at).getTime() === new Date(b.answered_at).getTime() &&
    a.selected_answer_ids.length === b.selected_answer_ids.length &&
    a.selected_answer_ids.every((id, i) => id === b.selected_answer_ids[i])
  )
}

export { payloadSchema }
