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
import { z } from 'zod'
import { cards, exams, tombstones, type CardOption } from '@/lib/db/schema'
import { buildEmptyCard } from '@/lib/cards/empty-card'
import { optionSchema } from '@/lib/validation/card'
import type { DB } from '@/lib/db'

// ---------------------------------------------------------------------------
// DbExecutor 型: db (PostgresJsDatabase) と tx (PgTransaction) の共通 interface。
// 両者は互いに subtype ではなく、 $client 等の固有 prop を片方だけ持つ。
// 純関数が実際に呼ぶ 4 メソッド (select/insert/update/delete) だけを pick して
// 構造的部分型とすることで、 db / tx どちらも渡せる型にする。
// ---------------------------------------------------------------------------
export type DbExecutor = Pick<DB, 'select' | 'insert' | 'update' | 'delete'>

// ---------------------------------------------------------------------------
// buildSetClause + UpdateCardFieldName (update-card-field.ts からの移動 export)
// ---------------------------------------------------------------------------

export type UpdateCardFieldName =
  | 'title'
  | 'sort_key'
  | 'question_text'
  | 'explanation_text'
  | 'memo'
  | 'options'

const titleSchema = z
  .string()
  .trim()
  .min(1, 'タイトルは必須です')
  .max(200, 'タイトルは 200 文字以内で入力してください')

const sortKeySchema = z
  .string()
  .max(100, 'ソートキーは 100 文字以内で入力してください')
  .nullable()

const questionTextSchema = z
  .string()
  .max(10000, '問題文は 10000 文字以内で入力してください')
  .refine((s) => s.trim().length > 0, { message: '問題文は必須です' })

const explanationTextSchema = z
  .string()
  .max(10000, '解説は 10000 文字以内で入力してください')
  .nullable()

const memoSchema = z
  .string()
  .max(10000, 'メモは 10000 文字以内で入力してください')
  .nullable()

const optionsSchema = z
  .array(optionSchema)
  .min(1, '選択肢は最低 1 個必要です')
  .max(50, '選択肢は最大 50 個までです')
  .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, {
    message: '選択肢の id が重複しています',
  })

// zod safeParse の最初の issue.message を取り出す共通 helper。
function firstError(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? '入力内容が正しくありません'
}

// field → DB column 名 + 値の組を作る。 options のときだけ correctAnswerIds も
// 含めて 2 列同時 set にする。 nullable な text 列 (sort_key / explanation_text /
// memo) は空文字を null に正規化する (UI からの「クリア」操作と整合)。
export function buildSetClause(
  field: UpdateCardFieldName,
  value: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  switch (field) {
    case 'title': {
      const r = titleSchema.safeParse(value)
      if (!r.success) return { ok: false, error: firstError(r.error) }
      return { ok: true, data: { title: r.data } }
    }
    case 'sort_key': {
      const r = sortKeySchema.safeParse(value)
      if (!r.success) return { ok: false, error: firstError(r.error) }
      const normalized = r.data === '' ? null : r.data
      return { ok: true, data: { sortKey: normalized } }
    }
    case 'question_text': {
      const r = questionTextSchema.safeParse(value)
      if (!r.success) return { ok: false, error: firstError(r.error) }
      return { ok: true, data: { questionText: r.data } }
    }
    case 'explanation_text': {
      const r = explanationTextSchema.safeParse(value)
      if (!r.success) return { ok: false, error: firstError(r.error) }
      const normalized = r.data === '' ? null : r.data
      return { ok: true, data: { explanationText: normalized } }
    }
    case 'memo': {
      const r = memoSchema.safeParse(value)
      if (!r.success) return { ok: false, error: firstError(r.error) }
      const normalized = r.data === '' ? null : r.data
      return { ok: true, data: { memo: normalized } }
    }
    case 'options': {
      const r = optionsSchema.safeParse(value)
      if (!r.success) return { ok: false, error: firstError(r.error) }
      // camelCase → snake_case (CardOption)。 explanation は値があるときだけ
      // 残し、 空 string や未指定は jsonb から省く。
      const options: CardOption[] = r.data.map((o) => ({
        id: o.id,
        text: o.text,
        is_correct: o.isCorrect,
        ...(o.explanation ? { explanation: o.explanation } : {}),
      }))
      // correct_answer_ids は client 入力を受けず is_correct から再生成
      // (tech-spec §2.5.2 デノーマ、 client 改竄に対しても堅牢)。
      const correctAnswerIds = options
        .filter((o) => o.is_correct)
        .map((o) => o.id)
      return { ok: true, data: { options, correctAnswerIds } }
    }
    default: {
      // type 上は到達不能だが、 client から unknown 経由で来る可能性に防御。
      return { ok: false, error: '不明なフィールドです' }
    }
  }
}

