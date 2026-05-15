'use server'

import { contactSchema } from '@/lib/validation/contact'
import type { ActionResult } from '@/lib/actions/result'

// TODO: Sprint A-3+ で contact_messages テーブルに INSERT 実装。
// 現状は Sprint A-2 で Discord 送信撤去に伴う validation-only stub。
// honeypot trip / zod 違反は明示エラー、 valid な送信は silent success。
export async function submitContact(input: unknown): Promise<ActionResult> {
  const parsed = contactSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message }
  }

  // honeypot: website field に値があれば silent reject (bot に成功を装う)。
  if (parsed.data.website && parsed.data.website.length > 0) {
    return { ok: true }
  }

  return { ok: true }
}
