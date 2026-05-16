import { z } from 'zod'

// contact_messages.category と整合する enum。DB schema (text + $type union)
// に合わせて 5 値固定。値追加時は schema.ts も同時更新。
export const CONTACT_CATEGORIES = [
  'general',
  'bug',
  'takedown',
  'billing',
  'other',
] as const

export type ContactCategory = (typeof CONTACT_CATEGORIES)[number]

export const contactSchema = z.object({
  email: z
    .string()
    .trim()
    .email('メールアドレスの形式が正しくありません')
    .max(254, 'メールアドレスは 254 文字以内で入力してください'),
  category: z.enum(CONTACT_CATEGORIES, {
    message: 'カテゴリを選択してください',
  }),
  subject: z
    .string()
    .trim()
    .min(1, '件名は必須です')
    .max(200, '件名は 200 文字以内で入力してください'),
  // DB column 名 (body) と統一するため field 名は body。
  // UI 表示は「お問い合わせ内容」のまま変えない。
  body: z
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
