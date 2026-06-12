// review-events — Dexie 上の study_sessions / answer_events に対する write +
// /api/review-events/bulk への flush 経路 (S-cache-1 / §14.7.1)。
//
// 役割境界:
// - `createStudySession`: 演習開始時に Dexie に session 行を入れる。 server には
//   この時点では送らない (events 0 件で flush しても意味がないため、 まとめて
//   bulk flush 時に upsert される)。
// - `recordAnswerEvent`: 回答 click ごとに Dexie に event を即追加 (debounce なし)。
// - `getPendingAnswerEvents`: sync_status='pending' を取得して flush 対象を返す。
// - `getAllPendingAnswerEvents`: session 横断で全 pending を返す (group flush 用)。
// - `flushPendingEvents`: pending を取り bulk API に送信、 成功した event_id を
//   `synced` 化、 失敗 event_id は pending のまま (next flush で再試行)。
//   in-flight 中の event_id は除外し、 並走 flush の二重送信を防ぐ。
// - `flushAllPendingEvents`: 全 session の pending を session 別に並列 flush
//   (session 完了時に過去 session の未送信残骸も含めて一括送信)。
// - `completeStudySession`: status='completed' + completed_at を更新。
//
// 全 helper はブラウザ専用 (getClientDb が server で throw する)。

import {
  getClientDb,
  type ClientAnswerEvent,
  type ClientStudySession,
  type SyncStatus,
} from '@/lib/client-db'
import { newId } from './new-id'

// UUID 生成 (v4) は lib/sync/new-id.ts に集約。 旧 inline 実装は同 helper を経由する
// re-export に置換 (外部 caller の `import { newId } from '@/lib/sync/review-events'`
// 互換を保つ。 例: app/(app)/app/study/smart/_components/study-session-host.tsx)。
export { newId }

// ---------------------------------------------------------------------------
// study_sessions
// ---------------------------------------------------------------------------

export type CreateStudySessionInput = {
  session_id: string
  exam_id?: string
  mode: 'smart' | 'custom'
  card_ids: string[]
  query?: Record<string, unknown>
  started_at?: string // 指定なければ now
}

export async function createStudySession(
  input: CreateStudySessionInput,
): Promise<ClientStudySession> {
  const now = new Date().toISOString()
  const row: ClientStudySession = {
    session_id: input.session_id,
    exam_id: input.exam_id,
    mode: input.mode,
    card_ids: input.card_ids,
    query: input.query,
    started_at: input.started_at ?? now,
    completed_at: null,
    status: 'active',
    updated_at: now,
    sync_status: 'pending',
  }
  await getClientDb().study_sessions.add(row)
  return row
}

export async function completeStudySession(sessionId: string): Promise<void> {
  const now = new Date().toISOString()
  await getClientDb().study_sessions.update(sessionId, {
    status: 'completed',
    completed_at: now,
    updated_at: now,
    sync_status: 'pending',
  })
}

export async function abandonStudySession(sessionId: string): Promise<void> {
  const now = new Date().toISOString()
  await getClientDb().study_sessions.update(sessionId, {
    status: 'abandoned',
    updated_at: now,
    sync_status: 'pending',
  })
}

export async function getStudySession(
  sessionId: string,
): Promise<ClientStudySession | undefined> {
  return getClientDb().study_sessions.get(sessionId)
}

async function markStudySessionSyncStatus(
  sessionId: string,
  syncStatus: SyncStatus,
): Promise<void> {
  await getClientDb().study_sessions.update(sessionId, {
    sync_status: syncStatus,
  })
}

// ---------------------------------------------------------------------------
// answer_events
// ---------------------------------------------------------------------------

export type RecordAnswerEventInput = {
  event_id?: string // 未指定なら newId() で採番
  session_id: string
  card_id: string
  selected_answer_ids: string[]
  is_correct: boolean
  answered_at?: string // 未指定なら now
  elapsed_ms?: number
  // FSRS rating (1=Again / 2=Hard / 3=Good / 4=Easy)。 未指定なら bulk API server
  // 側で is_correct から derive される。 FSRS モードで user が選んだ rating を
  // server に届けたい場合に明示する。
  rating?: 1 | 2 | 3 | 4
}

export async function recordAnswerEvent(
  input: RecordAnswerEventInput,
): Promise<ClientAnswerEvent> {
  const row: ClientAnswerEvent = {
    event_id: input.event_id ?? newId(),
    session_id: input.session_id,
    card_id: input.card_id,
    selected_answer_ids: input.selected_answer_ids,
    is_correct: input.is_correct,
    answered_at: input.answered_at ?? new Date().toISOString(),
    elapsed_ms: input.elapsed_ms,
    rating: input.rating,
    sync_status: 'pending',
  }
  await getClientDb().answer_events.add(row)
  return row
}

