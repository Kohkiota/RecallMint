// review-events — Dexie `answer_events` outbox への write + /api/review-events/bulk
// への flush 経路 (FSRS 整合 Sprint A・spec §3 / §4)。
//
// 役割境界:
// - `recordAnswerEvent`: 回答確定ごとに Dexie に event を即追加 (debounce なし)。
// - `getPendingAnswerEvents` / `countPendingAnswerEvents`: owner-scope の pending 参照。
// - `flushPendingAnswerEvents`: 演習 event を送る唯一の flush。 owner-scope 選別 →
//   送信前検証 → 1000 件 chunk 逐次 POST → 応答処理 の 4 段。 session 単位の分割・
//   並列は存在しない (study_sessions 廃止、 session_id は event ごとの label)。
//
// 終端は synced (受理) か failed (形式不正 or server 衝突) の 2 値のみ。 時間経過による
// failed 化 (旧 24h drop) は無い — 残る pending は transient (503 / network / 429 /
// chunk 中断) だけになる (spec §3)。
//
// 全 helper はブラウザ専用 (getClientDb が server で throw する)。

import {
  getClientDb,
  type ClientAnswerEvent,
  type SyncStatus,
} from '@/lib/client-db'
import { logger } from '@/lib/logger'
import {
  answerEventWireSchema,
  type AnswerEventWire,
} from '@/lib/sync/shared/answer-event-schema'
import { newId } from './new-id'
import { modifyByKeys, createBulkApiClient, type BulkApiClient } from './outbox-ops'

// BulkApiClient 型は outbox-ops.ts に移動。既存 importer は変更不要。
export type { BulkApiClient } from './outbox-ops'

// UUID 生成 (v4) は lib/sync/new-id.ts に集約。 旧 inline 実装は同 helper を経由する
// re-export に置換 (外部 caller の `import { newId } from '@/lib/sync/review-events'`
// 互換を保つ。 例: app/(app)/app/study/_components/session-launcher.tsx)。
export { newId }

// ---------------------------------------------------------------------------
// answer_events への write / 参照
// ---------------------------------------------------------------------------

export type RecordAnswerEventInput = {
  user_id: string
  // 演習 1 回分の label。 client 採番の uuid をそのまま event に載せる (親表なし)。
  session_id: string
  card_id: string
  selected_answer_ids: string[]
  is_correct: boolean
  // FSRS rating (1=Again / 2=Hard / 3=Good / 4=Easy)。 scheduling の唯一の入力。
  rating: 1 | 2 | 3 | 4
  elapsed_ms?: number
  event_id?: string // 未指定なら newId() で採番
  answered_at?: string // 未指定なら now
}

export async function recordAnswerEvent(
  input: RecordAnswerEventInput,
): Promise<ClientAnswerEvent> {
  const row: ClientAnswerEvent = {
    event_id: input.event_id ?? newId(),
    user_id: input.user_id,
    session_id: input.session_id,
    card_id: input.card_id,
    selected_answer_ids: input.selected_answer_ids,
    is_correct: input.is_correct,
    rating: input.rating,
    answered_at: input.answered_at ?? new Date().toISOString(),
    // 計測不能時に `elapsed_ms: undefined` を持つ行を作らない (optional 列の欠落で表す)。
    ...(input.elapsed_ms !== undefined ? { elapsed_ms: input.elapsed_ms } : {}),
    sync_status: 'pending',
  }
  await getClientDb().answer_events.add(row)
  return row
}

/**
 * 自 user の pending event を record 投入順で返す。
 *
 * 戻り順 = local_id (auto-increment) 昇順 = record 順。 index 等値 query は同一 index
 * key の entry を PK 昇順で返すため、 server 側 fold が前提とする「payload の並び =
 * answered_at 昇順」 が保たれる。
 */
export async function getPendingAnswerEvents(
  userId: string,
): Promise<ClientAnswerEvent[]> {
  return getClientDb()
    .answer_events.where('[user_id+sync_status]')
    .equals([userId, 'pending'])
    .toArray()
}

export async function countPendingAnswerEvents(userId: string): Promise<number> {
  // 行本体を materialize せず index の range count で数える (Y-2 T-B4 と同方針)。
  return getClientDb()
    .answer_events.where('[user_id+sync_status]')
    .equals([userId, 'pending'])
    .count()
}

async function markAnswerEvents(
  eventIds: string[],
  syncStatus: SyncStatus,
): Promise<void> {
  await modifyByKeys(getClientDb().answer_events, 'event_id', eventIds, {
    sync_status: syncStatus,
  })
}

// ---------------------------------------------------------------------------
// bulk flush
// ---------------------------------------------------------------------------

const BULK_ENDPOINT = '/api/review-events/bulk'

// server payloadSchema の `events` 上限と同値。 超過分は chunk に割って逐次送る。
const FLUSH_CHUNK_SIZE = 1000

// event_id ごとの in-flight POST を追跡し、 同 event_id を含む並走 flush を排除する。
// module scope で保持 (IDB には保存しない)。 test isolation のため export するが、
// production コードからの直接操作は禁止 (flush の finally で必ず remove される)。
export const inFlightEventIds = new Set<string>()

export type FlushResult = {
  syncedEventIds: string[]
  failedEventIds: string[]
  // POST の HTTP status (成功=200、 失敗=応答 status、 network 断 / POST 未試行=0)。
  // orchestrator が 429 (即停止) / 5xx (transient retry) / 4xx (永続) を分類するために使う。
  httpStatus: number
}