// ---------------------------------------------------------------------------
// applyCardFieldUpdate
// ---------------------------------------------------------------------------

// UPDATE 結果: 0 rows = カード不在 / owner 不一致を呼び出し元が判定できるよう返す。
export type ApplyCardFieldUpdateResult =
  | { found: true; examId: string }
  | { found: false }

/**
 * cards を 1 field 分 owner-scoped UPDATE し、更新行の有無を返す。
 * validation 済みの setData を受け取る (buildSetClause の呼び出しは wrapper 側)。
 * tx には db / PgTransaction 両方を渡せる。
 */
export async function applyCardFieldUpdate(
  tx: DbExecutor,
  cardId: string,
  userId: string,
  /** caller は buildSetClause の検証済み出力 (data プロパティ) を渡すこと */
  setData: Record<string, unknown>,
): Promise<ApplyCardFieldUpdateResult> {
  const updated = await tx
    .update(cards)
    .set({ ...setData, updatedAt: sql`now()` })
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .returning({ examId: cards.examId })

  const row = updated[0]
  if (!row) return { found: false }
  return { found: true, examId: row.examId }
}

// ---------------------------------------------------------------------------
// applyCardCreate
// ---------------------------------------------------------------------------

// tx 内で exam 不在 / 他 user を検出して呼び出し元に知らせる sentinel。
// createCard server action が「試験が見つかりません」を返すために必要。
export const EXAM_NOT_FOUND = Symbol('exam-not-found')
export type ExamNotFound = typeof EXAM_NOT_FOUND

/**
 * owner-scoped で placeholder card を INSERT し、同一 tx で exams.card_count += 1。
 * exam 不在 / 他 user の場合は EXAM_NOT_FOUND sentinel を返す (rollback させる)。
 * 返り値は新 cardId または EXAM_NOT_FOUND。
 *
 * spec §3.6: insert と increment を同一 tx に閉じることが件数整合の唯一の保証。
 */
export async function applyCardCreate(
  tx: DbExecutor,
  examId: string,
  userId: string,
): Promise<string | ExamNotFound> {
  // 1. exam owner 確認 (0 rows → sentinel return で card insert させず rollback)
  const ownerRows = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
  if (ownerRows.length === 0) return EXAM_NOT_FOUND

  // 2. 既存 card の sortKey 集合と件数を取得 (placeholder 採番用)
  const existing = await tx
    .select({ sortKey: cards.sortKey })
    .from(cards)
    .where(and(eq(cards.examId, examId), eq(cards.userId, userId)))
  const existingSortKeys = existing.map((r) => r.sortKey)
  const existingCount = existing.length

  // 3. placeholder 値生成 (title/sortKey/questionText/options/correctAnswerIds)
  const placeholder = buildEmptyCard(existingSortKeys, existingCount)

  // 4. card INSERT (FSRS + due は schema default、 ここでは set しない)
  const inserted = await tx
    .insert(cards)
    .values({ userId, examId, sourceDocumentId: null, ...placeholder })
    .returning({ id: cards.id })

  // 5. 同一 tx で card_count += 1 (整合保証の核心)
  // updatedAt は card 増減で動かさない (試験一覧の updatedAt DESC 順を乱さない、
  // process.ts B1 と同方針)。
  await tx
    .update(exams)
    .set({
      cardCount: sql`${exams.cardCount} + 1`,
      updatedAt: sql`${exams.updatedAt}`,
    })
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))

  return inserted[0].id
}

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
  const correctAnswerIds = options.filter((o) => o.is_correct).map((o) => o.id)

  // 3. cards INSERT: id = client 生成 cardId
  //    ON CONFLICT (id) DO NOTHING — 同 cardId の再送は静かにスキップ
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
    })
    .onConflictDoNothing({ target: cards.id })
    .returning({ id: cards.id })

  const created = inserted.length > 0

  // 4. 実 insert 時のみ card_count += 1 (ON CONFLICT skip 時は非加算 — 二重加算防止)
  //    updatedAt は据え置き (card 増減で動かさない、applyCardCreate と同方針)
  if (created) {
    await tx
      .update(exams)
      .set({
        cardCount: sql`${exams.cardCount} + 1`,
        updatedAt: sql`${exams.updatedAt}`,
      })
      .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
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

  // 4. exams.card_count -= 1 (GREATEST for negative guard)
  //    updatedAt は card 増減で動かさない (create-card.ts §B1 と同方針)
  await tx
    .update(exams)
    .set({
      cardCount: sql`GREATEST(${exams.cardCount} - 1, 0)`,
      updatedAt: sql`${exams.updatedAt}`,
    })
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
}