export async function getPendingAnswerEvents(
  sessionId?: string,
): Promise<ClientAnswerEvent[]> {
  const collection = getClientDb()
    .answer_events.where('sync_status')
    .equals('pending')
  const rows = await collection.toArray()
  return sessionId === undefined
    ? rows
    : rows.filter((r) => r.session_id === sessionId)
}

// 全 session を横断して pending を返す named helper。 呼び出し側が「session 横断の
// 全件取得」 であることを明示するために存在する (getPendingAnswerEvents() の薄い
// 委譲)。 session 完了時の全 session group flush (flushAllPendingEvents) で利用される。
export async function getAllPendingAnswerEvents(): Promise<ClientAnswerEvent[]> {
  return getPendingAnswerEvents()
}

export async function countPendingAnswerEvents(
  sessionId?: string,
): Promise<number> {
  const rows = await getPendingAnswerEvents(sessionId)
  return rows.length
}

async function markAnswerEventsSynced(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return
  await getClientDb()
    .answer_events.where('event_id')
    .anyOf(eventIds)
    .modify({ sync_status: 'synced' })
}

// flush 試行のたびに対象 event の last_attempted_at を打刻する (dormant 列の write
// 配線)。 orchestrator の backoff は in-memory attempt counter で駆動するが、
// 「最終試行からの経過」 を後から事実確認できるよう Dexie にも残す。
async function markAnswerEventsAttempted(
  eventIds: string[],
  nowIso: string,
): Promise<void> {
  if (eventIds.length === 0) return
  await getClientDb()
    .answer_events.where('event_id')
    .anyOf(eventIds)
    .modify({ last_attempted_at: nowIso })
}

// 24h 超 pending の silent drop。 mount 時の古さ判定で呼ぶ (常駐監視はしない)。
// answered_at (= 作成時刻、 常に set される) が now - maxAgeMs より厳密に古い pending を
// sync_status='failed' に隔離し、 以降の自動 retry 対象から外す (物理削除はせず痕跡を残す)。
// 境界 (ちょうど maxAgeMs) は残す。 drop した event_id を返す (呼出側の観測用)。
export async function dropStalePendingAnswerEvents(
  now: number,
  maxAgeMs: number,
): Promise<string[]> {
  const cutoff = now - maxAgeMs
  const pending = await getPendingAnswerEvents()
  const staleIds = pending
    .filter((e) => Date.parse(e.answered_at) < cutoff)
    .map((e) => e.event_id)
  if (staleIds.length > 0) {
    await getClientDb()
      .answer_events.where('event_id')
      .anyOf(staleIds)
      .modify({ sync_status: 'failed' })
  }
  return staleIds
}

// ---------------------------------------------------------------------------
// bulk flush
// ---------------------------------------------------------------------------

const BULK_ENDPOINT = '/api/review-events/bulk'

// event_id ごとの in-flight POST を追跡し、 同 event_id を含む並走 flush を排除する。
// module scope で保持 (IDB には保存しない)。 test isolation のため export するが、
// production コードからの直接操作は禁止 (flushPendingEvents の finally で必ず remove される)。
export const inFlightEventIds = new Set<string>()

export type FlushResult = {
  attempted: number
  syncedEventIds: string[]
  failedEventIds: string[]
  sessionSynced: boolean
  // network / 4xx 5xx 失敗を区別 (true=API までは届いた、 false=fetch level fail)
  reachable: boolean
  // POST の HTTP status (成功=200、 失敗=応答 status、 network 断 / POST 未試行=0)。
  // orchestrator が 429 (即停止) / 5xx (transient retry) / 4xx (永続) を分類するために使う。
  httpStatus: number
}

export type BulkApiClient = {
  post: (payload: unknown) => Promise<{
    ok: boolean
    status: number
    body: { ok?: boolean; failed?: string[]; error?: string } | null
  }>
}

