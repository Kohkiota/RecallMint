import { z } from 'zod'

// 試験名の入力規則 (create / rename 共通)。
//
// action file 側 (`_actions/create-exam.ts` / `_actions/rename-exam.ts`) は
// `'use server'` ゆえ async 関数以外を export できない (Next 16 + Turbopack の
// server reference 変換。 eslint Block E2-useserver-typeexport と同根)。 よって
// 共有する schema / helper は action の外の pure module に置き、 両 action から
// import する (client/server 二重定義をしない)。

export const examNameSchema = z
  .string()
  .trim()
  .min(1, '試験名は必須です')
  .max(200, '試験名は 200 文字以内で入力してください')

// zod safeParse の最初の issue.message を取り出す共通 helper。
export function firstExamNameError(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? '入力内容が正しくありません'
}
