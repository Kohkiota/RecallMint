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

import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { getDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { type User } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import {
  classifyBulkError,
  BULK_TRANSIENT_RETRY_SEC,
} from '@/lib/retry/classify-bulk-error'
import { payloadSchema, processSession, type BulkPayload } from '@/lib/reviews/ingest-review-events'
import { upsertSessionGuarded } from '@/lib/reviews/session-repository'

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

  // -- Phase 0: study_sessions upsert (events tx の外) --
  // PK = session_id。 同 session_id への再送は status / completed_at を
  // 最新値で上書き (updated_at は $onUpdate で自動)。
  // Phase 0 失敗 → 500 (session sync 不整合を防ぐため events は処理しない)。
  let applied: boolean
  try {
    ;({ applied } = await withTenantTx(user.id, (tx) =>
      upsertSessionGuarded(tx, user, session),
    ))
  } catch (err) {
    logger.error({
      event: 'review_events.bulk.session_upsert_failed',
      sessionId: session.session_id,
      userId: user.id,
      err,
    })
    // T-A1 (audit §10.3 (b) #11): transient (DB conflict / lock timeout / connection
    // class / Drizzle wrap) なら 503 + Retry-After に倒し、 client retry controller
    // (lib/retry/transient-error.ts) の transient/permanent 分岐と整合させる。
    // unknown DB error も default = transient で 503 を返す (spec §1.1 目的 3、
    // silent lost write 回避)。 permanent-4xx (zod validation 等、 session upsert 経路
    // では実質発生しないが安全網として) は既存 500 を維持しない方が無難なので 400 に倒す。
    const cls = classifyBulkError(err)
    if (cls === 'permanent-4xx') {
      return Response.json({ error: 'invalid_payload' }, { status: 400 })
    }
    return Response.json(
      { error: 'session_upsert_failed' },
      {
        status: 503,
        headers: { 'Retry-After': String(BULK_TRANSIENT_RETRY_SEC) },
      },
    )
  }

  // F2 W (②status 遷移ガード): guarded upsert が適用されなかった事実の記録。
  // applied=false = ON CONFLICT DO UPDATE の setWhere 述語不発 (terminal 済み行への
  // 後退遷移 clamp、 または tenant 不一致)。両経路を区別せず束ねる (区別に追加 SELECT
  // が要り単文性を壊すため・spec §6.2)。error ではないので catch には入らず、
  // events 処理は通常どおり継続し wire も不変 (200 {ok, failed}) = 正当な遅延 flush 非弾き。
  if (!applied) {
    logger.warn({
      event: 'review_events.session_upsert_blocked',
      sessionId: session.session_id,
      userId: user.id,
      status: session.status,
    })
  }

  // -- Phase 1+2: events を単一 tx で処理 --
  const { failed } = await processSession(db, user, session, events)

  return Response.json({ ok: true, failed }, { status: 200 })
}
