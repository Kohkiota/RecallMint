// ②-4a T14a: reconcileStaleProcessing の live upload_operations 除外(spec §11
// 「stale source 回収統合」)の実 PG 検証。
//
// 新 prepare→publish flow は prepared の再試行が STALE_PROCESSING_MS(15分)を
// 跨ぎうる — 「source failed → 後から publisher が completed へ戻す」矛盾を
// 避けるため、対象の source_document に紐づく upload_operations が live(非終端:
// awaiting_sources/claimed/prepared)行を 1 件でも持つ場合は stale sweep の対象
// から除外する。 upload_operations 行が無い legacy path は従来どおり failed 化
// される(挙動不変)ことも合わせて確認する。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { exams, sourceDocuments, uploadOperations, uploadRecords, users } from '@/lib/db/schema'
import { getExamStatusMap, reconcileStaleProcessing } from '@/lib/exams/source-doc-status'
import { PREPARED_RETENTION_MS, STALE_PROCESSING_MS } from '@/lib/exams/derive-exam-statuses'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const STALE_CREATED_AT = new Date(Date.now() - STALE_PROCESSING_MS - 60_000) // 16 分前

async function seedUser(): Promise<string> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_${userId}` })
  return userId
}

async function seedStaleProcessingSourceDoc(userId: string): Promise<{
  examId: string
  sourceDocumentId: string
}> {
  const owner = getFixtureOwnerDb()
  const examId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
  const sourceDocumentId = randomUUID()
  await owner.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'image',
    filename: 'a.png',
    fileSizeBytes: 1000,
    status: 'processing',
    createdAt: STALE_CREATED_AT,
  })
  return { examId, sourceDocumentId }
}

async function seedUploadOperation(
  userId: string,
  examId: string,
  sourceDocumentId: string,
  status:
    | 'awaiting_sources'
    | 'claimed'
    | 'prepared'
    | 'processing'
    | 'completed'
    | 'terminal_failed',
  overrides: Partial<{ createdAt: Date; leaseExpiresAt: Date | null }> = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId,
    idempotencyKey: `idem-${operationId}`,
    examId,
    sourceDocumentId,
    status,
    expectedSourceCount: 1,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
  })
  return operationId
}

async function readSourceDocStatus(sourceDocumentId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select({ status: sourceDocuments.status })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
  return rows[0]!.status
}

async function countUploadRecords(userId: string): Promise<number> {
  const owner = getFixtureOwnerDb()
  const rows = await owner.select().from(uploadRecords).where(eq(uploadRecords.userId, userId))
  return rows.length
}

beforeEach(async () => {
  await truncateAllUserTables()
})

describe('reconcileStaleProcessing — live upload_operations exclusion (T14a spec §11)', () => {
  it('legacy path (no upload_operations row): a stale processing source_document IS marked failed (existing behavior preserved)', async () => {
    const userId = await seedUser()
    const { sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)

    await reconcileStaleProcessing(userId)

    expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
    expect(await countUploadRecords(userId)).toBe(1)
  })

  // 'processing' = ②-4a 単一 invocation 経路(submit-upload.ts)の実行中状態。
  // reconciler の live 判定に含まれないと、sync phase 直後の source_document が
  // 15 分後に failed へ落ち、実行中の invocation の成果が巻き添えになる。
  it.each(['awaiting_sources', 'claimed', 'prepared', 'processing'] as const)(
    'a stale processing source_document WITH a live upload_operations row (status=%s) is NOT marked failed',
    async (liveStatus) => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, liveStatus)

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
      expect(await countUploadRecords(userId)).toBe(0)
    },
  )

  it.each(['completed', 'terminal_failed'] as const)(
    'a stale processing source_document whose only upload_operations row is TERMINAL (status=%s) IS still marked failed (not conflated with live)',
    async (terminalStatus) => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, terminalStatus)

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
      expect(await countUploadRecords(userId)).toBe(1)
    },
  )

  // --- window-aware exclusion (fix round 1 / Codex P1) ---
  // A non-terminal upload_operation only protects its source_document while it
  // is still "resumable" (within PREPARED_RETENTION_MS, or currently holding a
  // valid lease). Without this window, an ABANDONED non-terminal op (never
  // re-claimed — e.g. awaiting_sources a user never finished) would protect
  // its stale source_document FOREVER, since the 7-day cap only fires inside
  // claimOperationTx (which nobody calls for an abandoned op).
  describe('window-aware exclusion (past-retention ops must not protect forever)', () => {
    it('an ABANDONED non-terminal op (past PREPARED_RETENTION_MS, no valid lease) does NOT protect its stale source_document (source IS marked failed — closes the permanent-leak gap)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, 'awaiting_sources', {
        createdAt: new Date(Date.now() - PREPARED_RETENTION_MS - 60_000), // 7日+1分前
        leaseExpiresAt: null,
      })

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
      expect(await countUploadRecords(userId)).toBe(1)
    })

    it('a non-terminal op WITHIN PREPARED_RETENTION_MS (no valid lease) still protects its stale source_document (source stays processing)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, 'claimed', {
        createdAt: new Date(Date.now() - (PREPARED_RETENTION_MS - 60_000)), // 7日-1分前
        leaseExpiresAt: null,
      })

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
      expect(await countUploadRecords(userId)).toBe(0)
    })

    it('a non-terminal op PAST retention but with a currently VALID lease still protects its stale source_document (a concurrently-advancing op must not be swept)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, 'claimed', {
        createdAt: new Date(Date.now() - PREPARED_RETENTION_MS - 60_000), // past retention
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // still valid
      })

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
      expect(await countUploadRecords(userId)).toBe(0)
    })
  })

  it('a NON-stale (recent) processing source_document is left untouched regardless of upload_operations', async () => {
    const userId = await seedUser()
    const owner = getFixtureOwnerDb()
    const examId = randomUUID()
    await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
    const sourceDocumentId = randomUUID()
    await owner.insert(sourceDocuments).values({
      id: sourceDocumentId,
      userId,
      examId,
      mode: 'new',
      fileType: 'image',
      filename: 'a.png',
      fileSizeBytes: 1000,
      status: 'processing',
      // createdAt はデフォルト(たった今) — stale 閾値未満。
    })

    await reconcileStaleProcessing(userId)

    expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
    expect(await countUploadRecords(userId)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getExamStatusMap — display op-awareness (T14a fix round 2 / Codex P2#1)
// ---------------------------------------------------------------------------
// The window-aware reconciler (above) correctly keeps a live-op source
// 'processing' in the DB, but the display fallback (deriveExamStatuses, via
// getExamStatusMap) independently recomputes "processing AND >15min → failed"
// from raw rows — without live-op awareness, a live retryable/prepared op's
// exam would show a "failed" badge for up to PREPARED_RETENTION_MS (7 days)
// even though the DB row is still 'processing'. These tests exercise the
// real DB query getExamStatusMap now runs (isLiveUploadOperationCondition)
// to source that awareness, reusing the same seed helpers as the reconciler
// tests above (same predicate, same DB module).
describe('getExamStatusMap — live-op display awareness (T14a fix round 2)', () => {
  it('a stale (>15min) processing source_document WITH a live upload_operations row displays as "processing", not "failed"', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
    await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared')

    const statuses = await getExamStatusMap(userId)

    expect(statuses.get(examId)).toBe('processing')
    // the underlying DB row is untouched by this read-only call.
    expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
  })

  it('legacy path (no upload_operations row): a stale (>15min) processing source_document still displays as "failed" (no display regression)', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)

    const statuses = await getExamStatusMap(userId)

    expect(statuses.get(examId)).toBe('failed')
    expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing') // DB row unchanged (read-only)
  })

  it('an ABANDONED non-terminal op (past PREPARED_RETENTION_MS, no valid lease) does NOT protect the display either — still "failed" (consistent with the reconciler)', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
    await seedUploadOperation(userId, examId, sourceDocumentId, 'awaiting_sources', {
      createdAt: new Date(Date.now() - PREPARED_RETENTION_MS - 60_000),
      leaseExpiresAt: null,
    })

    const statuses = await getExamStatusMap(userId)

    expect(statuses.get(examId)).toBe('failed')
  })

  it('a non-terminal op with a currently VALID lease protects the display even past retention (concurrently-advancing op shows "processing")', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
    await seedUploadOperation(userId, examId, sourceDocumentId, 'claimed', {
      createdAt: new Date(Date.now() - PREPARED_RETENTION_MS - 60_000),
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })

    const statuses = await getExamStatusMap(userId)

    expect(statuses.get(examId)).toBe('processing')
  })

  it('a fresh (<15min) processing source_document displays as "processing" regardless of live-op state (unaffected by this fix)', async () => {
    const userId = await seedUser()
    const owner = getFixtureOwnerDb()
    const examId = randomUUID()
    await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
    const sourceDocumentId = randomUUID()
    await owner.insert(sourceDocuments).values({
      id: sourceDocumentId,
      userId,
      examId,
      mode: 'new',
      fileType: 'image',
      filename: 'a.png',
      fileSizeBytes: 1000,
      status: 'processing',
      // createdAt デフォルト(たった今)。
    })

    const statuses = await getExamStatusMap(userId)

    expect(statuses.get(examId)).toBe('processing')
  })
})
