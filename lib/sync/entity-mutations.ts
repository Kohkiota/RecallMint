// entity-mutations — Dexie `entity_mutations` table への write / coalesce helper。
// /api/entity-mutations/bulk への flush 経路 (S-sync-1 で旧 card-mutations を汎用化)。
//
// 役割境界:
// - `enqueueEntityMutation`: 編集 trigger で呼び出す outbox write helper。
//   (entity_type + entity_id + op + patch.field) キーで pending 行を coalesce する。
//   同 entity の同 field への連続編集は pending 1 行に畳む (最新値で上書き)。
// - `getPendingEntityMutations`: sync_status='pending' を返す (flush 対象)。
// - `markEntityMutationsSynced`: 成功 mutation_id を 'synced' に。
// - `markEntityMutationsAttempted`: flush 試行の last_attempted_at を打刻。
// - `dropStalePendingEntityMutations`: 古すぎる pending を 'failed' に隔離。
// - `flushAllPendingEntityMutations`: pending を 1 回の bulk POST で送信、
//   成功した mutation_id を 'synced' に、失敗分は pending 残置。
//   in-flight 中の mutation_id は除外し並走 flush の二重送信を防ぐ。
//
// 全 helper はブラウザ専用 (getClientDb が server で throw する)。

import { getClientDb, type ClientEntityMutation } from '@/lib/client-db'
import { newId } from './new-id'
import { type BulkApiClient, type FlushResult } from './review-events'

// UUID 生成 (v4) は lib/sync/new-id.ts に集約。 旧 inline 実装は同 helper を経由する
// re-export に置換 (外部 caller の `import { newId } from '@/lib/sync/entity-mutations'`
// 互換を保つ。 例: app/(app)/app/tags/_components/option-create-form.tsx)。
export { newId }

// ---------------------------------------------------------------------------
// enqueueEntityMutation
// ---------------------------------------------------------------------------

export type EnqueueEntityMutationInput = {
  entity_type: string
  entity_id: string
  op: string
  patch: Record<string, unknown>
  /** 未指定なら now (ISO 8601)。 */
  edited_at?: string
}

// coalesce キーの導出。
// - update_field: entity_type + entity_id + patch.field で「同 entity の同 field への
//   連続編集」を畳む。
// - create / delete (および registry が定義する他 op): entity_type + entity_id + op
//   (1 entity につき pending create / delete は 1 行)。
// patch.field が string でない場合は entity_type + entity_id + op にフォールバック (防御)。
function coalesceKey(input: EnqueueEntityMutationInput): string {
  if (
    input.op === 'update_field' &&
    typeof input.patch.field === 'string'
  ) {
    return `${input.entity_type}:${input.entity_id}:update_field:${input.patch.field}`
  }
  return `${input.entity_type}:${input.entity_id}:${input.op}`
}

/**
 * entity mutation を Dexie outbox に enqueue する。
 *
 * coalesce 戦略 (pending 行のみ対象):
 * - 同 coalesce key (entity_type + entity_id + op [+ field]) の pending 行があれば、
 *   その行の patch / edited_at / mutation_id を最新値で上書きする。
 *   sync_status は 'pending' のまま保持。
 * - 対象行がなければ新規 add。
 *
 * 'syncing'/'synced'/'failed' 行には絶対に上書きしない。
 * in-flight 中の mutation は coalesce 対象外 (flush 側 inFlightMutationIds で
 * 二重送信を防ぐ)。
 */
