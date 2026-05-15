import { z } from 'zod'

export const wordSchema = z.object({
  word: z.string().trim().min(1, '単語は必須です').max(64, '単語は 64 文字以内で入力してください'),
  meaning: z.string().trim().min(1, '意味は必須です').max(100, '意味は 100 文字以内で入力してください'),
  userExample: z.string().trim().max(300, '例文は 300 文字以内で入力してください').optional(),
})

export const updateWordPatchSchema = wordSchema.partial()
