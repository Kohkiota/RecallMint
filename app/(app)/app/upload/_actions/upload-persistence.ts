import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { setTenantContext } from '@/lib/db/tenant-tx'
import {
  cards,
  sourceDocuments,
  uploadRecords,
} from '@/lib/db/schema'
import { applyOcrTags } from '@/lib/tags/apply-ocr-tags'
import { bumpExamCardCount } from '@/lib/cards/card-count'
import { logger } from '@/lib/logger'

// 保存 tx: cards bulk INSERT + applyOcrTags (同 tx 採番) + exams.cardCount 加算。
// 1 関数 = 1 tx 保証。 applyOcrTags は必ずこの tx 内に留まる (同 tx 採番が競合安全の前提)。
export async function saveExtractedCards(
  db: ReturnType<typeof getDb>,
  args: {
    userId: string
    examId: string
    cardRows: Array<typeof cards.$inferInsert>
    customProps: Array<Parameters<typeof applyOcrTags>[2][number]['custom_props']>
  },
): Promise<Array<{ id: string; title: string }>> {
  return db.transaction(async (tx) => {
    // RLS-P2: owner-scoped tx の冒頭で tenant context (app.user_id GUC) を張る。
    await setTenantContext(tx, args.userId)
    const inserted = await tx
      .insert(cards)
      .values(args.cardRows)
      .returning({ id: cards.id, title: cards.title })
    await applyOcrTags(
      tx,
      args.userId,
      inserted.map((row, i) => ({
        id: row.id,
        custom_props: args.customProps[i],
      })),
    )
    await bumpExamCardCount(tx, {
      examId: args.examId,
      userId: args.userId,
      delta: args.cardRows.length,
    })
    return inserted
  })
}

// 完了 tx: source_documents を completed に更新 + upload_records 台帳 append。
// 1 関数 = 1 tx 保証。 cards INSERT 後に呼ばれ、 commit/rollback が一蓮托生。
export async function completeUploadTx(
  db: ReturnType<typeof getDb>,
  args: {
    sourceDocumentId: string
    userId: string
    filename: string
    totalSize: number
    totalPages: number
    cardsExtracted: number
    ocrCostYen: number
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    // RLS-P2: owner-scoped tx の冒頭で tenant context (app.user_id GUC) を張る。
    await setTenantContext(tx, args.userId)
    // Iso-0 §1.3: WHERE に user_id 述語を追加し cross-tenant write を塞ぐ。
    // 正常フローの sourceDocumentId は runUploadGuardTx が同一 user で INSERT した
    // owner-scoped な id ゆえ id/userId 一致で厳密 1 行。affected 0 行は所有権違反
    // または doc 不在なので完了 tx を確定させず throw (tx rollback で台帳も残さない)。
    const updated = await tx
      .update(sourceDocuments)
      .set({
        status: 'completed',
        pagesProcessed: args.totalPages,
        cardsExtracted: args.cardsExtracted,
        ocrCostYen: args.ocrCostYen,
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(sourceDocuments.id, args.sourceDocumentId),
          eq(sourceDocuments.userId, args.userId),
        ),
      )
      .returning({ id: sourceDocuments.id })
    if (updated.length === 0) {
      throw new Error(
        'completeUploadTx: source document not found or not owned by user',
      )
    }
    await tx.insert(uploadRecords).values({
      userId: args.userId,
      filename: args.filename,
      fileSizeBytes: args.totalSize,
      pagesProcessed: args.totalPages,
      ocrCostYen: args.ocrCostYen,
      status: 'completed',
    })
  })
}

// OCR 失敗時の後始末。 source_documents を status='failed' に更新し、 同 transaction
// で upload_records にも status='failed' 行を append する (台帳として失敗も記録、
// ただし月次 quota SUM は completed で絞るため消費には計上されない)。
// best-effort: 失敗しても throw せず logger.warn のみ (OCR 失敗 path の二次被害防止)。
export async function markFailed(
  sourceDocumentId: string,
  err: unknown,
  audit: {
    userId: string
    filename: string
    fileSizeBytes: number
    pagesProcessed: number
    ocrCostYen: number
  },
): Promise<void> {
  const db = getDb()
  const msg = err instanceof Error ? err.message : String(err)
  try {
    await db.transaction(async (tx) => {
      // RLS-P2: owner-scoped tx の冒頭で tenant context (app.user_id GUC) を張る。
      await setTenantContext(tx, audit.userId)
      // Iso-0 §1.3: WHERE に user_id 述語を追加し cross-tenant write を塞ぐ。
      // best-effort no-throw 契約は維持: affected 0 行 (所有権違反 or doc 不在) は
      // warn のみで台帳 (upload_records) を残さず tx を no-op 化する。
      const updated = await tx
        .update(sourceDocuments)
        .set({ status: 'failed', errorMessage: msg.slice(0, 500) })
        .where(
          and(
            eq(sourceDocuments.id, sourceDocumentId),
            eq(sourceDocuments.userId, audit.userId),
          ),
        )
        .returning({ id: sourceDocuments.id })
      if (updated.length === 0) {
        // 所有権違反 or doc 不在。spec の「warn に PII/機密 id を載せない」を厳格採用し、
        // 対象 doc id も acting userId も載せず event のみ記録する(Codex 独立 review が
        // 任意の persistent id を不可としたため最安全側へ寄せた。詳細相関が要れば OT 判断)。
        logger.warn({ event: 'source_documents.mark_failed.no_row' })
        return
      }
      await tx.insert(uploadRecords).values({
        userId: audit.userId,
        filename: audit.filename,
        fileSizeBytes: audit.fileSizeBytes,
        pagesProcessed: audit.pagesProcessed,
        ocrCostYen: audit.ocrCostYen,
        status: 'failed',
      })
    })
  } catch (updateErr) {
    // status='processing' のまま残るが、 ops 通知側で source_document_id を持つので
    // 後から OT が手動で update 可能。 巻き込み防止のため throw しない。
    // S1.9.1: 月次 quota は upload_records 集計のため、 source_documents が
    // processing 残骸として残っても消費計算には一切影響しない。
    logger.warn({
      event: 'source_documents.mark_failed.update_failed',
      sourceDocumentId,
      updateErr,
    })
  }
}
