import { z } from 'zod'

// card 編集 page (/app/cards/[id]) の入力 validation。
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

export const updateCardInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'タイトルは必須です')
    .max(200, 'タイトルは 200 文字以内で入力してください'),
  // question_text / option.text は Markdown 等の整形を保持するため値は trim せず
  // 格納するが、 空白のみ入力は refine で必須チェックする (title の trim + min と
  // 整合させ、 空白だけの問題文 / 選択肢を弾く)。
  questionText: z
    .string()
    .max(10000, '問題文は 10000 文字以内で入力してください')
    .refine((s) => s.trim().length > 0, { message: '問題文は必須です' }),
  options: z
    .array(optionSchema)
    .min(1, '選択肢は最低 1 個必要です')
    .max(50, '選択肢は最大 50 個までです')
    .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length, {
      message: '選択肢の id が重複しています',
    }),
  // card 全体の解説。 未設定は null (DB の explanation_text は nullable)。
  explanationText: z
    .string()
    .max(10000, '解説は 10000 文字以内で入力してください')
    .nullable(),
})

export type UpdateCardInput = z.infer<typeof updateCardInputSchema>

export type ParseUpdateCardResult =
  | { ok: true; data: UpdateCardInput }
  | { ok: false; error: string }

// safeParse して、 失敗時は最初の issue の日本語 message を取り出す。
// server action が直接 client へ返せる形 ({ok,error}) に正規化する。
export function parseUpdateCardInput(raw: unknown): ParseUpdateCardResult {
  const result = updateCardInputSchema.safeParse(raw)
  if (result.success) return { ok: true, data: result.data }
  const first = result.error.issues[0]
  return { ok: false, error: first?.message ?? '入力内容が正しくありません' }
}
