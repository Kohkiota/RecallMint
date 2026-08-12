// reorder-handlers: sort_key D&D 並べ替え反映の純粋 helper。
// popover (card-tags-section.tsx) / manager (category-list.tsx / option-list.tsx) の
// 両経路から同 1 関数を呼ぶ共有 module (Tag-4c-2c T1 で抽出、 byte-equivalent 移転)。
//
// Client-only: depends on `getClientDb()` (Dexie / IndexedDB)、 manager / popover の
// client component から import される前提。 RSC からの import は `getClientDb` が
// server で throw する設計に依存して防御 (`@/lib/sync/entity-mutations` 等の既存
// client-only helper と同 convention、 `'use client'` directive は使わず banner で示す)。

import { logger } from '@/lib/logger'
import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'
import { reindexSortKeys } from '@/lib/tags/reindex-sort-keys'

// ---------------------------------------------------------------------------
// Tag-4c-2b T6: D&D reorder handlers の core ロジック (atomic + defensive filter + flush)。
// Tag-4c-2c T1 で section.tsx から抽出、 popover / manager 両経路の共有 module 化。
//
// reference 実装 = `handleToggle` の same-tx atomic pattern (mirror update + enqueue を
// 同一 Dexie rw tx に閉じ、 enqueue throw で tx 全体 throw → Dexie auto-rollback →
// handler catch で silent return、 案 a 取り直し: 次回 pull が server 値で reconcile)。
// updates.length === 0 (= 同順 drag or 既に正規化済) なら tx 自体張らず flush もしない。
// mirror update は partial `{ sort_key, updated_at }` のみ (他列触らない)、 user_id 注入は
// 不要 (sort_key 書込は user 列を触らない、 reference handleToggle の whole-set replace と
// は異なる)。
//
// component 側では useCallback で props (categories / options) を bind した closure に
// 安定化し、 tagEditCallbacks に乗せて popover に渡す。
// ---------------------------------------------------------------------------

/**
 * categories の D&D 並べ替えを反映する。
 * - 当該 list 全件の sort_key を `'0','1',…,'N-1'` で正規化 (`reindexSortKeys` 純関数)。
 * - 差分が 0 件なら tx も flush も発火しない (no-op)。
 * - 失敗時 Dexie auto-rollback、 catch silent return (案 a 取り直し)。
 *
 * userId は**認証主体**(呼出元 component が server 解決済みの値を保持している)で、
 * outbox 行の owner と flush の owner-scope 選別の**両方**に使う。 行の `user_id` は載せない。
 *
 * tag mirror は owner-scope で読まれず sign-out purge も無いため、 共有ブラウザでは前 user の
 * 行が list に混ざりうる。 その行を含む reorder は認証主体名義で送られ、 server の
 * `WHERE id = ? AND user_id = ?`(`apply-tag-mutation.ts`)に弾かれて `'failed'` になり、
 * 該当行だけが 30 日 quarantine(`dropStalePendingEntityMutations`)まで pending 再送される。
 * **この retry noise は意図的な選択**である — 行 owner に帰属させれば送信は成功するが、
 * それは owner の session 経由で A の並び順を B の account に書き込むこと(認可境界の迂回)を
 * 意味する。 データを変えない再送の方を選ぶ(optimistic-mutation.ts 冒頭の owner comment 参照)。
 */
export async function handleReorderCategories(
  userId: string,
  existingCategories: ClientTagCategory[],
  orderedIds: string[],
): Promise<void> {
  const currentMap = new Map(existingCategories.map((c) => [c.id, c.sort_key]))
  // Tag-4c-2b T7 M-A: 未登録 id (別経路から混入 / stale id 等) を捨て、 currentMap の
  // 母数 (= categories 全 id 集合) のみを reindex 対象に限定する defensive filter。
  // Tag-4c-2c で manager 側に D&D を載せた際にも自動的に守られる契約。
  const filteredOrderedIds = orderedIds.filter((id) => currentMap.has(id))
  const updates = reindexSortKeys(filteredOrderedIds, currentMap)
  if (updates.length === 0) return
  const db = getClientDb()
  const nowIso = new Date().toISOString()
  try {
    await db.transaction('rw', db.tag_categories, db.entity_mutations, async () => {
      for (const { id, sort_key } of updates) {
        await db.tag_categories.update(id, { sort_key, updated_at: nowIso })
        await enqueueEntityMutation({
          user_id: userId,
          entity_type: 'tag_category',
          entity_id: id,
          op: 'update_field',
          patch: { field: 'sort_key', value: sort_key },
        })
      }
    })
  } catch (err) {
    // Dexie tx auto-rollback 済 (mirror + outbox 共に未反映)。 案 a 取り直し経路で
    // 次回 pull が server 値で reconcile するため、 UI への明示通知は省略。
    // Tag-4c-2b T7 M-B: silent catch に logger.warn を 1 行追加 (本 reorder handler 限定、
    // 他 silent catch には遡及しない = scope creep 回避)。
    logger.warn({
      event: 'tag_category_reorder.tx_failed',
      count: updates.length,
      err,
    })
    return
  }
  // flush は tx 外で best-effort。 失敗しても outbox row は残り次回 trigger で再送される。
  void runGuardedEntityMutationFlush(userId).catch(() => {})
}

/**
 * 指定 category 配下 options の D&D 並べ替えを反映する。
 * categoryId 配下の option のみを reindex 母数とする (別 category の option を
 * 巻き込まない不変条件)。 他は handleReorderCategories と同形。
 */
export async function handleReorderOptions(
  userId: string,
  existingOptions: ClientTagOption[],
  categoryId: string,
  orderedIds: string[],
): Promise<void> {
  const currentMap = new Map(
    existingOptions
      .filter((o) => o.category_id === categoryId)
      .map((o) => [o.id, o.sort_key]),
  )
  // Tag-4c-2b T7 M-A: 別 category の option id や stale id が orderedIds に混入しても
  // currentMap (= 当該 categoryId 配下の option 全 id 集合) のみを reindex 対象に限定し、
  // 別 category の sort_key 帯を破壊しない不変条件を強化する。 Tag-4c-2c で manager
  // 側に D&D を載せた際にも自動的に守られる契約。
  const filteredOrderedIds = orderedIds.filter((id) => currentMap.has(id))
  const updates = reindexSortKeys(filteredOrderedIds, currentMap)
  if (updates.length === 0) return
  const db = getClientDb()
  const nowIso = new Date().toISOString()
  try {
    await db.transaction('rw', db.tag_options, db.entity_mutations, async () => {
      for (const { id, sort_key } of updates) {
        await db.tag_options.update(id, { sort_key, updated_at: nowIso })
        await enqueueEntityMutation({
          user_id: userId,
          entity_type: 'tag_option',
          entity_id: id,
          op: 'update_field',
          patch: { field: 'sort_key', value: sort_key },
        })
      }
    })
  } catch (err) {
    // Tag-4c-2b T7 M-B: silent catch に logger.warn を 1 行追加 (categories 側と同形)。
    logger.warn({
      event: 'tag_option_reorder.tx_failed',
      count: updates.length,
      err,
    })
    return
  }
  void runGuardedEntityMutationFlush(userId).catch(() => {})
}
