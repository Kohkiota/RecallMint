// useBulkCardDelete — Grid-2 T5: 選択した N 枚の card を 1 Dexie rw tx で
// N 物理削除 (mirror) + N tombstone enqueue (op='delete') する bulk helper hook。
//
// 設計方針:
// - 単票 delete-card-button.tsx の経路を N 件束ねた形。 単票は
//   `db.cards.delete(cardId)` + 1 件 enqueue を runOptimisticMutation に閉じる。
//   bulk は `db.cards.bulkDelete(cardIds)` + per-card 1 件 enqueue を 1 tx に閉じる。
// - mutation shape = 単票と同一 `{ entity_type:'card', entity_id:<cardId>, op:'delete', patch:{} }`。
//   mutation_id は enqueueEntityMutation が内部採番、 coalesce key は delete の場合
//   `card:<cardId>:delete` で entity_id (cardId) が card ごとに異なるため coalesce されず、
//   N 件それぞれ distinct mutation_id の別 row になる (helper 側で mutation_id を作らない)。
// - client card_tags の cascade purge は pull 駆動 (pull.ts が card tombstone から行う)。
//   単票と同じく bulk も card_tags を触らない (stores に db.card_tags を入れない / purge しない)。
// - BulkResult は optimistic tx の all-or-nothing。 throwOnError:true で tx rollback →
//   全 cardIds を failed に。 flush は tx 外 fire-and-forget (helper 内蔵)。
// - 'use client' は付けない: 単票 use-card-tag-toggle / use-bulk-card-tags と同じ理由
//   (consumer が boundary 確立、 付けると Next.js TS plugin が誤検出する rule 71007)。

import { useCallback } from 'react'

import { getClientDb } from '@/lib/client-db'
import { type EnqueueEntityMutationInput } from '@/lib/sync/entity-mutations'
import { runOptimisticMutation } from '@/lib/sync/optimistic-mutation'

// BulkResult は T4 use-bulk-card-tags と同型。 DRY のため re-import (type のみ = 循環 import なし)。
import { type BulkResult } from './use-bulk-card-tags'

export type { BulkResult }

export type UseBulkCardDeleteArgs = { userId: string }

export type BulkDeleteFn = (cardIds: string[]) => Promise<BulkResult>

/**
 * table レベルで 1 回 instantiate する bulk delete helper hook。
 *
 * 返す BulkDeleteFn は cardIds を受け、 全 card の mirror 物理削除 (bulkDelete) +
 * per-card 1 件の tombstone enqueue を 1 Dexie rw tx (runOptimisticMutation) に集約する。
 *
 * - cardIds.length === 0: tx を張らず `{ ok: true, succeeded: [], failed: [] }` を即返す。
 * - 1 件以上: runOptimisticMutation を 1 回呼ぶ (1 tx + 1 flush)。 成功で全 cardIds を
 *   succeeded、 reject (tx rollback) で全 cardIds を failed。
 *
 * userId は logContext 用 (delete mutation 自体は userId を持たない = 単票と同じ。 client
 * mirror は user の card のみなので PK 削除で十分)。 userId のみを deps に含める。
 */
export function useBulkCardDelete({ userId }: UseBulkCardDeleteArgs): BulkDeleteFn {
  return useCallback<BulkDeleteFn>(
    async (cardIds) => {
      // 0 件: tx を開かず即成功。 enqueue / flush は発火しない。
      if (cardIds.length === 0) {
        return { ok: true, succeeded: [], failed: [] }
      }

      const db = getClientDb()

      // per-card に distinct entity_id で enqueue。 entity_id 違いで coalesce されず、
      // N 件それぞれ distinct mutation_id の別 row になる (mutation_id は enqueue 内部採番)。
      const mutations: EnqueueEntityMutationInput[] = cardIds.map((id) => ({
        entity_type: 'card',
        entity_id: id,
        op: 'delete',
        patch: {},
      }))

      try {
        await runOptimisticMutation({
          // card_tags は触らない (cascade purge は pull 駆動 = 単票と同じ)。
          stores: [db.cards],
          mutate: () => db.cards.bulkDelete(cardIds),
          mutations,
          logEvent: 'card_bulk_delete.tx_failed',
          logContext: { cardIds, userId },
          throwOnError: true,
        })
      } catch {
        // throwOnError:true で tx rollback 済 (mirror + outbox 共に未反映 = cards 全件復活)。
        // atomic = 全 card 一括 rollback のため failed は全選択 card。
        return { ok: false, succeeded: [], failed: [...cardIds] }
      }

      // tx 成功 = 全 card 物理削除 + tombstone enqueue 済。 succeeded は全選択 card。
      return { ok: true, succeeded: [...cardIds], failed: [] }
    },
    // delete mutation は userId を持たないが logContext 用に deps へ含める (安定化)。
    [userId],
  )
}
