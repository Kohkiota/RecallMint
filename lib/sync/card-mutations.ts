// card-mutations — Dexie `card_mutations` table への write / coalesce helper。
// /api/card-mutations/bulk への flush 経路 (§14.7.2)。
//
// 役割境界:
// - `enqueueCardMutation`: inline 編集で呼び出す outbox write helper。
//   (card_id, op, patch.field) キーで pending 行を coalesce する。
//   同 card の同 field への連続編集は pending 1 行に畳む (最新値で上書き)。
// - `getPendingCardMutations`: sync_status='pending' を返す (flush 対象)。
// - `markCardMutationsSynced`: 成功 mutation_id を 'synced' に。
// - `markCardMutationsAttempted`: flush 試行の last_attempted_at を打刻。
// - `dropStalePendingCardMutations`: 古すぎる pending を 'failed' に隔離。
//
// 全 helper はブラウザ専用 (getClientDb が server で throw する)。

import { getClientDb, type ClientCardMutation } from '@/lib/client-db'

// ---------------------------------------------------------------------------
// UUID 生成 (v4)。 review-events.ts の newId() と同実装・同方針。
// ブラウザ / Node 19+ 共通の crypto.randomUUID() を利用。
// ---------------------------------------------------------------------------
export function newId(): string {
  return crypto.randomUUID()
}

// ---------------------------------------------------------------------------
// enqueueCardMutation
// ---------------------------------------------------------------------------

export type EnqueueCardMutationInput = {
  card_id: string
  op: 'update_field' | 'create' | 'delete'
  patch: Record<string, unknown>
  /** 未指定なら now (ISO 8601)。 */
  edited_at?: string
}

// coalesce キーの導出。
// - update_field: card_id + patch.field で「同 card の同 field への連続編集」を畳む。
// - create / delete: card_id + op (1 card につき pending create / delete は 1 行)。
// patch.field が string でない場合は card_id + op にフォールバック (防御)。
function coalesceKey(input: EnqueueCardMutationInput): string {
  if (
    input.op === 'update_field' &&
    typeof input.patch.field === 'string'
  ) {
    return `${input.card_id}:update_field:${input.patch.field}`
  }
  return `${input.card_id}:${input.op}`
}

/**
 * card mutation を Dexie outbox に enqueue する。
 *
 * coalesce 戦略 (pending 行のみ対象):
 * - 同 coalesce key (card_id + op [+ field]) の pending 行があれば、
 *   その行の patch / edited_at / mutation_id を最新値で上書きする。
 *   sync_status は 'pending' のまま保持。
 * - 対象行がなければ新規 add。
 *
 * NOTE: Task 2.1 では coalesce は sync_status==='pending' 行のみを対象とする。
 * in-flight 中の mutation は除外しない (Task 2.2 の inFlightMutationIds module set
 * 追加後に flush 側で二重送信を防ぐ設計)。'syncing'/'synced' 行には絶対に上書きしない。
 */
export async function enqueueCardMutation(
  input: EnqueueCardMutationInput,
): Promise<ClientCardMutation> {
  const db = getClientDb()
  const now = input.edited_at ?? new Date().toISOString()

  // pending 行をすべて取得し、coalesce 対象を in-memory で探す。
  // card_mutations table は shallow (1 user の outbox) のため full-scan でも実用上問題ない。
  // 'synced' / 'syncing' / 'failed' 行は絶対に上書きしない。
  const key = coalesceKey(input)
  const allPending = await db.card_mutations
    .where('sync_status')
    .equals('pending')
    .toArray()

  const existing = allPending.find((row) => coalesceKey(row) === key)

  if (existing !== undefined && existing.local_id !== undefined) {
    // 既存 pending 行を最新 patch / edited_at / mutation_id で上書き。
    // mutation_id を再採番することで、flush 側が冪等キーとして「最新の意図」を送れる。
    const updated: Partial<ClientCardMutation> = {
      mutation_id: newId(),
      patch: input.patch,
      edited_at: now,
    }
    await db.card_mutations.update(existing.local_id, updated)
    return { ...existing, ...updated }
  }

  // 新規 add
  const row: ClientCardMutation = {
    mutation_id: newId(),
    card_id: input.card_id,
    op: input.op,
    patch: input.patch,
    edited_at: now,
    sync_status: 'pending',
  }
  const localId = await db.card_mutations.add(row)
  return { ...row, local_id: localId as number }
}

// ---------------------------------------------------------------------------
// getPendingCardMutations
// ---------------------------------------------------------------------------

/** sync_status==='pending' の card mutations を返す (flush 対象)。 */
export async function getPendingCardMutations(): Promise<ClientCardMutation[]> {
  return getClientDb().card_mutations
    .where('sync_status')
    .equals('pending')
    .toArray()
}

// ---------------------------------------------------------------------------
// markCardMutationsSynced
// ---------------------------------------------------------------------------

/**
 * bulk flush 成功後に呼ぶ。対象 mutation_id 行を 'synced' に遷移させる。
 * review-events.ts の markAnswerEventsSynced と同方針。
 */
export async function markCardMutationsSynced(
  mutationIds: string[],
): Promise<void> {
  if (mutationIds.length === 0) return
  await getClientDb()
    .card_mutations.where('mutation_id')
    .anyOf(mutationIds)
    .modify({ sync_status: 'synced' })
}

// ---------------------------------------------------------------------------
// markCardMutationsAttempted
// ---------------------------------------------------------------------------

/**
 * flush 試行のたびに対象 mutation の last_attempted_at を打刻する
 * (dormant 列 write 配線)。 orchestrator の backoff は in-memory で駆動するが、
 * 「最終試行からの経過」 を事実確認できるよう Dexie にも残す。
 * review-events.ts の markAnswerEventsAttempted と同方針。
 */
export async function markCardMutationsAttempted(
  mutationIds: string[],
  nowIso: string,
): Promise<void> {
  if (mutationIds.length === 0) return
  await getClientDb()
    .card_mutations.where('mutation_id')
    .anyOf(mutationIds)
    .modify({ last_attempted_at: nowIso })
}

// ---------------------------------------------------------------------------
// dropStalePendingCardMutations
// ---------------------------------------------------------------------------

/**
 * 古すぎる pending mutation を 'failed' に隔離する (silent drop)。
 * mount 時の古さ判定で呼ぶ (常駐監視はしない)。
 *
 * edited_at が `now - maxAgeMs` より**厳密に古い** pending を 'failed' に遷移させる。
 * 境界 (ちょうど maxAgeMs) は残す。
 * 物理削除はせず痕跡を残す (review-events.ts の dropStalePendingAnswerEvents と同型)。
 *
 * @returns drop した mutation_id 配列 (呼出側の観測用)
 */
export async function dropStalePendingCardMutations(
  now: number,
  maxAgeMs: number,
): Promise<string[]> {
  const cutoff = now - maxAgeMs
  const pending = await getPendingCardMutations()
  const staleIds = pending
    .filter((m) => Date.parse(m.edited_at) < cutoff)
    .map((m) => m.mutation_id)
  if (staleIds.length > 0) {
    await getClientDb()
      .card_mutations.where('mutation_id')
      .anyOf(staleIds)
      .modify({ sync_status: 'failed' })
  }
  return staleIds
}
