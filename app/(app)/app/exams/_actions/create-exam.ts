'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { exams } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// 試験手動作成 server action。
//
// 試験名を受け取り、 owner-scoped で exams に INSERT して examId を返す。
// source_documents 行は作成しない (手動作成は OCR 出自なし)。
// cardCount / contentVersion は DB default (0) を使用。
//
// revalidatePath: upload page の「投入先を選択」 dropdown が active exam 一覧に
// 依存するため '/app/upload' を finally で revalidate する (delete-exam.ts と同様)。
// '/app/exams' は遷移先の詳細画面なので revalidate 不要 (通常 nav で再 fetch)。

const nameSchema = z
  .string()
  .trim()
  .min(1, '試験名は必須です')
  .max(200, '試験名は 200 文字以内で入力してください')

// zod safeParse の最初の issue.message を取り出す共通 helper。
function firstError(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? '入力内容が正しくありません'
}

export async function createExam(
  name: string,
): Promise<ActionResult<{ examId: string }>> {
  try {
    return await _createExam(name)
  } finally {
    revalidatePath('/app/upload')
  }
}

async function _createExam(
  name: string,
): Promise<ActionResult<{ examId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = nameSchema.safeParse(name)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }

  const db = getDb()
  const inserted = await db
    .insert(exams)
    .values({ userId: user.id, name: parsed.data })
    .returning({ id: exams.id })

  return { ok: true, data: { examId: inserted[0].id } }
}
