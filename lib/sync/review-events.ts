// review-events — Dexie 上の study_sessions / answer_events に対する write +
// /api/review-events/bulk への flush 経路 (S-cache-1 / §14.7.1)。
//
// 役割境界:
// - `createStudySession`: 演習開始時に Dexie に session 行を入れる。 server には
//   この時点では送らない (events 0 件で flush しても意味がないため、 まとめて
//   bulk flush 時に upsert される)。
// - `recordAnswerEvent`: 回答 click ごとに Dexie に event を即追加 (debounce なし)。
// - `getPendingAnswerEvents`: sync_status='pending' を取得して flush 対象を返す。
// - `flushPendingEvents`: pending を取り bulk API に送信、 成功した event_id を
//   `synced` 化、 失敗 event_id は pending のまま (next flush で再試行)。
// - `completeStudySession`: status='completed' + completed_at を更新。
//
// 全 helper はブラウザ専用 (getClientDb が server で throw する)。

import {
  getClientDb,
  type ClientAnswerEvent,
  type ClientStudySession,
  type SyncStatus,
} from '@/lib/client-db'

// ---------------------------------------------------------------------------
// UUID 生成 (v4)。 ブラウザ / Node 19+ 共通の crypto.randomUUID() を利用。
// 古い WebView fallback は要件未確認のため敢えて入れない (PWA 対象 iOS 16.4+ /
// Android Chrome では問題なし)。
// ---------------------------------------------------------------------------
export function newId(): string {
  return crypto.randomUUID()
}

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

// ---------------------------------------------------------------------------
// bulk flush
// ---------------------------------------------------------------------------

const BULK_ENDPOINT = '/api/review-events/bulk'

export type FlushResult = {
  attempted: number
  syncedEventIds: string[]
  failedEventIds: string[]
  sessionSynced: boolean
  // network / 4xx 5xx 失敗を区別 (true=API までは届いた、 false=fetch level fail)
  reachable: boolean
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
    }
  }
  const events = await getPendingAnswerEvents(sessionId)
  // events 0 件でも、 session の status / completed_at を server に届けるため
  // bulk API を呼ぶ価値がある (例: completed 遷移直後の flush)。

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
    events: events.map((e) => ({
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
      attempted: events.length,
      syncedEventIds: [],
      failedEventIds: events.map((e) => e.event_id),
      sessionSynced: false,
      reachable: response.status >= 400 && response.status < 600,
    }
  }

  const failedSet = new Set(response.body.failed ?? [])
  const syncedEventIds = events
    .map((e) => e.event_id)
    .filter((id) => !failedSet.has(id))
  const failedEventIds = events.map((e) => e.event_id).filter((id) => failedSet.has(id))

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
    attempted: events.length,
    syncedEventIds,
    failedEventIds,
    sessionSynced,
    reachable: true,
  }
}
