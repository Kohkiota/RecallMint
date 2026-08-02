import { and, eq } from 'drizzle-orm'

import { sourceDocuments, uploadOperations } from '@/lib/db/schema'
import type { TenantTx } from '@/lib/db/tenant-tx'

// ②-4a-cutover 案 D(2026-08-02・OT 確定)の abandon 不変条件。abandon(失敗表示時)と
// prepareUploadTx の supersede(fresh key を受けた際の旧 op 掃除)の 2 経路が共有する
// 単一の executable contract(architecture.md §8: 同一不変条件は同一 contract。部分模倣
// しない)。
//
// 不変条件 = 非終端 operation を terminal_failed へ確定し、prepared_payload(PII/機微)と
// lease/next_retry を NULL 化し、**同一 tx で** 関連 source_document を failed 化する。
// source_document を failed にしないと legacy 共存 gate(prepare-upload.ts の
// status='processing' 検出)に引っかかり最大 STALE_PROCESSING_MS(15分)in_progress が
// 継続する(OT 2026-08-02 critical 副次発見)。
//
// 呼出元が対象 operation を owner-scope で lock 済み(SELECT…FOR UPDATE)である前提。
// ゆえに op の UPDATE の WHERE は id+userId のみ(claim-operation.ts:persistTerminalFailure
// と同規律 — 行ロック保持中は status ガード不要)。
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
      nextRetryAt: null,
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
// 条件の単一 contract。terminalizeAbandonedOperation(abandon/supersede が非終端 op を
// 終端化する経路)と、abandonUploadOperation の「既に terminal」経路(claim/stage/publish の
// server-side terminalize が op のみ終端化し doc を processing に残した後始末)の両方が使う。
// doc を processing のまま残すと legacy 共存 gate(prepare-upload.ts の status='processing'
// 検出)で最大 STALE_PROCESSING_MS(15分)in_progress が継続する。
// `status='processing'` の行のみ flip する(completed を誤って failed 化しない・idempotent)。
export async function failSourceDocumentForTerminalOp(
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
