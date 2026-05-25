'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { exams } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// 試験一覧から exam を削除する server action。
//
// discard.ts の mode='new' 分岐 (exam 1 文 DELETE → FK CASCADE 連動削除) を
// 転用。exam を owner-scoped で DELETE するだけで、FK CASCADE
// (source_documents.exam_id / cards.exam_id = ON DELETE CASCADE、
//  reviews.card_id = ON DELETE CASCADE) により紐づく全データを DB が
// 連動削除する。アプリ側で cards / source_documents を個別に DELETE しない。
//
// 安全性: WHERE user_id = ? で他 user の exam を構造的に保護。
// 不在 / 他 user の examId は silent success (idempotent、 double-click 対策)。
// 別途 SELECT で存在確認は行わない — DELETE の WHERE に user_id を含めれば
// 他 user の行は消えないため、SELECT は冗長になる。
export async function deleteExam(examId: string): Promise<ActionResult> {
  // S-cache-2a: revalidatePath('/app/exams') は撤去。 削除ボタンは /app/exams 上で
  // 押下され、 success 時に `delete-exam-button.tsx` の `router.refresh()` が
  // 同 path を再 fetch するため、 同 path の revalidatePath は redundant。
  // /app/upload は cross-page (upload page の「投入先を選択」 dropdown が active
  // exam 一覧に依存) のため revalidate を残置。
  try {
    return await _deleteExam(examId)
  } finally {
    revalidatePath('/app/upload')
  }
}

async function _deleteExam(examId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()

  // owner-scoped 単一文 DELETE。FK CASCADE で source_documents / cards /
  // reviews が連動削除される。不在 / 他 user の examId は WHERE が 0 行に
  // マッチするだけで例外なし = silent success (idempotent)。
  await db
    .delete(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))

  return { ok: true }
}
