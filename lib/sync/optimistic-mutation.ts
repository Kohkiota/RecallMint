// optimistic-mutation — 楽観 mirror 書込 + outbox enqueue を同一 Dexie rw tx に閉じる
// 共有 helper (Sync-fix-1 T1a)。
//
// Client-only: depends on `getClientDb()` (Dexie / IndexedDB) / `runGuardedEntityMutationFlush`、
// component / handler 等の client 側から import される前提。 RSC からの import は
// `getClientDb` が server で throw する設計に依存して防御 (`@/lib/sync/entity-mutations` /
// `@/lib/tags/reorder-handlers` と同 convention、 `'use client'` directive は使わず banner
// で示す)。
//
// 設計 (spec §2.1):
// - mirror 書込 (`mutate` callback) と outbox enqueue を 1 つの Dexie rw tx に同居させる。
// - enqueue が throw すれば tx callback が rethrow → Dexie auto-rollback → mirror も巻き戻る。
// - try/catch は tx 外 1 回のみ。 catch 後の既定動作は silent return + `logger.warn` 1 行
//   (案 a 取り直し: 次回 pull が server 値で reconcile する経路)。
// - `throwOnError: true` で caller に通知 (rename / color / delete 系で error UI を維持する経路)。
// - flush は tx 外で fire-and-forget (`void runGuardedEntityMutationFlush().catch(() => {})`)。
//   失敗しても outbox row は残り、 次回 trigger で再送される。
// - `runOptimisticCreate` は `userId === ''` で即 fail-fast (`console.error` + throw)、
//   placeholder 禁止 (CLAUDE.md §Clerk: 全 query は WHERE user_id = ?)。
//
// reference 実装:
// - `card-tags-section.tsx handleToggle` (multi-store rw tx + 案 a 取り直し silent catch)
// - `lib/tags/reorder-handlers.ts` (silent catch + logger.warn pattern, client-only banner)

import type { Table } from 'dexie'
import { getClientDb } from '@/lib/client-db'
import {
  enqueueEntityMutation,
  newId,
  type EnqueueEntityMutationInput,
} from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { logger } from '@/lib/logger'

// Dexie の `transaction(mode, tables[], scope)` overload に揃えるための anyTable 型。
// `Table<unknown, unknown>` は invariant でユーザー側 `Table<ClientCard, string>` と非互換、
// `Table` 単独は型引数欠落で error 化する。 plan 制約「型 strict」 を破らないため、
// caller 側で型情報を要求しない `Table<any, any>` を 1 箇所に閉じる (helper API 境界のみ)。
// rw tx で書込時は caller が `mutate` / `buildRow` / `extraMirrorWrites` に閉じた型で
// 操作するため、 helper API 境界の `any` は実際の write 側の型安全性を損なわない。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = Table<any, any>

// ---------------------------------------------------------------------------
// runOptimisticMutation — generic 楽観 mirror 書込 + outbox enqueue (multi mutation 対応)
// ---------------------------------------------------------------------------

export type OptimisticMutationOptions = {
  /** Dexie rw tx に含める store (entity_mutations は helper が自動 append)。 */
  stores: readonly AnyTable[]
  /** tx 内で実行する mirror write の塊。 */
  mutate: () => Promise<void>
  /** tx 内で順次 enqueueEntityMutation する mutation 群。 */
  mutations: readonly EnqueueEntityMutationInput[]
  /** logger.warn の event 名 (失敗時、 例 'card_inline.add.tx_failed')。 */
  logEvent: string
  /** logger.warn に含める追加 context。 */
  logContext?: Record<string, unknown>
  /** 既定 false: catch 後 silent return + logger.warn 1 行。 true: catch 後 rethrow。 */
  throwOnError?: boolean
}

/**
 * mirror 書込 (`mutate`) + outbox enqueue (mutations 全件) を 1 Dexie rw tx に閉じて実行する。
 *
 * - tx 内 enqueue throw → tx callback rethrow → Dexie auto-rollback (mirror + outbox 共に未反映)。
 * - 既定動作 (`throwOnError: false`): catch 後 silent return + `logger.warn({event, ...ctx, err})` 1 行。
 *   案 a 取り直し経路: 次回 pull が server 値で reconcile するため、 caller への明示通知は省略。
 * - `throwOnError: true`: catch 後 rethrow (caller が error UI 等を維持したい場合に使う)。
 * - flush は tx 外で fire-and-forget (`void runGuardedEntityMutationFlush().catch(() => {})`)。
 */
