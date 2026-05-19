'use server'

import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, sourceDocuments } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// 「やり直し」 / 「ファイル変更して再試行」 用に、 直前の OCR 結果 (cards +
// source_documents) を物理削除する。 schema 上 cards.source_document_id は SET NULL
// 設計 (OCR 元削除しても card 保持) のため、 retry シナリオでは明示的に cards も
// 削除する必要がある。
//
// 安全性: 削除前に source_documents.user_id と現在の user.id が一致することを
// 確認する (他 user の data を消さない)。
export async function discardUpload(
  sourceDocumentId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()

  // 所有者確認 (他 user の source_document を消そうとしている悪意 input への防御)
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
    // すでに削除済 or 他 user のものなら silent success (idempotent)
    return { ok: true }
  }

  // cards 先に削除 (FK ON DELETE SET NULL のため source_document 削除では消えない)
  await db.delete(cards).where(eq(cards.sourceDocumentId, sourceDocumentId))
  await db.delete(sourceDocuments).where(eq(sourceDocuments.id, sourceDocumentId))

  return { ok: true }
}
