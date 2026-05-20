'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, exams, sourceDocuments } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// 「破棄して再アップロード」 用に、 直前の OCR 結果を破棄する。
//
// S1.9.2: signature を 1 引数に縮約。 旧来 client が examWasAutoCreated を第 2
// 引数で渡していたが、 source_documents.mode 列を真実 source として server 側で
// DB から読み、 client / URL 改竄に依存しない判定にした。
//   - mode='new'  : この upload が exam を新規作成した → exam を 1 文 DELETE。
//     source_documents.exam_id / cards.exam_id の ON DELETE CASCADE で
//     source_documents と cards が連動削除される
//   - mode='existing' : 既存 exam への追加 → exam は既存ユーザー資産なので残し、
//     今回 OCR の cards と source_documents のみ削除
//
// 安全性: source_documents の所有者を SELECT で確認 (idempotent silent success)。
// exam DELETE / source_documents DELETE とも WHERE user_id = ? で他 user の
// データを構造的に保護する。 upload_records は一切 touch しない (月次 quota は
// 返金されない、 S1.9.1 Bug A 解消の維持)。
export async function discardUpload(
  sourceDocumentId: string,
): Promise<ActionResult> {
  // S1.9.2: revalidate scope を root layout 全体から /app/upload + /app/exams に
  // 縮小。 discard の影響を受ける Server Component は残量 banner (/app/upload) と
  // exam 一覧 / card 数 (/app/exams) のみ。
  try {
    return await _discardUpload(sourceDocumentId)
  } finally {
    revalidatePath('/app/upload')
    revalidatePath('/app/exams')
  }
}

async function _discardUpload(
  sourceDocumentId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: '認証が必要です' }

  const db = getDb()

  // 所有者確認 + discard 分岐に必要な mode / exam_id を 1 SELECT で取得。
  // 既に削除済 or 他 user のものなら silent success (idempotent、 double-click 等)。
  const found = await db
    .select({
      id: sourceDocuments.id,
      examId: sourceDocuments.examId,
      mode: sourceDocuments.mode,
    })
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
  const { examId, mode } = found[0]

  if (mode === 'new') {
    // この upload が auto 作成した exam を削除。 FK CASCADE
    // (source_documents.exam_id / cards.exam_id = ON DELETE CASCADE) により
    // 紐づく source_documents と cards は DB が連動削除する。 単一文のため
    // cascade 含め atomic。
    await db
      .delete(exams)
      .where(and(eq(exams.id, examId), eq(exams.userId, user.id)))
  } else {
    // 既存 exam への追加だった: exam は残し、 今回 OCR の cards と
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

  return { ok: true }
}