// fetch ラッパ (test では injection で差し替え)。
const defaultClient: BulkApiClient = createBulkApiClient(BULK_ENDPOINT)

function noFlushResult(): FlushResult {
  return {
    syncedEventIds: [],
    failedEventIds: [],
    httpStatus: 0,
  }
}

// Dexie 行 → wire event。 session_id は最上位 session オブジェクトではなく **event ごとの
// label 列** として載せる (spec §4.4 — 載せ忘れると server 側で全 event が NULL になる)。
function toWireInput(row: ClientAnswerEvent): unknown {
  return {
    event_id: row.event_id,
    card_id: row.card_id,
    session_id: row.session_id,
    selected_answer_ids: row.selected_answer_ids,
    is_correct: row.is_correct,
    rating: row.rating,
    answered_at: row.answered_at,
    ...(row.elapsed_ms !== undefined ? { elapsed_ms: row.elapsed_ms } : {}),
  }
}

/**
 * 自 user の pending answer_events を bulk API に送る唯一の flush。
 *
 * 1. owner-scope 選別: `[user_id+sync_status]` で自 user の pending 全件を取る。
 *    ここで確定した集合が、以降の synced / failed 化の対象を閉じる (アカウント切替中に
 *    応答が返っても新 user の行に作用しない・spec §4.2)。
 * 2. 送信前検証: server と共有の zod schema で per-event 検証し、形式不正は送信対象から
 *    外して 'failed' に terminal 化する (chunk ごと 400 を誘発する poison-pill を断つ)。
 * 3. 1000 件 chunk 逐次 POST: chunk が失敗したら以降の chunk は送らず中断する (spec §3)。
 * 4. 応答処理: 200 の failed[] は再送で解消しない衝突なので 'failed' terminal 化、
 *    それ以外は synced 化。中断分は pending 残置 (次 trigger が先頭から送り直す)。
 */
export async function flushPendingAnswerEvents(
  userId: string,
  client: BulkApiClient = defaultClient,
): Promise<FlushResult> {
  const pending = await getPendingAnswerEvents(userId)
  const targets = pending.filter((e) => !inFlightEventIds.has(e.event_id))
  // pending 0 件、 または全件が他 flush の in-flight 中 → POST しない。
  if (targets.length === 0) return noFlushResult()

  for (const e of targets) {
    inFlightEventIds.add(e.event_id)
  }

  try {
    const wires: AnswerEventWire[] = []
    const invalidEventIds: string[] = []
    for (const row of targets) {
      const parsed = answerEventWireSchema.safeParse(toWireInput(row))
      if (parsed.success) wires.push(parsed.data)
      else invalidEventIds.push(row.event_id)
    }
    if (invalidEventIds.length > 0) {
      // 形式不正は時間でなく形式による決定的 terminal (spec §3)。 FlushResult の
      // failedEventIds には載せない — HTTP を伴わない隔離なので、 httpStatus ベースの
      // retry 分類 (classifyFlushResults) を汚さないため。 観測はこの log で行う。
      await markAnswerEvents(invalidEventIds, 'failed')
      logger.warn({
        event: 'review_events.flush.invalid_quarantined',
        count: invalidEventIds.length,
        eventIds: invalidEventIds,
      })
    }
    if (wires.length === 0) return noFlushResult()

    const syncedEventIds: string[] = []
    const failedEventIds: string[] = []
    let unsentEventIds: string[] = []
    let httpStatus = 0
    let aborted = false

    for (let i = 0; i < wires.length; i += FLUSH_CHUNK_SIZE) {
      const chunk = wires.slice(i, i + FLUSH_CHUNK_SIZE)
      const response = await client.post({ events: chunk })
      httpStatus = response.status
      if (!response.ok || !response.body || response.body.ok !== true) {
        // chunk 失敗 (4xx / 5xx / network): 以降の chunk は送らず中断する。 event は
        // 冪等ゆえ次 trigger で先頭から送り直して無害 (spec §3)。
        aborted = true
        unsentEventIds = wires.slice(i).map((w) => w.event_id)
        break
      }
      const failedSet = new Set(response.body.failed ?? [])
      for (const w of chunk) {
        // 応答の failed[] は「今 chunk で送った event_id」 と突き合わせる = 閉じた scope。
        if (failedSet.has(w.event_id)) failedEventIds.push(w.event_id)
        else syncedEventIds.push(w.event_id)
      }
    }

    await markAnswerEvents(syncedEventIds, 'synced')
    // 所有権 / 内容不一致の衝突は再送で永久に解消しないため terminal 化する
    // (pending 維持だと「残る pending は transient のみ」 が偽になる・spec §3)。
    await markAnswerEvents(failedEventIds, 'failed')

    return {
      syncedEventIds,
      // 中断時は失敗 chunk + 未送信 chunk を「今回送れなかった分」 として返す
      // (retry するか否かの分類は httpStatus 側で決まる)。
      failedEventIds: aborted ? [...failedEventIds, ...unsentEventIds] : failedEventIds,
      httpStatus,
    }
  } finally {
    // POST の成否にかかわらず解放し、 次回 invoke で再 pickup できるようにする。
    for (const e of targets) {
      inFlightEventIds.delete(e.event_id)
    }
  }
}
