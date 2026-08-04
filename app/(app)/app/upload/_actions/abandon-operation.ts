'use server'

import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/ensure-user'
import { UnauthenticatedError } from '@/lib/auth/errors'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'
import { uploadOperations, type User } from '@/lib/db/schema'
import {
  failSourceDocumentForTerminalOp,
  terminalizeAbandonedOperation,
} from '../_lib/terminalize-abandoned-operation'
import { purgeOperationSources, purgeOperationSourcesForOp } from '@/lib/media/source-purge'

// ②-4a-cutover 案 D(2026-08-02・OT 確定): UI は失敗した operation を resume せず
// 「失敗表示時に abandon」する(1 submit = 1 operation)。この action は client が
// 保持する operation を終端化して掃除する。claimed / prepared は client が現在の
// lease_version を保持している時だけ terminal 化する(別 worker / takeover が進めて
// いる operation を clobber しないための fencing)。awaiting_sources は lease 概念が
// ないため lease 照合不要。completed は上書きしない(transport lost success の可能性
// があり、既存結果へ誘導するため sourceDocumentId を返す)。既に terminal は冪等成功。

const operationIdSchema = z.uuid()

export type AbandonUploadOperationInput = {
  operationId: string
  // claim 済みの UI のみが保持する fencing token(この operation の正当な所有者証明)。
  leaseVersion?: number
}

export type AbandonUploadOperationResult =
  // 終端化した(または既に terminal だった = 冪等)。
  | { outcome: 'abandoned' }
  // 既に completed。上書きせず既存結果へ誘導する。
  | { outcome: 'completed'; sourceDocumentId: string | null }
  // claimed / prepared だが client が正当な lease_version を保持していない
  // (別 worker/takeover の可能性)→ clobber しない。
  | { outcome: 'stale' }
  | { outcome: 'not_found' }
  | { outcome: 'unauthenticated' }

export async function abandonUploadOperationTx(
  tx: TenantTx,
  user: Pick<User, 'id'>,
  input: AbandonUploadOperationInput,
): Promise<AbandonUploadOperationResult> {
  // 不正形式 id は定義上 DB に存在し得ない(claim-operation.ts と同じ理由: 非 UUID を
  // 素通しすると Postgres cast error で 500 化する)。
  if (!operationIdSchema.safeParse(input.operationId).success) {
    return { outcome: 'not_found' }
  }

  // owner-scope で行を lock(claim-operation と同規律の pessimistic lock。並行 claim/
  // takeover とのレースを行ロックで直列化する)。
  const rows = await tx
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      sourceDocumentId: uploadOperations.sourceDocumentId,
    })
    .from(uploadOperations)
    .where(
      and(
        eq(uploadOperations.id, input.operationId),
        eq(uploadOperations.userId, user.id),
      ),
    )
    .for('update')

  const op = rows[0]
  if (!op) return { outcome: 'not_found' }

  // completed は上書きしない(spec §2 冪等 replay。transport lost success の可能性が
  // あり、既存結果へ誘導するため sourceDocumentId を返す)。
  if (op.status === 'completed') {
    return { outcome: 'completed', sourceDocumentId: op.sourceDocumentId }
  }
  // 既に terminal は冪等成功。ただし server-side terminalize 経路(claim/stage/publish の
  // terminal_failed)は op のみ終端化し source_document を processing のまま残すため、
  // legacy 共存 gate の 15 分 block を避けるべく doc を冪等に failed 化する。op の
  // lastErrorCode/resultSummary は元の失敗理由を保持するため上書きしない(doc のみ)。
  if (op.status === 'terminal_failed') {
    await failSourceDocumentForTerminalOp(
      tx,
      user.id,
      op.sourceDocumentId,
      'operation terminal_failed',
    )
    return { outcome: 'abandoned' }
  }
  // claimed / prepared は client が現在の lease_version を保持している時だけ終端化する
  // (別 worker/takeover が進めている operation を clobber しない fencing)。lease の
  // 有効/期限切れは問わない — 版一致が「この UI が最後の claim 者」であることの証明。
  if (op.status === 'claimed' || op.status === 'prepared') {
    if (input.leaseVersion === undefined || op.leaseVersion !== input.leaseVersion) {
      return { outcome: 'stale' }
    }
  }
  // awaiting_sources、または lease 一致の claimed/prepared → 終端化 + doc failed。
  await terminalizeAbandonedOperation(
    tx,
    user.id,
    { operationId: input.operationId, sourceDocumentId: op.sourceDocumentId },
    'abandoned',
  )
  return { outcome: 'abandoned' }
}

async function currentUserOrNull(): Promise<User | null> {
  try {
    return await getCurrentUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null
    throw e
  }
}

// ②-4a Task 14b′(主経路・post-commit): abandonUploadOperationTx は同一 ambient
// tx 内(terminalizeAbandonedOperation・fresh 遷移)または「既に terminal」
// (冪等 replay・doc-status fixup のみ)のいずれでも 'abandoned' を返す —
// claim-operation.ts と同じ理由で型上区別しない。purgeOperationSourcesForOp は
// 冪等なので両ケースとも呼んで安全(source-purge.ts のコメント参照)。
// 'completed' 分岐は既に sourceDocumentId を保持しているため re-query 不要
// (このケースは本来 publishPreparedUpload 自身の主経路で既に purge 済のはずだが、
// 万一の main-path miss に対する defense-in-depth として呼ぶ)。
export async function abandonUploadOperation(
  input: AbandonUploadOperationInput,
): Promise<AbandonUploadOperationResult> {
  if (typeof input !== 'object' || input === null) {
    return { outcome: 'not_found' }
  }
  const user = await currentUserOrNull()
  if (!user) return { outcome: 'unauthenticated' }
  const result = await withTenantTx(user.id, (tx) => abandonUploadOperationTx(tx, user, input))
  if (result.outcome === 'abandoned') {
    await purgeOperationSourcesForOp(user.id, input.operationId)
  } else if (result.outcome === 'completed' && result.sourceDocumentId) {
    await purgeOperationSources(user.id, result.sourceDocumentId)
  }
  return result
}
