// useBulkCardTags — Grid-2 T4: 選択した N 枚の card に同一タグ操作 (付与 or 除去) を
// 1 Dexie rw tx + 1 flush で atomic に適用する bulk helper hook。
//
// 設計方針:
// - 単票 useCardTagToggle と同じ getter pattern: live data は引数 getCardTags 経由で受け取り、
//   hook 内で useLiveQuery は呼ばない (spec §9 単一 subscription 則)。
// - atomic 経路は lib/sync の `runOptimisticMutation` (Y-1 prod helper) を流用。 全 card の
//   mirror write + per-card 1 件の enqueue を 1 rw tx に閉じ、 途中 throw で Dexie auto-rollback。
//   → 新 tx primitive を作らず lib/sync を変更しない。
// - TS-1 混在選択セマンティクス: op に対し membership で gate (既に desired state の card は no-op)。
//   single-select カテゴリへの add は buildNextTagSet の sibling 置換が内在する (= 仕様)。
// - BulkResult は optimistic tx の成否 (all-or-nothing) を表す。 flush (ネットワーク送信) の
//   per-card 部分失敗は fire-and-forget で本 helper からは取得しない (= T6 が別途扱う retry 経路)。
// - 'use client' は付けない: 単票 use-card-tag-toggle と同じ理由 (consumer が boundary 確立、
//   付けると Next.js TS plugin が Server Action prop を誤検出する rule 71007)。

import { useCallback, useEffect, useRef } from 'react'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { type EnqueueEntityMutationInput } from '@/lib/sync/entity-mutations'
import { runOptimisticMutation } from '@/lib/sync/optimistic-mutation'
import { buildNextTagSet } from '@/lib/tags/build-next-tag-set'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkResult = { ok: boolean; succeeded: string[]; failed: string[] }

export type BulkTagOp = 'add' | 'remove'

export type UseBulkCardTagsArgs = {
  userId: string
  // 単票 getCardContext と同 shape の getter。 hook 内で useLiveQuery しない。
  getCardTags: (cardId: string) =>
    | {
        categories: ClientTagCategory[]
        options: ClientTagOption[]
        /** 該当 card の全カテゴリ横断 option_id 配列 */
        allAssignedOptionIds: string[]
      }
    | undefined
}

export type BulkTagFn = (
  cardIds: string[],
  categoryId: string,
  optionId: string,
  op: BulkTagOp,
) => Promise<BulkResult>

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * table レベルで 1 回 instantiate する bulk tag helper hook。
 *
 * 返す BulkTagFn は cardIds + categoryId + optionId + op を受け、 各 card を op + membership で
 * gate し、 実際に変更がある card だけを 1 Dexie rw tx (runOptimisticMutation) に集約して適用する。
 *
 * - op='add': card が optionId を既に保持 → no-op (skip)。 未保持のときだけ buildNextTagSet を
 *   呼ぶ (toggle が add 方向に一致。 single-select は sibling 置換が内在 = 仕様)。
 * - op='remove': card が optionId 未保持 → no-op。 保持のときだけ buildNextTagSet を呼ぶ。
 * - 変更対象 0 件: tx を張らず `{ ok: true, succeeded: cardIds, failed: [] }` を即返す。
 * - 1 件以上: runOptimisticMutation を 1 回呼ぶ (1 tx + 1 flush)。 成功で全 cardIds を succeeded
 *   (no-op card も desired state なので含む)、 reject (tx rollback) で全 cardIds を failed。
 *
 * getCardTags は deps に含めない (latest-ref pattern、 caller の inline arrow を毎 render 受けても
 * 最新値を参照)。 userId のみを deps に含める。
 */
export function useBulkCardTags({ userId, getCardTags }: UseBulkCardTagsArgs): BulkTagFn {
  const getCardTagsRef = useRef(getCardTags)
  useEffect(() => {
    getCardTagsRef.current = getCardTags
  }, [getCardTags])

  return useCallback<BulkTagFn>(
    async (cardIds, categoryId, optionId, op) => {
      // 各 card を op + membership で gate し、 実際に変更がある card の差分を集める。
      const changes: {
        cardId: string
        toAdd: string[]
        toRemove: string[]
        next: string[]
      }[] = []

      for (const cardId of cardIds) {
        const ctx = getCardTagsRef.current(cardId)
        if (!ctx) continue // race / 存在しない card は skip

        const { categories, options, allAssignedOptionIds } = ctx
        const category = categories.find((c) => c.id === categoryId)
        if (!category) continue // category 不在は skip

        const hasOption = allAssignedOptionIds.includes(optionId)
        // op に対し membership で gate: 既に desired state の card は no-op。
        if (op === 'add' && hasOption) continue
        if (op === 'remove' && !hasOption) continue

        const sameCategoryOptionIds = new Set(
          options.filter((o) => o.category_id === categoryId).map((o) => o.id),
        )

        const { next, toAdd, toRemove } = buildNextTagSet(
          category,
          allAssignedOptionIds,
          sameCategoryOptionIds,
          optionId,
        )

        // toggle が常に add/remove 方向に一致する gate を通っているため差分は必ず非空だが、
        // 防御的に空差分は除外する (tx に無意味な enqueue を積まない)。
        if (toAdd.length === 0 && toRemove.length === 0) continue

        changes.push({ cardId, toAdd, toRemove, next })
      }

      // 変更対象 0 件: 全 card が既に desired state。 tx を張らず即成功を返す。
      if (changes.length === 0) {
        return { ok: true, succeeded: [...cardIds], failed: [] }
      }

      const db = getClientDb()
      const nowIso = new Date().toISOString()

      const mutations: EnqueueEntityMutationInput[] = changes.map((c) => ({
        entity_type: 'card',
        entity_id: c.cardId,
        op: 'update_field',
        patch: { field: 'tag_option_ids', value: c.next },
      }))

      try {
        await runOptimisticMutation({
          userId,
          stores: [db.card_tags],
          mutate: async () => {
            for (const c of changes) {
              for (const id of c.toRemove) {
                await db.card_tags.delete([c.cardId, id])
              }
              for (const id of c.toAdd) {
                await db.card_tags.put({
                  card_id: c.cardId,
                  option_id: id,
                  user_id: userId,
                  created_at: nowIso,
                })
              }
            }
          },
          mutations,
          logEvent: 'card_bulk_tag.tx_failed',
          logContext: { cardIds, categoryId, optionId, op },
          throwOnError: true,
        })
      } catch {
        // throwOnError:true で tx rollback 済 (mirror + outbox 共に未反映)。
        // atomic = 全 card 一括 rollback のため failed は全選択 card。
        return { ok: false, succeeded: [], failed: [...cardIds] }
      }

      // tx 成功 = 全 card が desired state (no-op card 含む)。 succeeded は全選択 card。
      return { ok: true, succeeded: [...cardIds], failed: [] }
    },
    // getCardTagsRef は安定 ref (最新値は useEffect で更新)。 userId のみ deps。
    [userId],
  )
}
