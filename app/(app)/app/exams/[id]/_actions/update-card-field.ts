'use server'

import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, type CardOption } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'
import { logger } from '@/lib/logger'
import { optionSchema } from '@/lib/validation/card'

// 試験詳細画面 (/app/exams/[id]) inline 編集用の field 単位 server action。
// 既存 updateCard (cards/[id] 5 列同時保存) は変更せず、 本 action では
// editable 1 field のみ owner-scoped で UPDATE する (options 指定時のみ
// correct_answer_ids も同時更新 — 2 列 set)。
// 各 field の validation は lib/validation/card.ts と同等ルールを field 単位に
// 再構成、 optionSchema は同 file から再利用 (DRY)。

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
// zod v4 は SafeParseReturnType を export していないため、 error 経由で受ける
// 単一引数 helper にしておく (呼び出し側で `if (!r.success)` 判定後に渡す)。
function firstError(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? '入力内容が正しくありません'
}

// field → DB column 名 + 値の組を作る。 options のときだけ correctAnswerIds も
// 含めて 2 列同時 set にする。 nullable な text 列 (sort_key / explanation_text /
// memo) は空文字を null に正規化する (UI からの「クリア」操作と整合)。
function buildSetClause(
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

export async function updateCardField(
  cardId: string,
  field: UpdateCardFieldName,
  value: unknown,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const built = buildSetClause(field, value)
  if (!built.ok) return built

  const db = getDb()
  try {
    const updated = await db
      .update(cards)
      .set({ ...built.data, updatedAt: sql`now()` })
      .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))
      .returning({ examId: cards.examId })

    const row = updated[0]
    if (!row) return { ok: false, error: 'カードが見つかりません' }

    // S-cache-2a: revalidatePath('/app/exams/[id]') は撤去。 Next.js 15 は client
    // component から呼ばれた server action の完了後、 呼出元 route segment の
    // server component を自動再実行して新 RSC tree を返す (inline-text-field /
    // inline-option-row の `serverOptions` prop 更新が依存する機構)。 同 path への
    // revalidatePath はこの自動再実行と重複し redundant。
    // (cache-fix roadmap ④-3: 旧 /app/cards/[id] page への cross-page revalidate
    // も同 page 廃止に伴い撤去済)
    return { ok: true }
  } catch (err) {
    logger.error({
      event: 'cards.update_field.failed',
      cardId,
      field,
      userId: user.id,
      err,
    })
    return {
      ok: false,
      error: '保存に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
