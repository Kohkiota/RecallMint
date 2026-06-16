// useCardTagToggle — Grid-1 T2: table レベル 1 回 instantiate する toggle hook。
//
// 設計方針:
// - live data (categories / options / allAssignedOptionIds) は引数の getCardContext
//   getter 経由で受け取る。hook 内で useLiveQuery は呼ばない (spec §9 単一 subscription 則)。
// - per-row でなく table レベルで 1 回 instantiate し、各 row には返す ToggleFn を渡す。
// - canonical 経路は CardTagsSection.handleToggle (L603-653) の完全コピー。
// - 'use client' directive を付けない: hook は boundary を持たず、 consumer の client
//   component (CardTagsSection / 後続 TagCell) が境界を確立する。 hook file 自体に
//   'use client' を付けると Next.js TS plugin が export を component と誤認識し、
//   function arg (getCardContext) を「serializable でない Server Action prop」 として
//   誤検出する (rule 71007)。

import { useCallback, useEffect, useRef } from 'react'

import {
  getClientDb,
  type ClientTagCategory,
  type ClientTagOption,
} from '@/lib/client-db'
import { buildNextTagSet } from '@/app/(app)/app/exams/[id]/_components/card-tags-section'
import { enqueueEntityMutation } from '@/lib/sync/entity-mutations'
import { runGuardedEntityMutationFlush } from '@/lib/sync/entity-mutation-flush'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UseCardTagToggleArgs = {
  userId: string
  getCardContext: (cardId: string) =>
    | {
        categories: ClientTagCategory[]
        options: ClientTagOption[]
        /** 該当 card の全カテゴリ横断 option_id 配列 */
        allAssignedOptionIds: string[]
      }
    | undefined // card が存在しない場合 (race) は undefined を返し、toggle は no-op
}

export type ToggleFn = (
  cardId: string,
  categoryId: string,
  optionId: string,
) => Promise<void>

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * table レベルで 1 回 instantiate する tag toggle hook。
 *
 * canonical 経路:
 * db.transaction('rw', db.card_tags, db.entity_mutations, ...) + buildNextTagSet
 * + enqueueEntityMutation + tx 外 runGuardedEntityMutationFlush (fire-and-forget)
 *
 * getCardContext は deps に含めない。caller が inline arrow を渡しても latest 値が参照される
 * (latest-ref pattern 採用: useEffect で ref.current を毎 render 後に更新)。
 * userId のみを deps に含める。
 */
export function useCardTagToggle({ userId, getCardContext }: UseCardTagToggleArgs): ToggleFn {
  // 各 render で latest getCardContext を ref に保持。 useCallback の deps から
  // getCardContext を外して identity 安定を保ちつつ、 toggle 実行時は ref.current で
  // latest を読む (caller が inline arrow を毎 render 新規生成しても問題なし)。
  const getCardContextRef = useRef(getCardContext)
  useEffect(() => {
    getCardContextRef.current = getCardContext
  }, [getCardContext])

  const toggle = useCallback<ToggleFn>(
    async (cardId, categoryId, optionId) => {
      // race で card が消えた / 親 props が空配列の場合の defensive no-op
      const ctx = getCardContextRef.current(cardId)
      if (!ctx) return

      const { categories, options, allAssignedOptionIds } = ctx

      const category = categories.find((c) => c.id === categoryId)
      if (!category) return

      const sameCategoryOptionIds = new Set(
        options.filter((o) => o.category_id === categoryId).map((o) => o.id),
      )

      const { next, toAdd, toRemove } = buildNextTagSet(
        category,
        allAssignedOptionIds,
        sameCategoryOptionIds,
        optionId,
      )

      const db = getClientDb()
      const nowIso = new Date().toISOString()

      // optimistic mirror 書込と outbox enqueue を同一 Dexie tx に寄せる。
      // 「UI だけ反映され送信予約が無い」状態を構造的に排除: enqueue が失敗すれば Dexie が
      // tx を自動 rollback、mirror も元に戻る。flush (ネットワーク送信) は tx 外で fire-and-
      // forget、outbox row は残るため次回 trigger で再送される。
      try {
        await db.transaction('rw', db.card_tags, db.entity_mutations, async () => {
          for (const id of toRemove) await db.card_tags.delete([cardId, id])
          for (const id of toAdd) {
            await db.card_tags.put({
              card_id: cardId,
              option_id: id,
              user_id: userId,
              created_at: nowIso,
            })
          }
          await enqueueEntityMutation({
            entity_type: 'card',
            entity_id: cardId,
            op: 'update_field',
            patch: { field: 'tag_option_ids', value: next },
          })
        })
      } catch {
        // Dexie tx auto-rollback 済 (mirror + outbox 共に未反映)。案 a 取り直し経路で
        // 次回 pull が server 値で reconcile するため、UI への明示通知は省略。
        return
      }

      // flush は tx 外で best-effort。失敗しても outbox row は残り次回 trigger で再送される。
      void runGuardedEntityMutationFlush().catch(() => {})
    },
    // getCardContextRef は安定した ref オブジェクト (最新値は useEffect で更新) のため
    // deps に含めない。 userId のみを deps に含める。
    [userId],
  )

  return toggle
}
