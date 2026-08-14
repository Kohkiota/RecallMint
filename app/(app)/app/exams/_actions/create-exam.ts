'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { exams } from '@/lib/db/schema'
import { examNameSchema, firstExamNameError } from '@/lib/exams/exam-name'
import type { ActionResult } from '@/lib/actions/result'

// 試験手動作成 server action。
//
// 試験名を受け取り、 owner-scoped で exams に INSERT して examId を返す。
// source_documents 行は作成しない (手動作成は OCR 出自なし)。
// contentVersion は DB default (0) を使用。 cardCount 列は Sprint B で読み手・書き手とも
// 撤去済の死蔵列(schema 上は残存、 削除は別 task)。
//
// revalidatePath: upload page の「投入先を選択」 dropdown が active exam 一覧に
// 依存するため '/app/upload' を finally で revalidate する (delete-exam.ts と同様)。
// '/app/exams' は遷移先の詳細画面なので revalidate 不要 (通常 nav で再 fetch)。

// name の zod は rename-exam と共有 (`@/lib/exams/exam-name`)。 'use server' file は
// async 関数以外を export できないため schema はここに置かない。

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

  const parsed = examNameSchema.safeParse(name)
  if (!parsed.success)
    return { ok: false, error: firstExamNameError(parsed.error) }

  // RLS-P2 §B: exams は RLS-on ゆえ WITH CHECK 対象。INSERT を withTenantTx で包み
  // tx 冒頭で tenant context (app.user_id GUC) を張る。
  const inserted = await withTenantTx(user.id, (tx) =>
    tx
      .insert(exams)
      .values({ userId: user.id, name: parsed.data })
      .returning({ id: exams.id }),
  )

  return { ok: true, data: { examId: inserted[0].id } }
}
