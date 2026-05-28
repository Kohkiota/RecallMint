// POST /api/review-events/bulk — S-cache-1 (§14.8) 新設。
//
// client (SessionRunner) が Dexie に貯めた answer_events を bulk flush する receiver。
// study_sessions upsert + answer_events bulk insert + 既存 submit-review-tx 経由の
// FSRS 反映 (cards UPDATE / reviews INSERT / study_days UPSERT) を担う。
//
// 冪等化:
// - `session_id` は studySessions PK、 upsert (ON CONFLICT DO UPDATE) で
//   completed_at / status / updated_at を最新値に重ね書き。
// - `event_id` は answerEvents UNIQUE、 INSERT は ON CONFLICT DO NOTHING。
//   重複 event は ANSWER_EVENT も FSRS 適用も skip (= 安全に再送可能)。
//
// 部分失敗ポリシ:
// - 1 event の FSRS 反映失敗 (card 不在等) で他 event を巻き込まないため、 event
//   毎に独立 transaction で処理。
// - event tx 失敗時は event_id を `failed[]` に積み、 200 で返却 (client は
//   sync_status 未更新 / next flush で再試行可)。
// - study_sessions upsert 失敗は 500 (session 同期できないと flush 全体の整合が
//   崩れるため、 client に retry を促す)。
//
// FSRS rating:
// - payload の `events[].rating` (1|2|3|4 = Again/Hard/Good/Easy) を優先利用、
//   未指定なら `is_correct ? 3 (Good) : 1 (Again)` に fallback で derive する。
// - FSRS モードで user が選んだ Hard(2) / Easy(4) を payload に含めることで rating
//   情報を server に届ける経路を確保 (旧 submitReview 経路依存を解消)。
// - 通常モードは client 判定のみで rating を省略 (server fallback で 3/1 に解決) しても、
//   client が明示的に 3/1 を送っても等価。
//
// 認可: middleware は /app(.*) のみ protect。 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す。

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import {
  answerEvents,
  studySessions,
  type User,
} from '@/lib/db/schema'
import { submitReviewTx } from '@/lib/cards/submit-review-tx'
import type { RatingInt } from '@/lib/fsrs'
import { logger } from '@/lib/logger'

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

  // -- study_sessions upsert --
  // PK = session_id。 同 session_id への再送は status / completed_at / card_ids を
  // 最新値で上書き (updated_at は $onUpdate で自動)。
  try {
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
  } catch (err) {
    logger.error({
      event: 'review_events.bulk.session_upsert_failed',
      sessionId: session.session_id,
      userId: user.id,
      err,
    })
    return Response.json({ error: 'session_upsert_failed' }, { status: 500 })
  }

  // -- events 反映 (per-event tx) --
  const failed: string[] = []

  for (const ev of events) {
    try {
      await db.transaction(async (tx) => {
        // (1) answer_events INSERT、 event_id 重複は no-op。
        // returning() で実 insert 行を取り、 0 件なら duplicate と判定して
        // FSRS 適用を skip する (再送 idempotency)。
        const inserted = await tx
          .insert(answerEvents)
          .values({
            eventId: ev.event_id,
            sessionId: session.session_id,
            cardId: ev.card_id,
            userId: user.id,
            selectedAnswerIds: ev.selected_answer_ids,
            isCorrect: ev.is_correct,
            answeredAt: new Date(ev.answered_at),
            elapsedMs: ev.elapsed_ms ?? null,
          })
          .onConflictDoNothing({ target: answerEvents.eventId })
          .returning({ id: answerEvents.id })

        // 重複 event_id (= 既に処理済 / 並列再送) は FSRS 再適用しない。
        if (inserted.length === 0) return

        // (2) FSRS 反映 (cards UPDATE + reviews INSERT + study_days UPSERT)。
        // rating は payload 指定値を優先、 未指定時は is_correct から derive
        // (§route header 参照)。
        const rating: RatingInt = ev.rating ?? (ev.is_correct ? 3 : 1)
        await submitReviewTx(tx, {
          userId: user.id,
          cardId: ev.card_id,
          rating,
          now: new Date(ev.answered_at),
        })
      })
    } catch (err) {
      // 個別 event 失敗は他 event を巻き込まない。 client は failed[] を見て
      // sync_status 未更新 = 次 flush で再試行する。
      logger.warn({
        event: 'review_events.bulk.event_failed',
        eventId: ev.event_id,
        cardId: ev.card_id,
        userId: user.id,
        err,
      })
      failed.push(ev.event_id)
    }
  }

  return Response.json({ ok: true, failed }, { status: 200 })
}
