// outbox-ops — outbox table への per-table 機械操作の共通 helper。
// entity-mutations.ts / review-events.ts が個別に持っていた同型の操作を DRY 化する。
//
// 抽出した 3 helper:
//   - modifyByKeys: table.where(keyCol).anyOf(ids).modify(patch) の共通体。
//   - dropStaleByKey: cutoff より古い pending を 'failed' に隔離し id 配列を返す。
//   - createBulkApiClient: endpoint 引数を取る BulkApiClient ファクトリ。
//
// これら 3 helper 以外の非対称部 (retry controller / backoff / pullBack hook /
// session grouping / in-flight set) には触れない。

// ---------------------------------------------------------------------------
// BulkApiClient 型 (旧 review-events.ts 定義。移動して review-events が re-export する)
// ---------------------------------------------------------------------------

export type BulkApiClient = {
  post: (payload: unknown) => Promise<{
    ok: boolean
    status: number
    body: { ok?: boolean; failed?: string[]; error?: string } | null
  }>
}

// ---------------------------------------------------------------------------
// 内部型: Dexie テーブルの最小構造
// ---------------------------------------------------------------------------

// Dexie Table に依存せず、呼び出しに必要な interface だけを宣言する。
// PromiseExtended<number> extends Promise<number> なので Dexie Table は構造的に適合する。
type MinimalTable = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where(index: string): { anyOf(keys: string[]): { modify(changes: Record<string, any>): Promise<number> } }
}

// ---------------------------------------------------------------------------
// modifyByKeys
// ---------------------------------------------------------------------------

/**
 * `table.where(keyCol).anyOf(ids).modify(patch)` の共通体。
 * ids が空なら即 return (Dexie の anyOf([]) は no-op だが明示的にガードする)。
 */
export async function modifyByKeys(
  table: MinimalTable,
  keyCol: string,
  ids: string[],
  patch: Record<string, unknown>,
): Promise<void> {
  if (ids.length === 0) return
  await table.where(keyCol).anyOf(ids).modify(patch)
}

// ---------------------------------------------------------------------------
// dropStaleByKey
// ---------------------------------------------------------------------------

/**
 * cutoff より**厳密に古い** pending 行を `sync_status='failed'` に隔離し、
 * drop した id 配列を返す。境界 (ちょうど maxAgeMs) は残す。
 *
 * @param table   対象 Dexie テーブル
 * @param keyCol  id 列名 (e.g. 'mutation_id' / 'event_id')
 * @param pending 呼び出し側が取得済みの pending 行配列
 * @param timestampOf  行から判定用 timestamp (ISO8601) を返す callback
 * @param idOf         行から id を返す callback
 * @param now      現在時刻 (ms, Date.now() / Date.parse() 等)
 * @param maxAgeMs stale 判定の最大経過時間 (ms)
 */
export async function dropStaleByKey<T>({
  table,
  keyCol,
  pending,
  timestampOf,
  idOf,
  now,
  maxAgeMs,
}: {
  table: MinimalTable
  keyCol: string
  pending: T[]
  timestampOf: (item: T) => string
  idOf: (item: T) => string
  now: number
  maxAgeMs: number
}): Promise<string[]> {
  const cutoff = now - maxAgeMs
  const staleIds = pending
    .filter((item) => Date.parse(timestampOf(item)) < cutoff)
    .map((item) => idOf(item))
  if (staleIds.length > 0) {
    await table.where(keyCol).anyOf(staleIds).modify({ sync_status: 'failed' })
  }
  return staleIds
}

// ---------------------------------------------------------------------------
// createBulkApiClient
// ---------------------------------------------------------------------------

/**
 * endpoint 引数を取る BulkApiClient ファクトリ。
 * review-events.ts の defaultClient / entity-mutations.ts の defaultEntityMutationClient
 * の共通体 (endpoint 引数化のみ)。fetch エラーは握り潰し ok:false/status:0 を返す。
 */
export function createBulkApiClient(endpoint: string): BulkApiClient {
  return {
    post: async (payload) => {
      try {
        const res = await fetch(endpoint, {
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
}
