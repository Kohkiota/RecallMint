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

import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  cards,
  cardTags,
  tagCategories,
  tagOptions,
  type CardOption,
} from '@/lib/db/schema'
import {
  titleSchema,
  sortKeySchema,
  questionTextSchema,
  explanationTextSchema,
  memoSchema,
  optionsSchema,
} from '@/lib/validation/card'
import {
  deriveCorrectAnswerIds,
  normalizeNullableTextField,
} from '@/lib/cards/domain/card-rules'
import { hasSingleCategoryOverflow } from '@/lib/cards/domain/card-tag-constraint'
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
// 値検証 zod (field bound schema は @/lib/validation/card に集約 = F3-R3)
// ---------------------------------------------------------------------------

// Tag-2c: card 編集 UI からのタグ付与/解除。 value = uuid[] (tag_options.id 集合)。
// upper bound 100 は UI/取り回し上の現実的上限 (option pool 自体は user 全体で多くても
// 数百〜千、 1 card に紐付くのは現実的に数十まで)。 越えたら 'failed' で押し返す。
const tagOptionIdsSchema = z.array(z.uuid()).max(100)

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
  const normalized = normalizeNullableTextField('sort_key', r.data)
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
  const normalized = normalizeNullableTextField('explanation_text', r.data)
  return updateCardField(tx, cardId, userId, { explanationText: normalized })
}

const handleMemo: CardFieldHandler = async (tx, cardId, userId, value) => {
  const r = memoSchema.safeParse(value)
  if (!r.success) return 'failed'
  const normalized = normalizeNullableTextField('memo', r.data)
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
  const correctAnswerIds = deriveCorrectAnswerIds(options)
  return updateCardField(tx, cardId, userId, { options, correctAnswerIds })
}

// ---------------------------------------------------------------------------
// tag_option_ids handler (Tag-2c)
// ---------------------------------------------------------------------------
//
// card 編集 UI からのタグ付与/解除を、 既存 update_field op の 1 entry として実現する。
// 値は uuid[] (tag_options.id 集合)。 handler は card_tags の whole-set replace
// (DELETE 全部 → INSERT 新集合) + cards.updated_at bump (= 別端末側 card_tags 取り直し
// 経路 (Tag-2b) の起点) を 1 関数で完結する。
//
// 検査順 (失敗時は副作用なしで 'failed'):
//   1. value 形式 (uuid[] / max 100)
//   2. card の存在 + owner-scope
//   3. option_id 全件の存在 + owner-scope (bulk SELECT で件数一致確認)
//   3.5. A-1: select_type='single' なカテゴリに option 2 個以上の whole-set を reject
//        (owner-scope tag_categories SELECT + カテゴリごとの option 数集計)
//   4. card_tags whole-set DELETE → INSERT
//   5. cards.updated_at bump (独立 SQL、 SET 列を持たないので updateCardField helper は使えない)
const handleTagOptionIds: CardFieldHandler = async (tx, cardId, userId, value) => {
  // 1. value 形式
  const r = tagOptionIdsSchema.safeParse(value)
  if (!r.success) return 'failed'

  // 2. 重複排除 (同一 UI 操作内で重複 UUID が来ても挙動を冪等にする)
  const optionIds = [...new Set(r.data)]

  // 3. card の存在 + owner-scope
  const card = await tx
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
  if (card.length === 0) return 'failed'

  // 4. option_id 全件の存在 + owner-scope (1 件でも欠ければ他 user の option / 存在しない
  //    option の混在として弾く)。 空配列は SQL skip。
  if (optionIds.length > 0) {
    const valid = await tx
      .select({ id: tagOptions.id, categoryId: tagOptions.categoryId })
      .from(tagOptions)
      .where(
        and(inArray(tagOptions.id, optionIds), eq(tagOptions.userId, userId)),
      )
    if (valid.length !== optionIds.length) return 'failed'

    // 4.5. A-1: select_type='single' なカテゴリに 2 個以上の option が whole-set に
    //      含まれる場合は reject (client のみだった single 制約を server でも enforce)。
    //      grouping は重複排除後の optionIds (dedup 済み valid) に対して行う。
    const categoryIds = [...new Set(valid.map((v) => v.categoryId))]
    const categories = await tx
      .select({ id: tagCategories.id, selectType: tagCategories.selectType })
      .from(tagCategories)
      .where(
        and(
          inArray(tagCategories.id, categoryIds),
          eq(tagCategories.userId, userId),
        ),
      )
    // orphan category (FK cascade 上は起きないはずだが fail closed で弾く)
    if (categories.length !== categoryIds.length) return 'failed'

    // single 制約判定は pure domain 述語に委譲 (F3-R6 配線)。single カテゴリに
    // 2 個以上の option が含まれれば reject (client のみだった制約を server enforce)。
    if (hasSingleCategoryOverflow(valid, categories)) return 'failed'
  }

  // 5. whole-set replace: 既存の紐付けを全部消す。 owner-scope 重複付与で他 user 行への
  //    DELETE を防御。 (card_id の FK cascade があるので user 自身の他 card 行は影響しない。)
  await tx
    .delete(cardTags)
    .where(and(eq(cardTags.cardId, cardId), eq(cardTags.userId, userId)))

  // 6. 新集合 INSERT (空配列なら全 unset と等価で skip)
  if (optionIds.length > 0) {
    await tx
      .insert(cardTags)
      .values(optionIds.map((optionId) => ({ cardId, optionId, userId })))
  }

  // 7. cards.updated_at bump。 別端末側で card_tags pull stream を起こす際の起点
  //    (Tag-2b の「変更カード集合の取り直し」 経路)。 SET 列を持たない touch なので
  //    updateCardField helper (SET 列必須) ではなく独立 SQL で発行する。
  await tx
    .update(cards)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))

  return 'applied'
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
  tag_option_ids: handleTagOptionIds,
} as const satisfies Record<string, CardFieldHandler>

export type CardFieldName = keyof typeof CARD_FIELD_HANDLERS