export async function enqueueEntityMutation(
  input: EnqueueEntityMutationInput,
): Promise<ClientEntityMutation> {
  const db = getClientDb()
  const now = input.edited_at ?? new Date().toISOString()

  // pending 行をすべて取得し、coalesce 対象を in-memory で探す。
  // entity_mutations table は shallow (1 user の outbox) のため full-scan でも実用上問題ない。
  // 'synced' / 'syncing' / 'failed' 行は絶対に上書きしない。
  const key = coalesceKey(input)
  const allPending = await db.entity_mutations
    .where('sync_status')
    .equals('pending')
    .toArray()

  const existing = allPending.find((row) => coalesceKey(row) === key)

  if (existing !== undefined && existing.local_id !== undefined) {
    // 既存 pending 行を最新 patch / edited_at / mutation_id で上書き。
    // mutation_id を再採番することで、flush 側が冪等キーとして「最新の意図」を送れる。
    const updated: Partial<ClientEntityMutation> = {
      mutation_id: newId(),
      patch: input.patch,
      edited_at: now,
    }
    await db.entity_mutations.update(existing.local_id, updated)
    return { ...existing, ...updated }
  }

  // 新規 add
  const row: ClientEntityMutation = {
    mutation_id: newId(),
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    op: input.op,
    patch: input.patch,
    edited_at: now,
    sync_status: 'pending',
  }
  const localId = await db.entity_mutations.add(row)
  return { ...row, local_id: localId as number }
}

// ---------------------------------------------------------------------------
// getPendingEntityMutations
// ---------------------------------------------------------------------------

/** sync_status==='pending' の entity mutations を返す (flush 対象)。 */
export async function getPendingEntityMutations(): Promise<ClientEntityMutation[]> {
  return getClientDb().entity_mutations
    .where('sync_status')
    .equals('pending')
    .toArray()
}

// ---------------------------------------------------------------------------
// markEntityMutationsSynced
// ---------------------------------------------------------------------------

/**
 * bulk flush 成功後に呼ぶ。対象 mutation_id 行を 'synced' に遷移させる。
 * review-events.ts の markAnswerEventsSynced と同方針。
 */
export async function markEntityMutationsSynced(
  mutationIds: string[],
): Promise<void> {
  if (mutationIds.length === 0) return
  await getClientDb()
    .entity_mutations.where('mutation_id')
    .anyOf(mutationIds)
    .modify({ sync_status: 'synced' })
}

// ---------------------------------------------------------------------------
// markEntityMutationsAttempted
// ---------------------------------------------------------------------------

/**
 * flush 試行のたびに対象 mutation の last_attempted_at を打刻する
 * (dormant 列 write 配線)。 orchestrator の backoff は in-memory で駆動するが、
 * 「最終試行からの経過」 を事実確認できるよう Dexie にも残す。
 */
export async function markEntityMutationsAttempted(
  mutationIds: string[],
  nowIso: string,
): Promise<void> {
  if (mutationIds.length === 0) return
  await getClientDb()
    .entity_mutations.where('mutation_id')
    .anyOf(mutationIds)
    .modify({ last_attempted_at: nowIso })
}

// ---------------------------------------------------------------------------
// dropStalePendingEntityMutations
// ---------------------------------------------------------------------------

/**
 * 古すぎる pending mutation を 'failed' に隔離する (silent drop)。
 * mount 時の古さ判定で呼ぶ (常駐監視はしない)。
 *
 * edited_at が `now - maxAgeMs` より**厳密に古い** pending を 'failed' に遷移させる。
 * 境界 (ちょうど maxAgeMs) は残す。
 *
 * @returns drop した mutation_id 配列 (呼出側の観測用)
 */
export async function dropStalePendingEntityMutations(
  now: number,
  maxAgeMs: number,
): Promise<string[]> {
  const cutoff = now - maxAgeMs
  const pending = await getPendingEntityMutations()
  const staleIds = pending
    .filter((m) => Date.parse(m.edited_at) < cutoff)
    .map((m) => m.mutation_id)
  if (staleIds.length > 0) {
    await getClientDb()
      .entity_mutations.where('mutation_id')
      .anyOf(staleIds)
      .modify({ sync_status: 'failed' })
  }
  return staleIds
}

// ---------------------------------------------------------------------------
// bulk flush
// ---------------------------------------------------------------------------

const ENTITY_MUTATION_BULK_ENDPOINT = '/api/entity-mutations/bulk'

// mutation_id ごとの in-flight POST を追跡し、 並走 flush による二重送信を排除する。
// module scope で保持 (IDB には保存しない)。 test isolation のため export するが、
// production コードからの直接操作は禁止 (flushAllPendingEntityMutations の finally で
// 必ず remove される)。
// 多重送信防止: mutation_id UNIQUE (server) + in-flight set + Web Locks の 3 重。
export const inFlightMutationIds = new Set<string>()

