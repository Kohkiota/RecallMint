'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, exams, sourceDocuments } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// 「やり直し」 / 「ファイル変更して再試行」 用に、 直前の OCR 結果を破棄する。
//
// S1.9.1: 月次 quota 集計元を upload_records に分離した結果、 discard は quota を
// 一切気にせず物理削除してよくなった (upload_records には touch しない = 返金が
// 起きない)。 これにより S1.9 で必要だった NOT EXISTS guard を撤廃し、 FK CASCADE
// に乗せて簡素化:
//   - mode='new'  (autoCreatedExamId あり): exam を 1 文 DELETE。
//     source_documents.exam_id / cards.exam_id の ON DELETE CASCADE で
//     source_documents と cards が連動削除される
//   - mode='existing' (autoCreatedExamId なし): exam は既存ユーザー資産なので
//     残し、 cards と source_documents のみ手動削除
//
// 安全性: source_documents の所有者を SELECT で確認 (idempotent silent success)。
// exam DELETE / source_documents DELETE とも WHERE user_id = ? で他 user の
// データを構造的に保護する。
export async function discardUpload(
  sourceDocumentId: string,
  autoCreatedExamId?: string,
): Promise<ActionResult> {
  // S1.8: discard で残量 banner (Server Component fetch) を即時新値にするため、
  // 戻り値前 (try/finally) で root layout 配下を一括 revalidate する。
  try {
    return await _discardUpload(sourceDocumentId, autoCreatedExamId)
  } finally {
    revalidatePath('/', 'layout')
  }
}

async function _discardUpload(
  sourceDocumentId: string,
  autoCreatedExamId?: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()

  // 所有者確認 (他 user の source_document を消そうとしている悪意 input への防御)。
  // 既に削除済 or 他 user のものなら silent success (idempotent、 double-click 等)。
  const found = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.id, sourceDocumentId),
        eq(sourceDocuments.userId, user.id),
      ),
    )
    .limit(1)
  if (found.length === 0) {
    return { ok: true }
  }

  if (autoCreatedExamId) {
    // mode='new': auto 作成 exam を削除。 FK CASCADE
    // (source_documents.exam_id / cards.exam_id = ON DELETE CASCADE) により
    // 紐づく source_documents と cards は DB が連動削除する。 単一文のため
    // cascade 含め atomic。
    await db
      .delete(exams)
      .where(and(eq(exams.id, autoCreatedExamId), eq(exams.userId, user.id)))
  } else {
    // mode='existing': exam は既存ユーザー資産のため残す。 今回 OCR の cards と
    // source_documents のみ削除 (cards.source_document_id は SET NULL 設計で
    // source_documents 削除では消えないため明示削除)。 1 transaction で atomic。
    await db.transaction(async (tx) => {
      await tx.delete(cards).where(eq(cards.sourceDocumentId, sourceDocumentId))
      await tx
        .delete(sourceDocuments)
        .where(
          and(
            eq(sourceDocuments.id, sourceDocumentId),
            eq(sourceDocuments.userId, user.id),
          ),
        )
    })
  }

  // upload_records は一切 touch しない (= 月次 quota は返金されない、 Bug A 解消)。
  return { ok: true }
}
