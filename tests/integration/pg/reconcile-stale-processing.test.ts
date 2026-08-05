// ②-4a T14a / S-4: reconcileStaleProcessing の live upload_operations 除外
// (spec 2026-08-04 §5)の実 PG 検証。
//
// 対象の source_document に紐づく upload_operations が **live(非終端 かつ valid
// lease を保持)** な行を 1 件でも持つ場合は stale sweep の対象から除外する
// (「source failed → 後から publisher が completed へ戻す」矛盾を避ける)。
// upload_operations 行が無い legacy path は従来どおり failed 化される。
//
// **S-4 の仕様変更**: 旧述語の「created_at が PREPARED_RETENTION_MS(7 日)以内
// なら lease 無しでも live」枝を撤去した。 その枝の存在理由は旧 flow の resume
// (retryable prepared を後から再 claim して再開)であり、新経路は resume を
// 持たない(失敗は全て terminal)ため根拠ごと消滅している。 lease だけが「今この
// オペレーションを進めている invocation が生存している」表明。
//
// **S-4 の追加**: doc を failed 化したとき、同一 tx で対応する非終端 op も
// terminal 化する(after() の callback が一度も走らない窓の唯一の収束点)。
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

async function readOperation(operationId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select()
    .from(uploadOperations)
    .where(eq(uploadOperations.id, operationId))
  return rows[0]!
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
  // **S-4: live = 非終端 かつ valid lease**(lease が唯一の生存表明)。
  it.each(['awaiting_sources', 'claimed', 'prepared', 'processing'] as const)(
    'a stale processing source_document WITH a live upload_operations row (status=%s, valid lease) is NOT marked failed',
    async (liveStatus) => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, liveStatus, {
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      })

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

  // --- lease-only exclusion (S-4 の仕様変更) ---
  // 非終端 upload_operation が source_document を守るのは **valid lease を保持して
  // いる間だけ**。 lease が失効 / NULL の非終端行は、再開する主体が居ない以上
  // 「実行中」ではない。 旧述語の 7 日 window(created_at 基準)は resume 廃止で
  // 根拠が消えたため撤去した。
  describe('lease-only exclusion (S-4: 7 日 window の撤去)', () => {
    it('an ABANDONED non-terminal op (no valid lease) does NOT protect its stale source_document', async () => {
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

    // **仕様変更**: 旧実装ではここが「保護される」だった(created_at が 7 日以内)。
    // 新経路に resume は無く、lease を持たない非終端 op は誰にも進められない。
    it('a RECENT non-terminal op with NO valid lease no longer protects its stale source_document (S-4: 7 日 window 撤去)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, 'claimed', {
        createdAt: new Date(Date.now() - (PREPARED_RETENTION_MS - 60_000)), // 7日-1分前
        leaseExpiresAt: null,
      })

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
      expect(await countUploadRecords(userId)).toBe(1)
    })

    it('an EXPIRED lease does not protect either (NULL と失効を同じ扱いにする)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, 'processing', {
        leaseExpiresAt: new Date(Date.now() - 60_000), // 失効済
      })

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
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

  // --- S-4: doc failed 化と同時に op も terminal 化する ---
  // after() の callback が一度も走らない窓(登録直後の hard-death / platform kill)は
  // op を終端化する主体を持たない。 lease 失効後のこの reconciler が唯一の収束点。
  describe('op terminalization (S-4・spec 2026-08-04 §5)', () => {
    it.each(['awaiting_sources', 'claimed', 'prepared', 'processing'] as const)(
      'failed 化した doc に紐づく非終端 op (status=%s) を terminal_failed にする',
      async (status) => {
        const userId = await seedUser()
        const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
        const operationId = await seedUploadOperation(
          userId,
          examId,
          sourceDocumentId,
          status,
          { leaseExpiresAt: new Date(Date.now() - 60_000) }, // 失効済 = 保護されない
        )
        await getFixtureOwnerDb()
          .update(uploadOperations)
          .set({ preparedPayload: { schemaVersion: 1, marker: 'pii' } })
          .where(eq(uploadOperations.id, operationId))

        await reconcileStaleProcessing(userId)

        expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
        const op = await readOperation(operationId)
        expect(op.status).toBe('terminal_failed')
        expect(op.lastErrorCode).toBe('stale_reconciled')
        // PII/機微(prepared_payload)と lease は NULL 化する
        // (terminalizeAbandonedOperation と同じ不変条件)。
        expect(op.preparedPayload).toBeNull()
        expect(op.leaseExpiresAt).toBeNull()
        expect(op.nextRetryAt).toBeNull()
      },
    )

    // **3VL 罠の検出点(fix round 3 / Codex P1)**: 文 2 の生存ガードを
    // `lease_expires_at <= now()` だけで書くと、`lease_expires_at IS NULL`
    // (旧経路 awaiting_sources の支配的状態)で NULL → WHERE 偽 となり、**回収したい
    // 行を 1 件も拾わなくなる**(gc-abandoned-operations.ts の T14a fix round 3 と同型)。
    // 上の it.each は失効済(非 NULL)lease で seed しているためこの罠を検出できない —
    // NULL lease を別途 pin する。
    it('lease が NULL の非終端 op も terminal 化する(NULL を「生きていない」側に倒す)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      const operationId = await seedUploadOperation(
        userId,
        examId,
        sourceDocumentId,
        'awaiting_sources',
        { leaseExpiresAt: null },
      )

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
      const op = await readOperation(operationId)
      expect(op.status).toBe('terminal_failed')
      expect(op.lastErrorCode).toBe('stale_reconciled')
    })

    // 文 2 単体の生存ガード(fix round 3 / Codex P1)。 READ COMMITTED では同一 tx でも
    // 文ごとにスナップショットが進むため、文 1 の NOT EXISTS 通過は文 2 の時点の生存を
    // 保証しない。 **文間の race 自体は単一スレッドの test で決定的に再現できない**
    // (文 1 と文 2 の間に別 tx の commit を挟む注入点が無い)ので、ここで pin できるのは
    // 「valid lease を持つ op は文 2 の WHERE に合致しない」という条件そのものまで。
    // 罠(NULL 落ち)の検出は上の test が担う。
    it('valid lease を持つ op は terminal 化されない(文 2 の生存ガード)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      // 同じ user の別 doc も stale にして、文 1 が実際に 1 件 failed 化する状況を作る
      // (updated が空だと文 2 に到達しないため)。
      const dead = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, dead.examId, dead.sourceDocumentId, 'processing', {
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      const liveOpId = await seedUploadOperation(
        userId,
        examId,
        sourceDocumentId,
        'processing',
        { leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
      )

      await reconcileStaleProcessing(userId)

      // live op の doc は文 1 で守られ、その op も無傷。
      expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
      const live = await readOperation(liveOpId)
      expect(live.status).toBe('processing')
      expect(live.leaseExpiresAt).not.toBeNull()
      // 一方で失効 lease の doc / op は回収されている(文 2 が実際に走ったことの確認)。
      expect(await readSourceDocStatus(dead.sourceDocumentId)).toBe('failed')
    })

    it.each(['completed', 'terminal_failed'] as const)(
      '終端 op (status=%s) は書き換えない(結果を上書きしない)',
      async (status) => {
        const userId = await seedUser()
        const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
        const operationId = await seedUploadOperation(
          userId,
          examId,
          sourceDocumentId,
          status,
        )

        await reconcileStaleProcessing(userId)

        expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
        const op = await readOperation(operationId)
        expect(op.status).toBe(status)
        expect(op.lastErrorCode).toBeNull()
      },
    )

    it('別テナントの非終端 op は terminal 化しない(owner-scope)', async () => {
      const userId = await seedUser()
      const otherUserId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      await seedUploadOperation(userId, examId, sourceDocumentId, 'processing', {
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      // 別テナントの stale doc + 非終端 op(こちらは触られてはいけない)。
      const other = await seedStaleProcessingSourceDoc(otherUserId)
      const otherOpId = await seedUploadOperation(
        otherUserId,
        other.examId,
        other.sourceDocumentId,
        'processing',
        { leaseExpiresAt: new Date(Date.now() - 60_000) },
      )

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(other.sourceDocumentId)).toBe('processing')
      expect((await readOperation(otherOpId)).status).toBe('processing')
    })

    it('protect された doc の op は触らない(live op を終端化しない)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      const operationId = await seedUploadOperation(
        userId,
        examId,
        sourceDocumentId,
        'processing',
        { leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
      )

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('processing')
      expect((await readOperation(operationId)).status).toBe('processing')
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
    await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared', {
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // S-4: live = valid lease
    })

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

  it('an ABANDONED non-terminal op (no valid lease) does NOT protect the display either — still "failed" (consistent with the reconciler)', async () => {
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