export async function runOptimisticMutation(
  options: OptimisticMutationOptions,
): Promise<void> {
  const {
    stores,
    mutate,
    mutations,
    logEvent,
    logContext,
    throwOnError = false,
  } = options

  const db = getClientDb()
  try {
    // Dexie の (mode, tables[], scope) overload。 stores と entity_mutations を 1 配列に
    // 平坦化して渡す。 spread + 個別引数 overload はジェネリック引数推論が n 段固定で、
    // n 件可変の helper では tuple 強制が必要になるため配列 overload に揃える。
    const txTables: AnyTable[] = [...stores, db.entity_mutations]
    await db.transaction('rw', txTables, async () => {
      await mutate()
      for (const m of mutations) {
        // tx 内 enqueue: throw すれば callback の await 経由で tx 全体 throw → rollback。
        await enqueueEntityMutation(m)
      }
    })
  } catch (err) {
    // tx auto-rollback 済 (mirror + outbox 共に未反映)。
    logger.warn({ event: logEvent, ...(logContext ?? {}), err })
    if (throwOnError) throw err
    return
  }
  // flush は tx 外で best-effort。 失敗しても outbox row は残り次回 trigger で再送される。
  void runGuardedEntityMutationFlush().catch(() => {})
}

// ---------------------------------------------------------------------------
// runOptimisticCreate — id 採番 + mirror row build + outbox create を 1 tx に閉じる
// ---------------------------------------------------------------------------

export type OptimisticCreateOptions<T> = {
  /** 空文字なら fail-fast (console.error + 早期 throw)、 placeholder 禁止。 */
  userId: string
  /** 任意: caller が事前採番した id を使う場合に指定。 未指定なら helper 内部で newId() を呼ぶ。
   *  caller が `setNewCardId(id)` 等の UI state 更新を helper await の前 (= sync) に
   *  発火させたい場合に使う (T1a smoke #4 race fix、 連続 click 時の sequential 上書き解消)。 */
  id?: string
  /** 採番した id + nowIso を受け取り mirror row を組み立てる factory。 */
  buildRow: (newId: string, nowIso: string) => T
  /** mirror put の target store。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mirrorStore: Table<T, any>
  /** create mutation の組立 (newId + nowIso 受領)、 helper が tx 内で enqueue する。 */
  buildMutation: (newId: string, nowIso: string) => EnqueueEntityMutationInput
  /** 追加で同 tx 内に閉じる mirror write (例 card_tags への put)。 任意。 */
  extraMirrorWrites?: (newId: string, nowIso: string) => Promise<void>
  /** helper が rw tx に含める追加 store (mirrorStore + entity_mutations は自動)。 */
  extraStores?: readonly AnyTable[]
  logEvent: string
  logContext?: Record<string, unknown>
  throwOnError?: boolean
}

/**
 * 新規 entity 作成のための optimistic helper。
 *
 * - userId が空文字なら即 `console.error` + `throw new Error('empty user_id')` (tx 張らない)。
 * - 内部で newId() を採番、 `buildRow` / `buildMutation` に同一 (id, nowIso) を渡す。
 * - 1 Dexie rw tx 内で `mirrorStore.add(row)` → `extraMirrorWrites?` → `enqueueEntityMutation`。
 * - tx 内 throw で Dexie auto-rollback、 catch 後の既定動作 / throwOnError 挙動は
 *   `runOptimisticMutation` と同等。
 * - 戻り値: 採番済 `{ id }`。 caller が UI state 更新に使う。
 */
export async function runOptimisticCreate<T>(
  options: OptimisticCreateOptions<T>,
): Promise<{ id: string }> {
  const {
    userId,
    id: providedId,
    buildRow,
    mirrorStore,
    buildMutation,
    extraMirrorWrites,
    extraStores,
    logEvent,
    logContext,
    throwOnError = false,
  } = options

  if (userId === '') {
    // CLAUDE.md §Clerk: 全 query は WHERE user_id = ?。 placeholder 禁止。
    // tx を張る前に fail-fast、 caller の try/catch に throw を伝播させる。
    console.error('[optimistic-create] empty user_id, aborting create')
    throw new Error('empty user_id')
  }

  // options.id 未指定なら helper 内で newId()、 指定ありなら caller 採番値を尊重する。
  // caller が `setNewCardId(id)` 等 UI state を sync で先発火させたい race fix 経路。
  const id = providedId ?? newId()
  const nowIso = new Date().toISOString()
  const db = getClientDb()

  try {
    // 配列 overload に揃える (理由は runOptimisticMutation 側 comment 参照)。
    const txTables: AnyTable[] = [
      mirrorStore as AnyTable,
      ...(extraStores ?? []),
      db.entity_mutations,
    ]
    await db.transaction('rw', txTables, async () => {
      await mirrorStore.add(buildRow(id, nowIso))
      if (extraMirrorWrites) await extraMirrorWrites(id, nowIso)
      await enqueueEntityMutation(buildMutation(id, nowIso))
    })
  } catch (err) {
    // tx auto-rollback 済。
    logger.warn({ event: logEvent, ...(logContext ?? {}), err })
    if (throwOnError) throw err
    return { id }
  }

  // flush は tx 外で best-effort。
  void runGuardedEntityMutationFlush().catch(() => {})
  return { id }
}

