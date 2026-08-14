'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { exams } from '@/lib/db/schema'
import { examNameSchema, firstExamNameError } from '@/lib/exams/exam-name'
import { logger } from '@/lib/logger'
import { serializeDbError } from '@/lib/db/serialize-db-error'
import { reportRlsContextFailure } from '@/lib/db/report-rls-context-failure'
import type { ActionResult } from '@/lib/actions/result'

// 試験名の改名 server action (Grid-3 spec §6.2)。
//
// exam の書込は entity_mutations (outbox) に載せない — 「outbox は exam を運ばない」は
// DB CHECK + iso pin で強制された既存の不変条件で、 create / delete と同じく rename も
// server action + client 側 runGuardedPull の専用レーンで行う。
//
// UPDATE は name 列のみ。 updated_at は drizzle の $onUpdate (schema.ts:275-278) が
// bump し、 その値を増分 pull の cursor が拾って他端末へ伝播する (明示 SET しない)。
//
// revalidatePath: upload page の「投入先を選択」 dropdown が exam 名を server render
// するため '/app/upload' を finally で revalidate する (create-exam / delete-exam と同様)。
// 試験詳細 '/app/exams/[id]' は呼び出し元 component の router.refresh() が更新する。
export async function renameExam(
  examId: string,
  name: string,
): Promise<ActionResult<null>> {
  try {
    return await _renameExam(examId, name)
  } finally {
    revalidatePath('/app/upload')
  }
}

async function _renameExam(
  examId: string,
  name: string,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const parsed = examNameSchema.safeParse(name)
  if (!parsed.success)
    return { ok: false, error: firstExamNameError(parsed.error) }

  try {
    // RLS-P2 §B: exams は RLS-on ゆえ UPDATE も WITH CHECK 対象。 withTenantTx で
    // tenant context (app.user_id GUC) を張った tx 内で実行する。
    // WHERE user_id = ? で他 user の exam を構造的に保護 (RLS と二重防御)。
    const updated = await withTenantTx(user.id, (tx) =>
      tx
        .update(exams)
        .set({ name: parsed.data })
        .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))
        .returning({ id: exams.id }),
    )

    // 0 行 = 不在 / 他 user。 delete と違い rename は冪等な「消えていてほしい」操作では
    // ないため silent success にせず失敗を返す (UI が inline error を出して気付ける)。
    if (updated.length === 0) {
      return {
        ok: false,
        error: '試験が見つかりませんでした。画面を再読み込みしてください。',
      }
    }

    return { ok: true }
  } catch (err) {
    logger.error({
      event: 'exams.rename.failed',
      examId,
      userId: user.id,
      err: serializeDbError(err),
    })
    // RLS-P3 Task 7: P0RLS (tenant context 未設定) なら台帳 + Discord へ loud alert。
    await reportRlsContextFailure(err, { route: 'rename-exam', op: 'update' })
    return {
      ok: false,
      error: '試験名の変更に失敗しました。しばらくしてから再度お試しください。',
    }
  }
}
