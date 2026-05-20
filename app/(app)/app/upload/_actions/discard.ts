'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, notExists, sql } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { getDb } from '@/lib/db'
import { cards, exams, sourceDocuments } from '@/lib/db/schema'
import type { ActionResult } from '@/lib/actions/result'

// 「やり直し」 / 「ファイル変更して再試行」 用に、 直前の OCR 結果 (cards +
// source_documents) を物理削除する。 schema 上 cards.source_document_id は SET NULL
// 設計 (OCR 元削除しても card 保持) のため、 retry シナリオでは明示的に cards も
// 削除する必要がある。
//
// S1.9 案 B: autoCreatedExamId が渡された場合、 その exam が空 (cards 0 件 +
// source_documents 0 件) になったら exam 自体も削除する。 destination.mode==='new'
// で auto 作成された exam が retry / ファイル変更で空のまま /app/exams に残り続ける
// 問題への対処。 mode==='existing' (既存 exam への追加) では呼び出し側が
// autoCreatedExamId を渡さないため exam は残る。
//
// 安全性: 削除前に source_documents.user_id と現在の user.id が一致することを
// 確認する (他 user の data を消さない)。 exam 削除も WHERE user_id = ? + NOT EXISTS
// 2 条件で「他 user の exam」 「まだ中身のある exam」 を構造的に弾く。
export async function discardUpload(
  sourceDocumentId: string,
  autoCreatedExamId?: string,
): Promise<ActionResult> {
  // S1.8: discard で source_documents が消える → 月次残量が「戻る」 ため、
  // 戻り値前 (try/finally) で root layout 配下を一括 revalidate して
  // 残量 banner を即時新値で render する。
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

  // cards / source_documents / (条件付き) exam の削除を 1 transaction にまとめ、
  // 部分的に削除された不整合状態 (cards だけ消えて exam が残る等) を作らない。
  await db.transaction(async (tx) => {
    // cards 先に削除 (FK ON DELETE SET NULL のため source_document 削除では消えない)
    await tx.delete(cards).where(eq(cards.sourceDocumentId, sourceDocumentId))
    await tx
      .delete(sourceDocuments)
      .where(eq(sourceDocuments.id, sourceDocumentId))

    if (autoCreatedExamId) {
      // auto 作成 exam の掃除。 通常の retry / ファイル変更 path では、 この exam は
      // 当 upload で作られたばかりで他に cards / source_documents を持たないため
      // 必ず削除される。 NOT EXISTS 2 条件は防御的多重化で、 想定外に中身が残った
      // exam を誤削除しないための安全弁:
      //  - cards が 1 件でも残る exam は残す
      //  - 他 source_documents が紐づく exam は残す
      // user_id 一致条件で他 user の exam を構造的に保護。 上 2 DELETE が同
      // transaction 内で先行しているため、 この時点の NOT EXISTS は最新状態を見る。
      await tx
        .delete(exams)
        .where(
          and(
            eq(exams.id, autoCreatedExamId),
            eq(exams.userId, user.id),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(cards)
                .where(eq(cards.examId, autoCreatedExamId)),
            ),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(sourceDocuments)
                .where(eq(sourceDocuments.examId, autoCreatedExamId)),
            ),
          ),
        )
    }
  })

  return { ok: true }
}