// ---------------------------------------------------------------------------
// runOptimisticUpdate — 単一 row mirror update + outbox enqueue を atomic に閉じる
// ---------------------------------------------------------------------------

export type OptimisticUpdateOptions<
  TKey,
  TPatch extends Record<string, unknown>,
> = {
  /** mirror store (Table<row, primaryKey>)。 */
  store: Table<unknown, TKey>
  /** mirror 更新対象 row key。 */
  rowKey: TKey
  /** before fetch (revert 用の元値、 caller が事前取得して渡す)。 */
  beforeValue: TPatch
  /** mirror に書く patch (after 値)。 */
  afterPatch: TPatch
  /** enqueueEntityMutation 引数 (1 件)。 */
  mutation: EnqueueEntityMutationInput
  /** logger event 名 (mirror revert 失敗時 + tx 失敗時)。 */
  logEvent: string
  logContext?: Record<string, unknown>
  /** noop 判定 (before === after なら早期 return、 tx も flush も発火しない)。 */
  isNoop?: (before: TPatch, after: TPatch) => boolean
  /** 既定 false: catch 後 silent return + logger.warn 1 行。 true: catch 後 rethrow。 */
  throwOnError?: boolean
  /** 既定 false: tx 成功後に `runGuardedEntityMutationFlush()` を内蔵 fire-and-forget で叩く。
   *  true: 内蔵 flush を skip (caller が独自 debounce drain を管理するケース、 e.g.
   *  inline-text-field.tsx の 500ms scheduleDrain)。 plan §全体ルール 3 = debounce drain は
   *  caller 側に保持。 */
  skipInternalFlush?: boolean
}

/**
 * 単一 row の mirror update (`store.update(rowKey, afterPatch)`) + outbox enqueue (1 件)
 * を 1 Dexie rw tx に閉じて実行する update path 専用 helper。
 *
 * - `isNoop?.(beforeValue, afterPatch)` が true なら tx も flush も張らず早期 return。
 * - tx 内 enqueue throw → tx callback rethrow → Dexie auto-rollback (mirror update +
 *   outbox enqueue 双方未反映、 mirror は beforeValue 相当に戻る)。
 * - 既定動作 (`throwOnError: false`): catch 後 silent return + `logger.warn({event, ...ctx, err})`
 *   1 行。 案 a 取り直し経路: 次回 pull が server 値で reconcile。
 * - `throwOnError: true`: catch 後 rethrow (caller が error UI 等を維持したい場合)。
 * - flush は tx 外 fire-and-forget。
 *
 * `beforeValue` は caller 責務 (mirror から事前取得、 helper 側で before snapshot を
 * 取らせない)。 helper 内では `isNoop` 比較にのみ使用する (Dexie auto-rollback で
 * mirror 値は自動復元されるため、 helper 内で明示 revert は不要)。
 */
export async function runOptimisticUpdate<
  TKey,
  TPatch extends Record<string, unknown>,
>(options: OptimisticUpdateOptions<TKey, TPatch>): Promise<void> {
  const {
    store,
    rowKey,
    beforeValue,
    afterPatch,
    mutation,
    logEvent,
    logContext,
    isNoop,
    throwOnError = false,
    skipInternalFlush = false,
  } = options

  // isNoop 早期 return: tx も flush も張らない (no-op 編集の outbox 行を避ける)。
  if (isNoop?.(beforeValue, afterPatch)) return

  const db = getClientDb()
  try {
    // 配列 overload に揃える (理由は runOptimisticMutation 側 comment 参照)。
    const txTables: AnyTable[] = [store as AnyTable, db.entity_mutations]
    await db.transaction('rw', txTables, async () => {
      // mirror update → enqueue 順。 enqueue throw で tx callback rethrow → Dexie
      // auto-rollback (mirror update も巻き戻る = revert 自動成立)。
      await store.update(rowKey, afterPatch as Partial<unknown>)
      await enqueueEntityMutation(mutation)
    })
  } catch (err) {
    // tx auto-rollback 済 (mirror update + outbox enqueue 共に未反映、 mirror は
    // beforeValue 相当に自動復元)。
    logger.warn({ event: logEvent, ...(logContext ?? {}), err })
    if (throwOnError) throw err
    return
  }
  // flush は tx 外で best-effort。 失敗しても outbox row は残り次回 trigger で再送される。
  // `skipInternalFlush=true` の場合は caller の debounce drain (e.g. scheduleDrain) に委任。
  if (!skipInternalFlush) {
    void runGuardedEntityMutationFlush().catch(() => {})
  }
}