// fetch ラッパ (test では injection で差し替え)。
const defaultClient: BulkApiClient = {
  post: async (payload) => {
    try {
      const res = await fetch(BULK_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let body: { ok?: boolean; failed?: string[]; error?: string } | null = null
      try {
        body = (await res.json()) as typeof body
      } catch {
        body = null
      }
      return { ok: res.ok, status: res.status, body }
    } catch {
      return { ok: false, status: 0, body: null }
    }
  },
}

// 全 session の pending を session_id でまとめて並列 flush する。
// セッション完了時に「完了 session 本体 + 過去 session の未送信残骸」を一括 sweep するために使う。
// 個々の session flush は flushPendingEvents に委譲し、in-flight guard もそちらに任せる。
// Promise.allSettled を使うため一部 session の失敗が他の session を止めない。
export async function flushAllPendingEvents(
  client: BulkApiClient = defaultClient,
): Promise<FlushResult[]> {
  const allPending = await getAllPendingAnswerEvents()

  // session_id ごとに group 化 (pending 0 件の session はここには現れない)
  const sessionIds = [...new Set(allPending.map((e) => e.session_id))]

  const settled = await Promise.allSettled(
    sessionIds.map((sessionId) => flushPendingEvents(sessionId, client)),
  )

  // reject した session は呼び出し側に巻き込まれないよう fulfilled のみを返す
  return settled
    .filter((r): r is PromiseFulfilledResult<FlushResult> => r.status === 'fulfilled')
    .map((r) => r.value)
}

export async function flushPendingEvents(
  sessionId: string,
  client: BulkApiClient = defaultClient,
): Promise<FlushResult> {
  const session = await getStudySession(sessionId)
  if (!session) {
    return {
      attempted: 0,
      syncedEventIds: [],
      failedEventIds: [],
      sessionSynced: false,
      reachable: false,
      httpStatus: 0,
    }
  }

  const pendingAll = await getPendingAnswerEvents(sessionId)

  // 別の並走 flush が既に掴んでいる event_id を除外する。
  // 「元 pending > 0 かつ除外後 0 件」は全件が他 flush の in-flight 中を意味するため
  // POST を省略する。 pending=0 (session のみ flush) の並走は別途サーバー側 idempotency に委ねる。
  const targets = pendingAll.filter((e) => !inFlightEventIds.has(e.event_id))
  if (pendingAll.length > 0 && targets.length === 0) {
    return {
      attempted: 0,
      syncedEventIds: [],
      failedEventIds: [],
      sessionSynced: false,
      reachable: false,
      httpStatus: 0,
    }
  }

  // targets の event_id を in-flight として登録し、 finally で必ず解放する。
  for (const e of targets) {
    inFlightEventIds.add(e.event_id)
  }

  try {
    // 試行のたびに last_attempted_at を打刻 (dormant 列の write 配線)。
    await markAnswerEventsAttempted(
      targets.map((e) => e.event_id),
      new Date().toISOString(),
    )

    const payload = {
      session: {
        session_id: session.session_id,
        ...(session.exam_id ? { exam_id: session.exam_id } : {}),
        mode: session.mode,
        card_ids: session.card_ids,
        started_at: session.started_at,
        ...(session.completed_at ? { completed_at: session.completed_at } : {}),
        status: session.status,
      },
      // events 0 件でも session の status / completed_at を server に届けるため
      // bulk API を呼ぶ (例: completed 遷移直後の flush)。
      events: targets.map((e) => ({
        event_id: e.event_id,
        card_id: e.card_id,
        selected_answer_ids: e.selected_answer_ids,
        is_correct: e.is_correct,
        answered_at: e.answered_at,
        ...(e.elapsed_ms !== undefined ? { elapsed_ms: e.elapsed_ms } : {}),
        ...(e.rating !== undefined ? { rating: e.rating } : {}),
      })),
    }

    const response = await client.post(payload)
    if (!response.ok || !response.body || response.body.ok !== true) {
      // network / 4xx / 5xx 全般: server に届いていない / 受け入れられていない可能性。
      // 何も sync 化しない (next flush で再試行)。
      return {
        attempted: targets.length,
        syncedEventIds: [],
        failedEventIds: targets.map((e) => e.event_id),
        sessionSynced: false,
        reachable: response.status >= 400 && response.status < 600,
        httpStatus: response.status,
      }
    }

    const failedSet = new Set(response.body.failed ?? [])
    const syncedEventIds = targets
      .map((e) => e.event_id)
      .filter((id) => !failedSet.has(id))
    const failedEventIds = targets.map((e) => e.event_id).filter((id) => failedSet.has(id))

    await markAnswerEventsSynced(syncedEventIds)
    // session 側の sync_status は「該当 session 内全 event が synced」 になった時のみ
    // 'synced' に倒す。 部分失敗中は pending のまま (event が残っている間は再送で
    // session 側も自動的に再 upsert される)。
    let sessionSynced = false
    if (failedEventIds.length === 0) {
      await markStudySessionSyncStatus(sessionId, 'synced')
      sessionSynced = true
    }

    return {
      attempted: targets.length,
      syncedEventIds,
      failedEventIds,
      sessionSynced,
      reachable: true,
      httpStatus: response.status,
    }
  } finally {
    // POST の成否にかかわらず解放し、 次回 invoke で再 pickup できるようにする。
    for (const e of targets) {
      inFlightEventIds.delete(e.event_id)
    }
  }
}
