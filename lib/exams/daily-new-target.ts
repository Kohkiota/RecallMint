import { z } from 'zod'

// 新規/日の上限 (K) の入力規則 (Dash-1 Home v1 spec §8.1)。
//
// null = 既定 DAILY_NEW_DEFAULT (20) に追従 (user_settings.session_limit と同じ
// 「未設定 = 既定追従」の意味論)。 0 は「新規を出さない」明示値であり null とは別
// (Task 6 の `K = exam.daily_new_target ?? DAILY_NEW_DEFAULT` が前提とする区別。
// ここで 0 を弾く / 既定に丸めると Task 6 側の `??` 契約が崩れる)。
//
// action file 側 (`_actions/update-daily-new-target.ts`) は `'use server'` ゆえ
// async 関数以外を export できない (exam-name.ts と同じ Next 16 + Turbopack 制約)。
// よって共有 schema は action の外の pure module に置く。
export const dailyNewTargetSchema = z
  .number({ error: '数値を入力してください' })
  .int('整数で入力してください')
  .min(0, '0〜999で入力してください')
  .max(999, '0〜999で入力してください')
  .nullable()

// zod safeParse の最初の issue.message を取り出す共通 helper (exam-name.ts と同型)。
export function firstDailyNewTargetError(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? '入力内容が正しくありません'
}
