// POST /api/review-events/bulk — 復習 event の唯一の受け口 (FSRS 整合 Sprint A・spec §2)。
//
// client (SessionRunner) が Dexie に貯めた answer_events を bulk flush する receiver。
// answer_events INSERT + card 行ロック + FSRS fold + study_days 再集計を ONE transaction
// で処理する。session オブジェクトは廃止 (study_sessions 表ごと撤去)。
//
// 冪等化: `event_id` が PK。INSERT は ON CONFLICT DO NOTHING + RETURNING で新規のみ
// fold 対象にし、非新規は所有権 + 内容一致の 2 段検証にかける。
//
// 応答:
// - 200 { ok: true, failed } — failed に無い event は保存確定 (client は synced 化)。
//   failed = event_id 衝突 (所有権 or 内容不一致) のみ。card 不在 / option 不一致は
//   applied=false で保存され failed には載らない (再送を構造的に止める)。
// - 400 — schema 不正 (client 送信前検証を突破 = client/server 不一致バグの signal)。
// - 503 + Retry-After / 400 — tx throw を classifyBulkError で分類。
//
// 認可: middleware は /app(.*) のみ protect。 /api は素通しのため、 ここで Clerk
// session 不在は 401 を返す。

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { reportRlsContextFailure } from '@/lib/db/report-rls-context-failure'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { type User } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import {
  classifyBulkError,
  BULK_TRANSIENT_RETRY_SEC,
} from '@/lib/retry/classify-bulk-error'
import { payloadSchema, processAnswerEvents } from '@/lib/reviews/ingest-review-events'

export const runtime = 'nodejs'

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
    // client に「user 行が来るまで待って再送」 を促す。
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

  // clamp の時刻源はここで 1 回だけ採取する (spec §2.3)。全 event の実効 answered_at と
  // created_at がこの 1 点から導かれるため CHECK (answered_at <= created_at) が厳密成立する。
  const receivedAt = new Date()

  try {
    const { failed } = await processAnswerEvents(user, parsed.data.events, receivedAt)
    return Response.json({ ok: true, failed }, { status: 200 })
  } catch (err) {
    // tx は rollback 済み。native DB error を可視化するため serializeDbError で plain
    // object 化する (logger の expandError は postgres-js の code/detail 等を潰すため)。
    logger.warn({
      event: 'review_events.bulk.tx_failed',
      userId: user.id,
      err: serializeDbError(err, {
        cardIds: parsed.data.events.map((e) => e.card_id),
      }),
    })
    await reportRlsContextFailure(err, { route: 'review-events/bulk', op: 'ingest' })
    // permanent-4xx (CHECK 違反・SQL shape 不良など実装/データ欠陥) は 400 に倒す —
    // 恒久バグを client に永久再送させないため。transient / unknown は 503 (silent
    // lost write 回避)。
    if (classifyBulkError(err) === 'permanent-4xx') {
      return Response.json({ error: 'invalid_payload' }, { status: 400 })
    }
    return Response.json(
      { error: 'bulk_ingest_failed' },
      {
        status: 503,
        headers: { 'Retry-After': String(BULK_TRANSIENT_RETRY_SEC) },
      },
    )
  }
}
