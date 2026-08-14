// useMoveCards — Grid-3: 選択した N 枚の card を別 exam (または同 exam 内の別位置) へ
// 移動する集約 op と、その undo を 1 hook にまとめた client 機構 (spec §5.2 / §5.4)。
//
// 設計方針:
// - 採番 / 挿入 / undo の計算は pure domain (`lib/cards/domain/card-order.ts`) にしかない。
//   本 hook は「mirror を読む → domain に渡す → 楽観書込 + enqueue」の配線だけを持つ。
// - 楽観書込 + outbox enqueue は既存 `runOptimisticMutation` (1 Dexie rw tx) に委ねる
//   (use-bulk-card-tags / use-bulk-card-delete と同じ)。card_move は 1 操作 = 1 mutation
//   なので enqueue は常に 1 件 (entity_id = 操作 instance の uuid・spec §2.1)。
// - mirror の `updated_at` は触らない (inline-text-field の update_field と同じ既存流儀。
//   pull-back で server 値に収束する)。exams mirror は read-only レーンなので読むだけ。
// - undo は補償機構ではなく **逆方向の通常 move** (新しい mutation_id / entity_id)。
// - 'use client' は付けない: 既存 hook 群と同じ理由 (consumer が boundary を確立、
//   付けると Next.js TS plugin が Server Action prop を誤検出する rule 71007)。
//
// 失敗の伝え方 (呼出元 UI 契約):
// - 楽観 tx 失敗は **reject** で伝える (`throwOnError: true`)。呼出元は try/catch で
//   inline error を出す (既存 bulk と同じく tx は all-or-nothing、部分適用はない)。
// - `{ ok: false, reason }` は **mutation を発行しなかった** ことを表す。`no-cards` は
//   no-op (error ではない)、`target-exam-missing` は移動先不在で入口 UI が error を出す側。

import { useCallback, useMemo } from 'react'

import {
  planMoveAssignments,
  planUndoAssignments,
  type MovePlacement,
} from '@/lib/cards/domain/card-order'
import { getClientDb, type ClientCard } from '@/lib/client-db'
import { newId, type EnqueueEntityMutationInput } from '@/lib/sync/entity-mutations'
import { runOptimisticMutation } from '@/lib/sync/optimistic-mutation'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MoveCardsInput = {
  cardIds: string[]
  targetExamId: string
  placement: MovePlacement
}

/** undo 素材: forward の割当対象 **全部** の元 (exam_id, base_order)。 */
export type MoveOriginal = { id: string; exam_id: string; base_order: number }

/**
 * 移動を発行できなかった理由 (どちらも mutation は発行していない)。
 * - `no-cards`: 移動対象が mirror に 1 枚も無い (no-op。error ではない)
 * - `target-exam-missing`: 移動先 exam が mirror に無い → 「移動先の試験が見つかりません」
 */
export type MoveFailureReason = 'no-cards' | 'target-exam-missing'

export type MoveResult =
  | {
      ok: true
      /** 実際に移動した枚数 (mirror に不在だった要求 id は含まない)。 */
      movedCount: number
      originals: MoveOriginal[]
      sourceExamId: string
    }
  | { ok: false; reason: MoveFailureReason }

/**
 * undo を発行できなかった理由 (spec §5.4 の検証 2 種)。
 * - `source-exam-missing`: 戻し先 (元) exam が mirror に無い → 「元の試験が削除されています」
 * - `cards-missing`: 戻す card の一部が mirror に無い → 「移動したカードの一部が削除されています」
 */
export type UndoFailureReason = 'source-exam-missing' | 'cards-missing'

export type UndoResult = { ok: true } | { ok: false; reason: UndoFailureReason }

export type MoveCardsFn = (input: MoveCardsInput) => Promise<MoveResult>
export type UndoMoveFn = (result: MoveResult & { ok: true }) => Promise<UndoResult>

export type UseMoveCardsArgs = { userId: string }

