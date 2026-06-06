// card-field-handlers.ts — card.update_field op を field 名 → handler 関数の
// dispatch table に分解したもの。
//
// 各 handler は統一 signature
//   (tx, cardId, userId, value) => Promise<ApplyResult>
// を持ち、 値検証 (zod) + 正規化 + cards owner-scoped UPDATE を 1 関数で完結する。
//
// 設計判断 (案 Y):
// - 値検証 zod は各 handler 内に閉じる (drift しない、 add field が 1 entry で済む)
// - registry 側 envelope は field: z.string().min(1) に緩和し、 未知 field は
//   dispatch 段で `if (!handler) return 'failed'` で弾く
// - SET 句には常に updatedAt = sql`now()` を含める (旧 applyCardFieldUpdate と同じ)
// - owner-scope は `eq(cards.id, cardId)` + `eq(cards.userId, userId)` を全 handler で
// - 戻り値: 0 row return / 値検証失敗 → 'failed'、 1 row return → 'applied'
//
// 後続 Tag-2c で `tag_option_ids` field を 1 entry 追加するだけで済む構造。

import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { cards, type CardOption } from '@/lib/db/schema'
import { optionSchema } from '@/lib/validation/card'
import type { DbExecutor } from './apply-card-mutation'

// ---------------------------------------------------------------------------
// 共通型
// ---------------------------------------------------------------------------

/**
 * registry の ApplyResult と一致させる。 `'skipped'` は本ファイルでは使わない
 * (該当する idempotent skip パスが存在しないため)。
 */
export type ApplyResult = 'applied' | 'failed' | 'skipped'

/**
 * 全 handler の統一 signature。
 *
 * - tx: 呼出側が用意した executor (db 直 or per-mutation tx)
 * - cardId: 更新対象 card の PK (uuid)
 * - userId: owner-scope 用
 * - value: registry が envelope zod (field/value) で受け取った後の生 unknown。
 *          各 handler 内で zod で値検証する。
 */
export type CardFieldHandler = (
  tx: DbExecutor,
  cardId: string,
  userId: string,
  value: unknown,
) => Promise<ApplyResult>

// ---------------------------------------------------------------------------
// 値検証 zod (旧 apply-card-mutation.ts の 6 schema を移植、 エラーメッセージ完全一致)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 共通 helper: owner-scoped UPDATE 1 列発行 → 0 row=failed / 1 row=applied
// ---------------------------------------------------------------------------

/**
 * cards を 1 file 用 SET 句で owner-scoped UPDATE する。
 * updatedAt は sql`now()` で常時 bump。
 *
 * - 0 row return (不在 / 他 user) → 'failed'
 * - 1 row return → 'applied'
 *
 * 旧 applyCardFieldUpdate と SET 列・WHERE 条件は一字一句一致。
 */
async function updateCardField(
  tx: DbExecutor,
  cardId: string,
  userId: string,
  setData: Record<string, unknown>,
): Promise<ApplyResult> {
  const updated = await tx
    .update(cards)
    .set({ ...setData, updatedAt: sql`now()` })
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .returning({ examId: cards.examId })
  return updated.length > 0 ? 'applied' : 'failed'
}

// ---------------------------------------------------------------------------
// 各 handler
// ---------------------------------------------------------------------------

const handleTitle: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = titleSchema.safeParse(value)
  if (!r.success) return 'failed'
  return updateCardField(tx, cardId, userId, { title: r.data })
}

const handleSortKey: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = sortKeySchema.safeParse(value)
  if (!r.success) return 'failed'
  // '' → null 正規化 (UI からの「クリア」操作と整合、 旧 buildSetClause 同等)
  const normalized = r.data === '' ? null : r.data
  return updateCardField(tx, cardId, userId, { sortKey: normalized })
}

const handleQuestionText: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = questionTextSchema.safeParse(value)
  if (!r.success) return 'failed'
  return updateCardField(tx, cardId, userId, { questionText: r.data })
}

const handleExplanationText: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = explanationTextSchema.safeParse(value)
  if (!r.success) return 'failed'
  const normalized = r.data === '' ? null : r.data
  return updateCardField(tx, cardId, userId, { explanationText: normalized })
}

const handleMemo: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = memoSchema.safeParse(value)
  if (!r.success) return 'failed'
  const normalized = r.data === '' ? null : r.data
  return updateCardField(tx, cardId, userId, { memo: normalized })
}

const handleOptions: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = optionsSchema.safeParse(value)
  if (!r.success) return 'failed'
  // camelCase (zod) → snake_case (CardOption)。 explanation は値があるときだけ
  // 残し、 空 string や未指定は jsonb から省く (旧 buildSetClause 同等)。
  const options: CardOption[] = r.data.map((o) => ({
    id: o.id,
    text: o.text,
    is_correct: o.isCorrect,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }))
  // correct_answer_ids は client 入力を信用せず is_correct から server 再生成
  // (tech-spec §2.5.2 デノーマ、 client 改竄に対しても堅牢)。
  const correctAnswerIds = options
    .filter((o) => o.is_correct)
    .map((o) => o.id)
  return updateCardField(tx, cardId, userId, { options, correctAnswerIds })
}

// ---------------------------------------------------------------------------
// dispatch table
// ---------------------------------------------------------------------------

/**
 * field 名 → handler の dispatch table。
 *
 * registry (entity-mutation-registry.ts) の applyCardUpdateField は envelope
 * zod 通過後の field 名でこの map を引き、 未登録なら 'failed' を返す。
 * 新 field 追加は本 map に 1 entry 追加 + 値 zod 追加で済む。
 */
export const CARD_FIELD_HANDLERS = {
  title: handleTitle,
  sort_key: handleSortKey,
  question_text: handleQuestionText,
  explanation_text: handleExplanationText,
  memo: handleMemo,
  options: handleOptions,
} as const satisfies Record<string, CardFieldHandler>

export type CardFieldName = keyof typeof CARD_FIELD_HANDLERS
