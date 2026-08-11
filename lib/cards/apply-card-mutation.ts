// apply-card-mutation.ts — card 書込ドメイン core の純関数群。
//
// 各関数は Drizzle の DB / PgTransaction 互換 executor (tx) を受け取り、
// その executor 上で DB statement を実行して最小限の結果を返す。
// ActionResult 変換 / revalidatePath / logger / try/catch といった
// HTTP/Next.js 関心事は一切持たない。
//
// 呼び出し元 (server action wrapper / bulk API) が executor を用意して渡す。
// 旧 server action は db.transaction の tx (create/delete) または db 直 (update_field)
// を、bulk receiver (/api/entity-mutations/bulk) は mutation ごとに張る per-mutation tx を
// 渡す (bulk は 1 tx に複数 op を束ねず、mutation 間独立の per-mutation tx 構成)。
// bulk receiver は registry (lib/sync/server/entity-mutation-registry.ts) 経由で
// 本ファイルの applyCardX 群を card entry として呼ぶ。
//
// 制約: logic 不変。列・正規化・correct_answer_ids 再生成・
// card_count 増減・tombstone onConflictDoNothing を一字一句保つ。

import { and, eq, sql } from 'drizzle-orm'
import { cards, exams, tombstones, type CardOption } from '@/lib/db/schema'
import type { DB } from '@/lib/db'
import { deriveCorrectAnswerIds } from '@/lib/cards/domain/card-rules'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import { bumpExamCardCount } from '@/lib/cards/card-count'

// ---------------------------------------------------------------------------
// DbExecutor 型: db (PostgresJsDatabase) と tx (PgTransaction) の共通 interface。
// 両者は互いに subtype ではなく、 $client 等の固有 prop を片方だけ持つ。
// 純関数が実際に呼ぶ 4 メソッド (select/insert/update/delete) だけを pick して
// 構造的部分型とすることで、 db / tx どちらも渡せる型にする。
// ---------------------------------------------------------------------------
export type DbExecutor = Pick<DB, 'select' | 'insert' | 'update' | 'delete'>

// ---------------------------------------------------------------------------
// applyCardCreateWithId
// ---------------------------------------------------------------------------

// create op の input 型。 client が optimistic に組んだ内容を server に送る。
// correct_answer_ids は含めない — server が options.is_correct から再生成する。
export interface ApplyCardCreateWithIdInput {
  cardId: string
  examId: string
  title: string
  sortKey: string | null
  questionText: string
  options: CardOption[]
  explanationText: string | null
  memo: string | null
}

// 戻り値の discriminant。route 側が分岐に使う。
export type ApplyCardCreateWithIdResult =
  | { examNotFound: true; created: false }
  | { examNotFound: false; created: boolean } // created=false は ON CONFLICT skip

/**
 * client 生成 cardId を PK に INSERT ON CONFLICT (id) DO NOTHING し、
 * 実 insert 時のみ exams.card_count += 1。
 *
 * 冪等化 (同 cardId 再送):
 *   ON CONFLICT DO NOTHING → RETURNING が空 → created=false → card_count 非加算。
 *
 * owner-scope 担保:
 *   exam owner 確認 → card INSERT に userId/examId → exams UPDATE に userId/examId。
 *
 * correct_answer_ids は client patch を信用せず options.is_correct から server 再生成
 * (buildSetClause の options 分岐と同方針、client 改竄耐性)。
 */
export async function applyCardCreateWithId(
  tx: DbExecutor,
  userId: string,
  input: ApplyCardCreateWithIdInput,
): Promise<ApplyCardCreateWithIdResult> {
  const { cardId, examId, title, sortKey, questionText, options, explanationText, memo } = input

  // 1. exam owner 確認 (0 rows → INSERT しない、route 側に知らせる)
  const ownerRows = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
  if (ownerRows.length === 0) {
    return { examNotFound: true, created: false }
  }

  // 2. correct_answer_ids を client patch から独立して再生成
  //    (client が is_correct を改竄しても server 側で正規化される)
  const correctAnswerIds = deriveCorrectAnswerIds(options)

  // 3. cards INSERT: id = client 生成 cardId
  //    ON CONFLICT (id) DO NOTHING — 同 cardId の再送は静かにスキップ
  //    FSRS / 学習統計列は DB default が無い(Task 3)ため、1 定義(initialFsrsState)
  //    から明示 set する。due は server 時刻(client optimistic は client 時刻、
  //    reconcile-on-pull で収束 — spec §7.1)。
  const inserted = await tx
    .insert(cards)
    .values({
      id: cardId,
      userId,
      examId,
      sourceDocumentId: null,
      title,
      sortKey,
      questionText,
      options,
      correctAnswerIds,
      explanationText,
      memo,
      ...initialFsrsState(new Date()),
    })
    .onConflictDoNothing({ target: cards.id })
    .returning({ id: cards.id })

  const created = inserted.length > 0

  // 4. 実 insert 時のみ card_count += 1 (ON CONFLICT skip 時は非加算 — 二重加算防止)
  if (created) {
    await bumpExamCardCount(tx, { examId, userId, delta: 1 })
  }

  return { examNotFound: false, created }
}

// ---------------------------------------------------------------------------
// applyCardDelete
// ---------------------------------------------------------------------------

/**
 * 同一 tx 内で:
 *   1. cards から cardId + userId で存在確認 (0 rows → idempotent 成功、tombstone スキップ)
 *   2. tombstones INSERT (.onConflictDoNothing() — re-delete 安全)
 *   3. cards DELETE (owner-scoped)
 *   4. exams.card_count -= 1 (GREATEST guard、 負にならない)
 *
 * updatedAt は card 増減で動かさない (create と同方針)。
 * owner-scope: cardId + userId 全 statement に含める。
 */
export async function applyCardDelete(
  tx: DbExecutor,
  cardId: string,
  userId: string,
): Promise<void> {
  // 1. card 取得: examId を得る (0 rows → idempotent return、tombstone スキップ)
  const rows = await tx
    .select({ examId: cards.examId })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))

  if (rows.length === 0) {
    // 不在 / 他 user の card → silent success (idempotent、tombstone も挿入しない)
    return
  }

  const examId = rows[0]!.examId

  // 2. tombstone INSERT — mirror 削除反映の不変条件: この tombstone が無いと
  // client mirror から消えない（pull.ts 参照）
  await tx
    .insert(tombstones)
    .values({
      userId,
      entityType: 'card',
      entityId: cardId,
      deletedAt: sql`now()`,
    })
    .onConflictDoNothing()

  // 3. card DELETE (owner-scoped)
  await tx
    .delete(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))

  // 4. exams.card_count -= 1 (delta<0 → GREATEST 負ガード、helper 内で処理)
  await bumpExamCardCount(tx, { examId, userId, delta: -1 })
}
