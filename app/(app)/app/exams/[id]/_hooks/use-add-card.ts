// useAddCard — 試験詳細ページの card 一覧末尾「＋ カードを追加」の作成ロジックを
// hook として抽出 (Row-UX sprint Task 3)。カードビュー (inline-card-list.tsx) の
// handleAddCard を verbatim 移送し、後続 Task 5 のテーブルビュー footer 行が同じ
// hook を消費する (2 箇所の手書き再現は非自明な実行順の契約を壊しやすいため避ける)。
//
// 非自明な実行順の契約 (OT 明示指示・変更禁止):
// 1. newId() で card id を同期採番 (Sprint I W5: card id が最初の採番であること。
//    buildEmptyCard 内で option uid も newId() で mint されるため、card id を先に
//    取る必要がある)。
// 2. buildEmptyCard(baseOrders, count) (option uid mint は card id より後)。
// 3. opts.onIdMinted?.(id) を最初の await より前に同期発火 (呼出側が auto-edit
//    marker 等の UI state を同期的に更新するための経路)。
// 4. runOptimisticCreate({...}) (ここが最初の await)。失敗は rethrow (表示は呼出側)。
//
// 'use client' は付けない: 他 _hooks 配下 (use-bulk-card-delete 等) と同じ理由
// (consumer 側が 'use client' boundary を確立、 付けると Next.js TS plugin が
// 誤検出する rule 71007)。

import { useCallback } from 'react'

import { getClientDb } from '@/lib/client-db'
import { buildEmptyCard } from '@/lib/cards/empty-card'
import { buildNewClientCard } from '@/lib/cards/build-new-client-card'
import { buildNewCardMutationPatch } from '@/lib/cards/card-write'
import { runOptimisticCreate } from '@/lib/sync/optimistic-mutation'
import { newId } from '@/lib/sync/entity-mutations'

export type UseAddCardArgs = { userId: string; examId: string }

export type AddCardOptions = {
  /**
   * `buildEmptyCard` 完了直後・`runOptimisticCreate` の最初の await より前に同期発火する
   * (auto-edit marker 等、呼出側の同期 UI state 更新用)。
   *
   * **callback 契約**: `onIdMinted` が throw した場合、その例外は同期的に `addCard` の
   * 呼出元へ伝播し、`addCard` は **enqueue 前に** reject する (`runOptimisticCreate` は
   * 呼ばれず mirror insert / outbox enqueue は発生しない)。callback の例外を握り潰さない。
   */
  onIdMinted?: (id: string) => void
}

export type AddCardFn = (
  baseOrders: number[],
  count: number,
  opts?: AddCardOptions,
) => Promise<string>

/**
 * カード追加 (mirror insert + outbox enqueue、`runOptimisticCreate` 経由で 1 Dexie rw tx
 * に閉じる) の helper hook。
 *
 * `baseOrders` / `count` は **対象 exam の全 card** の base_order / 件数を渡すこと
 * (`lib/cards/empty-card.ts:22-23` — `buildEmptyCard` の呼出契約。表示中のフィルタ後や
 * ページング後の**部分集合を渡してはならない** — 末尾でない位置に採番されるため)。
 *
 * 返り値: mirror insert tx 成立後に resolve する新 card id。失敗
 * (`runOptimisticCreate` の enqueue throw / userId='' fail-fast) は rethrow する
 * (表示は呼出側の責務)。
 */
export function useAddCard({ userId, examId }: UseAddCardArgs): { addCard: AddCardFn } {
  const addCard = useCallback<AddCardFn>(
    async (baseOrders, count, opts) => {
      // Sprint I W5: card id を buildEmptyCard (option uid を newId で mint) より先に
      // 採番する (card id が最初の採番であることを保つ)。
      const cardId = newId()
      const empty = buildEmptyCard(baseOrders, count)
      // 最初の await (runOptimisticCreate) より前に同期発火。throw すれば同期伝播し、
      // 以降の tx (mirror insert / outbox enqueue) には進まない (callback 契約、上記 JSDoc)。
      opts?.onIdMinted?.(cardId)

      const result = await runOptimisticCreate({
        userId,
        id: cardId,
        mirrorStore: getClientDb().cards,
        buildRow: (newCardId, now) =>
          buildNewClientCard({ cardId: newCardId, userId, examId, empty, now }),
        // outbox enqueue: snake_case create patch + camelCase options への写像は
        // lib/cards/card-write.ts (buildNewCardMutationPatch) に移送済 (P3 W3)。
        // server は options の is_correct から correct_answer_ids を再生成するため含めない。
        buildMutation: (newCardId) => ({
          entity_type: 'card',
          entity_id: newCardId,
          op: 'create',
          patch: buildNewCardMutationPatch({ examId, empty }),
        }),
        logEvent: 'card_inline.add.tx_failed',
        logContext: { examId, cardId },
        // user-initiated create は failure を UI で通知する (= delete-card-button と同
        // pattern)。helper 既定 silent のままだと「追加ボタンを押したが何も起きない」
        // 経験になる。throwOnError: true で enqueue throw + userId='' fail-fast の双方を
        // caller の catch に流す (元 handleAddCard の contract を verbatim 移送)。
        throwOnError: true,
      })
      return result.id
    },
    [userId, examId],
  )

  return { addCard }
}
