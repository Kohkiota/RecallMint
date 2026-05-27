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
