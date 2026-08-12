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
import type { EntityMutationEnvelope } from '@/lib/sync/shared/mutation-schemas'
import { newId } from './new-id'
import { type BulkApiClient, type FlushResult } from './review-events'
import { modifyByKeys, dropStaleByKey, createBulkApiClient } from './outbox-ops'

// UUID 生成 (v4) は lib/sync/new-id.ts に集約。 旧 inline 実装は同 helper を経由する
// re-export に置換 (外部 caller の `import { newId } from '@/lib/sync/entity-mutations'`
// 互換を保つ。 例: app/(app)/app/tags/_components/option-create-form.tsx)。
export { newId }

// ---------------------------------------------------------------------------
// enqueueEntityMutation
// ---------------------------------------------------------------------------

// T5: envelope (entity_type / op / entity_id / patch) は共有 discriminated union から
// 派生。 mutation_id は enqueueEntityMutation が `newId()` で内部採番、 edited_at は
// outbox row の coalesce 用 metadata (caller 未指定なら now)。
export type EnqueueEntityMutationInput = EntityMutationEnvelope & {
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
    // T5: ClientEntityMutation は discriminated union (entity_type / op / patch 連動)。
    // `Partial<union>` は branch を distribute しないため、 update 対象は patch /
    // edited_at / mutation_id (= branch 内 metadata 列のみ) に限る前提で
    // `Partial<ClientEntityMutation> & { patch: unknown }` 経由で widen し、
    // Dexie に渡す値の shape を保つ (runtime 挙動は input.patch を素通し)。
    const updated = {
      mutation_id: newId(),
      patch: input.patch,
      edited_at: now,
    } satisfies Pick<ClientEntityMutation, 'mutation_id' | 'edited_at'> & {
      patch: unknown
    }
    await db.entity_mutations.update(
      existing.local_id,
      updated as Partial<ClientEntityMutation>,
    )
    // T5: 戻り型は ClientEntityMutation。 existing の entity_type / op / patch branch を
    // 維持しつつ新 mutation_id / edited_at / 入力 patch を反映。 union narrow は cast で。
    return { ...existing, ...updated } as ClientEntityMutation
  }

  // 新規 add: input (envelope union) と outbox metadata を spread し、 ClientEntityMutation
  // (= envelope & metadata) を組む。 TypeScript は union spread の constituent 相関を
  // 単独で narrow できないため、 戻り値レベルで `as ClientEntityMutation` で widen。
  // 入力 input は EnqueueEntityMutationInput = envelope union のため、 spread 後の
  // entity_type / op / patch は同一 branch (input 自身の branch) で整合する。
  const row = {
    ...input,
    mutation_id: newId(),
    edited_at: now,
    sync_status: 'pending' as const,
  }
  const localId = await db.entity_mutations.add(row as ClientEntityMutation)
  return { ...row, local_id: localId as number } as ClientEntityMutation
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
  await modifyByKeys(getClientDb().entity_mutations, 'mutation_id', mutationIds, { sync_status: 'synced' })
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
  await modifyByKeys(getClientDb().entity_mutations, 'mutation_id', mutationIds, { last_attempted_at: nowIso })
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
  const pending = await getPendingEntityMutations()
  return dropStaleByKey({
    table: getClientDb().entity_mutations,
    keyCol: 'mutation_id',
    pending,
    timestampOf: (m) => m.edited_at,
    idOf: (m) => m.mutation_id,
    now,
    maxAgeMs,
  })
}

// ---------------------------------------------------------------------------
// collectBlockedImageMutationIds (画像フェーズ A Task 7: flush gate)
// ---------------------------------------------------------------------------

/**
 * pending mutation のうち、 `cards.images` update_field で参照 asset が
 * まだ 'uploading' 中のものを blocked と判定する (spec §3.2)。
 *
 * gate 条件は「'uploading' の有無」のみ (local に行が無い UUID key は block しない)。
 * pull 由来 (別 device で添付済) の key は local `media_assets` に行が無いが、
 * server 側で ready 済みが保証されているため素通しする。
 */
export function collectBlockedImageMutationIds(
  pending: ClientEntityMutation[],
  uploadingAssetIds: Set<string>,
): Set<string> {
  const blocked = new Set<string>()
  for (const m of pending) {
    if (m.entity_type !== 'card' || m.op !== 'update_field') continue
    // patch も unknown 由来 (corrupted IDB で null/undefined/primitive がありうる)。
    // patch.field を読む前に object であることを確認 — flush 全体の巻き添え reject を防ぐ。
    if (typeof m.patch !== 'object' || m.patch === null) continue
    const patch = m.patch as { field?: unknown; value?: unknown }
    if (patch.field !== 'images') continue
    if (!Array.isArray(patch.value)) continue
    const hasUploading = patch.value.some((entry: unknown) => {
      // patch.value は unknown 由来 (outbox に壊れた entry が入りうる)。 null / primitive で
      // `.key` を読むと throw し flush 全体が reject → 無関係な pending も巻き添えで止まる。
      // 非 object entry は gate 対象外 (block しない = server へ流し per-mutation 失敗処理に委ねる)。
      if (typeof entry !== 'object' || entry === null) return false
      const key = (entry as { key?: unknown }).key
      return typeof key === 'string' && uploadingAssetIds.has(key)
    })
    if (hasUploading) blocked.add(m.mutation_id)
  }
  return blocked
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
// createBulkApiClient で endpoint のみ差し替えた review-events.ts の defaultClient と同型。
const defaultEntityMutationClient: BulkApiClient = createBulkApiClient(ENTITY_MUTATION_BULK_ENDPOINT)

/**
 * 全 pending entity mutations を 1 回の bulk POST で送信する。
 *
 * entity-mutation には session grouping がないため全 pending を 1 batch にまとめる
 * (review 側 flush と同じく全 pending を 1 経路でまとめて送る形)。
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

  // 画像フェーズ A Task 7: images mutation の全 uploading key が ready になるまで
  // 送信保留 (spec §3.2 flush gate)。 finalize が media_assets の status を ready 化
  // すると、 次回 flush で該当 mutation は自然に targets へ流れる (自己修復、
  // 追加の再試行トリガー不要)。
  // user-scope 不要: asset id/key は globally-unique UUIDv4 ゆえ、 共有ブラウザに
  // 別 user の stale 'uploading' 行が残っても、 現 mutation の image key と衝突し得ず
  // 誤 block しない。 sibling read (getPendingEntityMutations 等) も status のみで query
  // する既存 convention と一致。
  const uploadingAssetIds = new Set(
    (await getClientDb().media_assets.where('status').equals('uploading').toArray()).map(
      (a) => a.id,
    ),
  )
  const blockedImageMutationIds = collectBlockedImageMutationIds(pendingAll, uploadingAssetIds)

  // 別の並走 flush が既に掴んでいる mutation_id、 および images gate で保留中の
  // mutation_id を除外する。
  // 「元 pending > 0 かつ除外後 0 件」は全件が他 flush の in-flight 中 / images gate
  // 保留中を意味するため POST を省略する (server UNIQUE + in-flight set の二重防衛)。
  const targets = pendingAll.filter(
    (m) => !inFlightMutationIds.has(m.mutation_id) && !blockedImageMutationIds.has(m.mutation_id),
  )

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