export type UseMoveCards = { moveCards: MoveCardsFn; undoMove: UndoMoveFn }

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * 移動 (MoveCards) と undo を返す共有 hook。
 *
 * exam 詳細 (一括バー / 行メニュー) と試験一覧 (結合) の両方から使うため
 * `exams/_hooks/` に置く (`[id]/_hooks/` ではない)。
 */
export function useMoveCards({ userId }: UseMoveCardsArgs): UseMoveCards {
  const moveCards = useCallback<MoveCardsFn>(
    async ({ cardIds, targetExamId, placement }) => {
      const db = getClientDb()

      // 0. 移動先 exam の存在 (+ owner 一致) を mirror で確認する。stale な選択肢 /
      //    削除済み / 他 user の exam を渡されると、常駐列 query は「0 件」を返すだけで
      //    そのまま楽観書込 + enqueue に進み、server が failed を返した後も **mirror の
      //    card は存在しない exam に所属したまま = どのビューからも見えなくなる**。
      //    undoMove の source-exam 検査と同じ流儀を forward 側にも置く。
      //    (真の並走削除 = 検査後〜apply 間の TOCTOU 窓は spec §11 の受容どおり残る。)
      const targetExam = await db.exams.get(targetExamId)
      if (!targetExam || targetExam.user_id !== userId) {
        return { ok: false, reason: 'target-exam-missing' }
      }

      // 1. 移動対象を mirror から読む。要求 id のうち mirror に不在のものは除外して
      //    続行する (server 側 apply の skip-missing と同じ意味論・spec §4.2)。
      //    owner 不一致行も不在扱い: 共有ブラウザに残る他 user の行を、認証主体名義の
      //    outbox に載せない (optimistic-mutation の owner 規約)。
      //    **重複 id は先に潰す**: bulkGet は重複をそのまま返し、planner が 1 枚に複数の
      //    割当を吐く → patch が cardMovePatchSchema の一意性 refine に違反し、楽観 mirror
      //    だけ進んで server が flush で弾く恒久乖離になる (movedCount も水増しされる)。
      const requested = await db.cards.bulkGet([...new Set(cardIds)])
      const movedCards = requested.filter(
        (card): card is ClientCard => card !== undefined && card.user_id === userId,
      )

      // 存在 0 件は mutation を発行しない (no-op)。
      if (movedCards.length === 0) return { ok: false, reason: 'no-cards' }

      // 2. 元 exam の単一性 (runtime invariant)。undo は「単一 exam への逆移動 1 件」で
      //    表す前提 (spec §5.4) なので、複数 exam 混在は呼出元のバグ = 即 throw する。
      const sourceExamIds = new Set(movedCards.map((card) => card.exam_id))
      if (sourceExamIds.size > 1) {
        throw new Error(
          `useMoveCards: cards span multiple source exams (${[...sourceExamIds].join(', ')})`,
        )
      }
      const sourceExamId = movedCards[0].exam_id

      // 3. 移動先 exam の card 群 (常駐列の算出元)。mirror は user 全量を持つので
      //    現在表示中でない exam も読める。owner scope は compound index の第 1 要素で
      //    構造保証する (Y-2 T-B4 と同じ経路)。
      const targetCards = await db.cards
        .where('[user_id+exam_id]')
        .equals([userId, targetExamId])
        .toArray()

      const { assignments } = planMoveAssignments({
        movedCards,
        targetCards,
        placement,
      })

      // 4. undo 素材 = **割当対象の全 card** の元 (exam_id, base_order)。移動対象だけでは
      //    足りない: 同一 exam 内移動で常駐が再採番された場合、それも戻さないと元の
      //    順序が復元されない (spec §5.4)。
      //    id は moved / target のどちらか (同一 exam 内移動では両方) に必ず居るので、
      //    2 者を id で束ねた map から assignment id 分を取り出す。
      const byId = new Map<string, ClientCard>()
      for (const card of [...targetCards, ...movedCards]) byId.set(card.id, card)
      const assignedIds = new Set(assignments.map((a) => a.id))
      const originals: MoveOriginal[] = [...byId.values()]
        .filter((card) => assignedIds.has(card.id))
        .map((card) => ({
          id: card.id,
          exam_id: card.exam_id,
          base_order: card.base_order,
        }))

      // 5. mirror 書込 + card_move enqueue 1 件を 1 Dexie tx に閉じる。
      //    patch.exam_id は全 card 共通の移動先 (常駐の再採番割当も移動先 exam の行なので
      //    同じ exam_id で正しい・spec §2.1)。
      await runOptimisticMutation({
        userId,
        stores: [db.cards],
        mutate: async () => {
          for (const assignment of assignments) {
            await db.cards.update(assignment.id, {
              exam_id: targetExamId,
              base_order: assignment.base_order,
            })
          }
        },
        mutations: [
          buildMoveMutation(targetExamId, assignments),
        ],
        logEvent: 'card_move.tx_failed',
        logContext: { cardIds, sourceExamId, targetExamId, placement },
        throwOnError: true,
      })

      return {
        ok: true,
        movedCount: movedCards.length,
        originals,
        sourceExamId,
      }
    },
    [userId],
  )

  const undoMove = useCallback<UndoMoveFn>(
    async ({ originals, sourceExamId }) => {
      const db = getClientDb()

      // 戻す対象 = 元 exam が source だった card だけ (cross-exam 移動では移動対象のみ、
      // 同一 exam 内移動では再採番された常駐も含む)。domain 側の 1 定義に委ねる。
      const assignments = planUndoAssignments(originals, sourceExamId)

      // 検証 ①: 戻し先 exam の存在。先に見るのは、exam 削除が配下 card も消すため
      // card 側から見ると「一部欠け」に見えて理由が取り違えられるから。
      const sourceExam = await db.exams.get(sourceExamId)
      if (!sourceExam || sourceExam.user_id !== userId) {
        return { ok: false, reason: 'source-exam-missing' }
      }

      // 検証 ②: 戻す card が全て mirror に存在する (欠け = 移動後に削除された)。
      const rows = await db.cards.bulkGet(assignments.map((a) => a.id))
      if (rows.some((row) => row === undefined || row.user_id !== userId)) {
        return { ok: false, reason: 'cards-missing' }
      }

      // 逆方向の move を 1 mutation で発行する (補償機構ではない = 新しい
      // mutation_id / entity_id を持つ通常の card_move)。
      await runOptimisticMutation({
        userId,
        stores: [db.cards],
        mutate: async () => {
          for (const assignment of assignments) {
            await db.cards.update(assignment.id, {
              exam_id: sourceExamId,
              base_order: assignment.base_order,
            })
          }
        },
        mutations: [buildMoveMutation(sourceExamId, assignments)],
        logEvent: 'card_move.undo.tx_failed',
        logContext: { sourceExamId, cardCount: assignments.length },
        throwOnError: true,
      })

      return { ok: true }
    },
    [userId],
  )

  return useMemo(() => ({ moveCards, undoMove }), [moveCards, undoMove])
}

// card_move envelope 1 件。型は共有 envelope union (`EnqueueEntityMutationInput`) 由来
// なので、wire の形 (`cardMovePatchSchema`) との一致は型検査で担保される。
function buildMoveMutation(
  examId: string,
  cards: readonly { id: string; base_order: number }[],
): EnqueueEntityMutationInput {
  return {
    entity_type: 'card_move',
    op: 'move',
    // entity_id は対象 entity の PK ではなく「この移動操作 instance」の uuid (spec §2.1)。
    // coalesce key が `card_move:<instance>:move` になるため連続移動が畳まれない。
    entity_id: newId(),
    patch: { exam_id: examId, cards: [...cards] },
  }
}
