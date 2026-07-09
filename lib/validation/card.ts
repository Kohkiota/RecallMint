import { z } from 'zod'

// inline 編集 (`/app/exams/[id]` 内 option 編集) の選択肢入力 validation。
// 元は `/app/cards/[id]` page の 5 列同時保存にも使われていたが、 同 page 廃止
// (cache-fix roadmap ④-3) で `optionSchema` 1 個に narrow された。
//
// 正答数の下限を設けていないのは意図的: OCR が正答未記載で取り込んだ card は
// 全選択肢 is_correct=false で保存されており、 user が後から正答を付けるまで
// 「正答 0」状態を許す必要がある (tech-spec §2.5.2 の「最低 1 個」より編集 UI を
// 優先、 0 件は UI 側で warning 表示しつつ保存を通す)。
// correct_answer_ids は本 schema に含めない — server action 側で is_correct から
// 再生成する (options[].is_correct のデノーマ、 tech-spec §2.5.2)。

export const optionSchema = z.object({
  id: z.string().min(1, '選択肢の id は必須です'),
  text: z
    .string()
    .max(1000, '選択肢の本文は 1000 文字以内で入力してください')
    .refine((s) => s.trim().length > 0, {
      message: '選択肢の本文は必須です',
    }),
  isCorrect: z.boolean(),
  explanation: z
    .string()
    .max(2000, '選択肢の解説は 2000 文字以内で入力してください')
    .optional(),
})

// ---------------------------------------------------------------------------
// card field-bound schema (F3-R3 集約)
// ---------------------------------------------------------------------------
//
// card の各 field の境界検証 zod。 元は card-field-handlers.ts (各 handler の
// 値検証) と mutation-schemas.ts (cardCreatePatchSchema の inline) に二重定義
// されていたものを、 単一 source として本 module に集約した (drift 防止)。
// 両 consumer は同一 schema object を .safeParse / z.object field に差すため、
// issue path・message は文字通り不変。

export const titleSchema = z
  .string()
  .trim()
  .min(1, 'タイトルは必須です')
  .max(200, 'タイトルは 200 文字以内で入力してください')

export const sortKeySchema = z
  .string()
  .max(100, 'ソートキーは 100 文字以内で入力してください')
  .nullable()

export const questionTextSchema = z
  .string()
  .max(10000, '問題文は 10000 文字以内で入力してください')
  .refine((s) => s.trim().length > 0, { message: '問題文は必須です' })

export const explanationTextSchema = z
  .string()
  .max(10000, '解説は 10000 文字以内で入力してください')
  .nullable()

export const memoSchema = z
  .string()
  .max(10000, 'メモは 10000 文字以内で入力してください')
  .nullable()

export const optionsSchema = z
  .array(optionSchema)
  .min(1, '選択肢は最低 1 個必要です')
  .max(50, '選択肢は最大 50 個までです')
  .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, {
    message: '選択肢の id が重複しています',
  })
