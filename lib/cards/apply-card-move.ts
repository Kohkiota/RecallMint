// apply-card-move — card_move.move op の apply (Grid-3 spec §4.1)。
//
// 「複数 card を 1 mutation で別 exam へ移動する」集約 op。 挿入位置の解決と
// base_order の採番は client 側 (lib/cards/domain/card-order.ts) が済ませており、
// server は patch が運ぶ**絶対値割当をそのまま適用するだけ** (spec §2.2)。
// per-mutation tx (bulk route の withTenantTx) 内で呼ばれ、 patch 内の全 UPDATE は
// その 1 tx で commit / rollback される。
//
// 不変条件 (kickoff 決定 8): SET 句は exam_id / base_order / updated_at の 3 列のみ。
// FSRS 列・answered / current_streak・card_tags・answer_events・images・本文・
// source_document_id・content_version には一切触れない。 content_version を bump しない
// のは cards の全書込経路と同じ (伝播は updated_at bump が担う = pull cursor の基点)。
// なお exams 側は Dash-1 T9 追い込みで `update-daily-new-target` だけが bump する
// (spec §8.1 の要求)。 cards の規律とは別軸。

import 'server-only'

import { and, eq, inArray, sql } from 'drizzle-orm'

import type { DbExecutor } from '@/lib/cards/apply-card-mutation'
import { cards, exams } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import type { ApplyResult } from '@/lib/sync/server/entity-mutation-registry'
import type { CardMovePatch } from '@/lib/sync/shared/mutation-schemas'

/**
 * 移動先 exam の検証 → 対象 card の突合 → 割当の一括 UPDATE。
 *
 * - 移動先 exam が不在 / 他 user → `'failed'` (card.create の examNotFound と同一の
 *   帰結: client は pending 残置 → 再送)。 全割当が無意味化するため skip で表現できない。
 * - patch 内の**不在 card (削除済 / 他 tenant) は skip** して残りを適用する (spec §4.2)。
 *   全体 fail にすると再送ループ → 30 日 stale 隔離という回復経路のない lost write に
 *   至るため。 全件不在でも空適用の `'applied'` (削除済カードへの割当は vacuous に充足)。
 */
export async function applyCardMove(
  tx: DbExecutor,
  userId: string,
  entityId: string,
  patch: CardMovePatch,
): Promise<ApplyResult> {
  // 1. 移動先 exam の存在 + owner 検証
  const examRows = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, patch.exam_id), eq(exams.userId, userId)))
  if (examRows.length === 0) {
    return 'failed'
  }

  // 2. 対象 card の owner-scoped 突合 (不在 id は下で skip)
  const existing = await tx
    .select({ id: cards.id })
    .from(cards)
    .where(
      and(
        eq(cards.userId, userId),
        inArray(
          cards.id,
          patch.cards.map((c) => c.id),
        ),
      ),
    )
  const existingIds = new Set(existing.map((r) => r.id))
  const present = patch.cards.filter((c) => existingIds.has(c.id))

  // 3. 存在する割当を **1 statement** で UPDATE する。 契約上限 10,000 件を
  //    per-card loop で回すと同数の往復で tx が長時間化するため、 VALUES join
  //    (UPDATE ... FROM (VALUES ...)) に畳む。 値は全て bind parameter で渡す
  //    (文字列連結しない)。 card id は patch zod で重複を拒否済のため、 各 card 行に
  //    対応する v 行はちょうど 1 つ。
  if (present.length > 0) {
    const assignments = sql.join(
      present.map((c) => sql`(${c.id}::uuid, ${c.base_order}::int)`),
      sql`, `,
    )
    await tx
      .update(cards)
      .set({
        examId: patch.exam_id,
        baseOrder: sql`v.base_order`,
        updatedAt: sql`now()`,
      })
      .from(sql`(VALUES ${assignments}) AS v(id, base_order)`)
      .where(and(eq(cards.userId, userId), eq(cards.id, sql`v.id`)))
  }

  // 4. skip は per-mutation の成否に出ない (全件不在でも 'applied') ため、 適用実績を
  //    1 行の構造化 log に残す。 metric 基盤は作らない。
  //    skip 有りだけ warn: 移動要求に含まれた card が実在しなかった = 並走削除の正常系
  //    かもしれないが異常 (client mirror の乖離 / id 取り違え) の可能性もあり、 prod 既定
  //    LOG_LEVEL=warn では info が落ちるため、 見えないと診断できない。
  const skipped = patch.cards.length - present.length
  const applied = {
    event: 'card_move.applied',
    moveId: entityId,
    userId,
    examId: patch.exam_id,
    requested: patch.cards.length,
    applied: present.length,
    skipped,
  }
  if (skipped > 0) {
    logger.warn(applied)
  } else {
    logger.info(applied)
  }

  return 'applied'
}
