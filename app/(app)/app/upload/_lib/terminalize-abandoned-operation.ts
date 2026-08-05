import { and, eq } from 'drizzle-orm'

import { sourceDocuments, uploadOperations } from '@/lib/db/schema'
import type { TenantTx } from '@/lib/db/tenant-tx'

// ②-4a-cutover 案 D(2026-08-02・OT 確定)の abandon 不変条件。`submitUploadTx` の
// supersede(fresh key を受けた際の旧 op 掃除)と `upload-pipeline.ts` の terminalize
// (pipeline が失敗を確定させる経路)の 2 経路が共有する単一の executable contract
// (architecture.md §8: 同一不変条件は同一 contract。部分模倣しない)。
//
// 不変条件 = 非終端 operation を terminal_failed へ確定し、prepared_payload(PII/機微)と
// lease を NULL 化し、**同一 tx で** 関連 source_document を failed 化する。
// source_document を failed にしないと、doc 側だけが 'processing' で取り残され、
// 表示 fallback / stale sweep が「まだ実行中」と読める行を見続ける
// (OT 2026-08-02 critical 副次発見)。
//
// **呼出元が対象 operation を owner-scope で lock 済み(SELECT…FOR UPDATE)である前提**。
// ゆえに op の UPDATE の WHERE は id+userId のみ(行ロック保持中は status ガード不要)。
//
// **同じ不変条件を書く実装はもう 1 箇所ある**(`lib/exams/source-doc-status.ts` の
// `reconcileStaleProcessing` 文 2)。**意図的に統合していない**(S-5b 追加項目 B・
// controller 裁定)。向こうは行ロックを取らず「lease が無い or 失効」を WHERE 条件で
// 守る前提で、この関数の「呼出元がロック済み」前提と噛み合わない — 1 本に寄せると
// その生存ガードが silent に失効しうる。加えて eslint Block A(`lib/` は `app/` を
// import 禁止)により共有には contract の `lib/` 移設が要る。**実装 site は計 2 つ**で
// rule of three にも達しない。**片方を変えるときは必ず向こうも読むこと。**
export async function terminalizeAbandonedOperation(
  tx: TenantTx,
  userId: string,
  op: { operationId: string; sourceDocumentId: string | null },
  lastErrorCode: string,
): Promise<void> {
  await tx
    .update(uploadOperations)
    .set({
      status: 'terminal_failed',
      preparedPayload: null,
      leaseExpiresAt: null,
      lastErrorCode,
      resultSummary: { reason: lastErrorCode },
    })
    .where(
      and(eq(uploadOperations.id, op.operationId), eq(uploadOperations.userId, userId)),
    )

  await failSourceDocumentForTerminalOp(
    tx,
    userId,
    op.sourceDocumentId,
    `operation ${lastErrorCode}`,
  )
}

// 「terminal な operation の source_document は failed であって processing ではない」不変
// 条件の単一 contract。doc を processing のまま残すと、表示 fallback
// (deriveExamStatuses)と stale sweep が最大 STALE_PROCESSING_MS(15 分)「処理中」を
// 見続ける。
// `status='processing'` の行のみ flip する(completed を誤って failed 化しない・idempotent)。
async function failSourceDocumentForTerminalOp(
  tx: TenantTx,
  userId: string,
  sourceDocumentId: string | null,
  errorMessage: string,
): Promise<void> {
  if (sourceDocumentId === null) return
  await tx
    .update(sourceDocuments)
    .set({ status: 'failed', errorMessage })
    .where(
      and(
        eq(sourceDocuments.id, sourceDocumentId),
        eq(sourceDocuments.userId, userId),
        eq(sourceDocuments.status, 'processing'),
      ),
    )
}
