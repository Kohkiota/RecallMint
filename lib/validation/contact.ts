import { z } from 'zod'

export const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'お名前は必須です')
    .max(100, 'お名前は 100 文字以内で入力してください'),
  email: z
    .string()
    .trim()
    .email('メールアドレスの形式が正しくありません')
    .max(254, 'メールアドレスは 254 文字以内で入力してください'),
  subject: z
    .string()
    .trim()
    .min(1, '件名は必須です')
    .max(200, '件名は 200 文字以内で入力してください'),
  message: z
    .string()
    .trim()
    .min(1, '本文は必須です')
    .max(5000, '本文は 5000 文字以内で入力してください'),
  // honeypot: schema は値の有無を validate せず任意文字列許容。
  // 値が入っていれば silent reject する判定は server action 側で行う
  // (zod reject すると bot に error 露呈で honeypot 失敗のため)。
  website: z.string().optional(),
})

export type ContactInput = z.infer<typeof contactSchema>