// fetch ラッパ (test では injection で差し替え)。
// review-events.ts の defaultClient と同型、 endpoint のみ差し替え。
const defaultEntityMutationClient: BulkApiClient = {
  post: async (payload) => {
    try {
      const res = await fetch(ENTITY_MUTATION_BULK_ENDPOINT, {
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

/**
 * 全 pending entity mutations を 1 回の bulk POST で送信する。
 *
 * entity-mutation には session grouping がないため全 pending を 1 batch にまとめる
 * (review の flushAllPendingEvents の「session 別並列」を「全件 1 回」に圧縮)。
 *
 * 戻り値は FlushResult[] (0 または 1 要素)。
 * FlushResult は review-events.ts で定義された型を再利用する。
 * classifyFlushResults (review-flush.ts) 再利用のため FlushResult shape に適合させており、
 * *EventIds フィールドには mutation_id を保持する (フィールド名は event 由来だが流用)。
 * sessionSynced は entity-mutation に session 概念がないため常に false 固定。
 */
export async function flushAllPendingEntityMutations(
  client: BulkApiClient = defaultEntityMutationClient,
): Promise<FlushResult[]> {
  const pendingAll = await getPendingEntityMutations()

  // 別の並走 flush が既に掴んでいる mutation_id を除外する。
  // 「元 pending > 0 かつ除外後 0 件」は全件が他 flush の in-flight 中を意味するため
  // POST を省略する (server UNIQUE + in-flight set の二重防衛)。
  const targets = pendingAll.filter((m) => !inFlightMutationIds.has(m.mutation_id))

  // pending が 0 件、 または全件が in-flight 中 → 空配列を返す
  // (classifyFlushResults が 'no-pending' に分類)。
  if (pendingAll.length === 0 || targets.length === 0) {
    return []
  }

  // targets の mutation_id を in-flight として登録し、 finally で必ず解放する。
  for (const m of targets) {
    inFlightMutationIds.add(m.mutation_id)
  }

  const targetIds = targets.map((m) => m.mutation_id)

  try {
    // 試行のたびに last_attempted_at を打刻 (dormant 列の write 配線)。
    await markEntityMutationsAttempted(targetIds, new Date().toISOString())

    const payload = {
      mutations: targets.map((m) => ({
        mutation_id: m.mutation_id,
        entity_type: m.entity_type,
        entity_id: m.entity_id,
        op: m.op,
        patch: m.patch,
        edited_at: m.edited_at,
      })),
    }

    const response = await client.post(payload)

    if (!response.ok || !response.body || response.body.ok !== true) {
      // network / 4xx / 5xx 全般: server に届いていない / 受け入れられていない可能性。
      // 何も sync 化しない (next flush で再試行)。
      // 429 受信時: classifyFlushResults が rate-limited を返す経路を維持 (CLAUDE.md §AI 5)。
      return [
        {
          attempted: targets.length,
          syncedEventIds: [],
          failedEventIds: targetIds,
          sessionSynced: false, // entity-mutation に session 概念なし (固定 false)
          reachable: response.status >= 400 && response.status < 600,
          httpStatus: response.status,
        },
      ]
    }

    const failedSet = new Set(response.body.failed ?? [])
    const syncedEventIds = targetIds.filter((id) => !failedSet.has(id))
    const failedEventIds = targetIds.filter((id) => failedSet.has(id))

    await markEntityMutationsSynced(syncedEventIds)
    // 失敗分は pending 残置 (次回 flush で再試行)。

    return [
      {
        attempted: targets.length,
        syncedEventIds,
        failedEventIds,
        sessionSynced: false, // entity-mutation に session 概念なし (固定 false)
        reachable: true,
        httpStatus: response.status,
      },
    ]
  } finally {
    // POST の成否にかかわらず解放し、 次回 invoke で再 pickup できるようにする。
    for (const m of targets) {
      inFlightMutationIds.delete(m.mutation_id)
    }
  }
}
