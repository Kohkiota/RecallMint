// ②-4a T14a / S-4: reconcileStaleProcessing の live upload_operations 除外
// (spec 2026-08-04 §5)の実 PG 検証。
//
// 対象の source_document に紐づく upload_operations が **live(非終端 かつ valid
// lease を保持)** な行を 1 件でも持つ場合は stale sweep の対象から除外する
// (「source failed → 後から publisher が completed へ戻す」矛盾を避ける)。
// upload_operations 行が無い legacy path は従来どおり failed 化される。
//
// **S-4 の仕様変更**: 旧述語の「created_at が 7 日以内なら lease 無しでも live」
// 枝を撤去した。 その枝の存在理由は旧 flow の resume(retryable prepared を後から
// 再 claim して再開)であり、新経路は resume を持たない(失敗は全て terminal)ため
// 根拠ごと消滅している。 lease だけが「今この
// オペレーションを進めている invocation が生存している」表明。
//
// **S-4 の追加**: doc を failed 化したとき、同一 tx で対応する非終端 op も
// terminal 化する(after() の callback が一度も走らない窓の唯一の収束点)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { exams, sourceDocuments, uploadOperations, uploadRecords, users } from '@/lib/db/schema'
import { getExamStatusMap, reconcileStaleProcessing } from '@/lib/exams/source-doc-status'
import { STALE_PROCESSING_MS } from '@/lib/exams/derive-exam-statuses'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const STALE_CREATED_AT = new Date(Date.now() - STALE_PROCESSING_MS - 60_000) // 16 分前
// S-4 で live 述語から created_at window が外れたため、op の年齢は保護の有無に
// 影響しない。 かつて 7 日 window の境界だった値の前後を使い、「年齢では変わらない」
// ことを実証する。
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

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
  status: 'prepared' | 'processing' | 'completed' | 'terminal_failed',
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
  it.each(['prepared', 'processing'] as const)(
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
      await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared', {
        createdAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000), // 7日+1分前
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
      await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared', {
        createdAt: new Date(Date.now() - (SEVEN_DAYS_MS - 60_000)), // 7日-1分前
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
      await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared', {
        createdAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000), // 7日+1分前
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
    it.each(['prepared', 'processing'] as const)(
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
      },
    )

    // **3VL 罠の検出点(fix round 3 / Codex P1)**: 文 2 の生存ガードを
    // `lease_expires_at <= now()` だけで書くと、`lease_expires_at IS NULL` で
    // NULL → WHERE 偽 となり、**回収したい行を 1 件も拾わなくなる**
    // (gc-abandoned-operations.ts の T14a fix round 3 と同型)。
    // 上の it.each は失効済(非 NULL)lease で seed しているためこの罠を検出できない —
    // NULL lease を別途 pin する。
    // **S-5b**: seed status を旧経路の値から `prepared` へ付け替えた。
    // lease NULL は status に依存せず起きうる状態(terminalize が lease を NULL 化する /
    // 途中で落ちた invocation)で、検出したい罠は「NULL 枝の脱落」そのものゆえ、
    // 付け替えで assert は空振りしない(生存ガードの `isNull(...)` を外すと fail する)。
    it('lease が NULL の非終端 op も terminal 化する(NULL を「生きていない」側に倒す)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      const operationId = await seedUploadOperation(
        userId,
        examId,
        sourceDocumentId,
        'prepared',
        { leaseExpiresAt: null },
      )

      await reconcileStaleProcessing(userId)

      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
      const op = await readOperation(operationId)
      expect(op.status).toBe('terminal_failed')
      expect(op.lastErrorCode).toBe('stale_reconciled')
    })

    // **文 2 の生存ガードの検出力**(S-5b で追加・fix round 3 / Codex P1 の守り)。
    //
    // 文 1(doc の UPDATE)は `NOT EXISTS(live op)` を通った doc だけを failed にする
    // ため、**単に seed を並べただけでは live op が文 2 に到達しない** — 文 2 の
    // WHERE から生存ガードを丸ごと外しても、下の「seed だけ」の test 群は全て green の
    // ままだった(実測)。 つまりガードは無検証のまま静かに失効しうる。
    //
    // ガードが守っているのは **READ COMMITTED で文ごとにスナップショットが進む**こと
    // (文 1 の判定後・文 2 の実行前に別 tx が lease を張り直す)であり、別接続では
    // その窓を決定的に狙えない。 そこで **同一 tx 内で文 1 の直後に lease を張り直す**
    // AFTER UPDATE trigger を test 側で仕込み、同じ状態遷移を決定的に再現する
    // (自 tx の変更は次の文のスナップショットに必ず見えるため、文 2 は「今 live な op」を
    // 見ることになる = 実運用の race と同じ入力)。
    //
    // 期待: ガードがあれば terminal 化しない / ガードを外すと terminal 化して fail する。
    it('文 1 の後に lease が張り直された op は terminal 化しない(文 2 の生存ガード・同一 tx 注入)', async () => {
      const userId = await seedUser()
      const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
      const operationId = await seedUploadOperation(
        userId,
        examId,
        sourceDocumentId,
        'processing',
        { leaseExpiresAt: new Date(Date.now() - 60_000) }, // 文 1 の時点では失効済
      )

      const owner = getFixtureOwnerDb()
      await owner.execute(sql`
        CREATE OR REPLACE FUNCTION test_renew_lease_after_doc_failed() RETURNS trigger AS $$
        BEGIN
          UPDATE upload_operations
          SET lease_expires_at = now() + interval '10 minutes'
          WHERE source_document_id = NEW.id;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `)
      await owner.execute(sql`
        CREATE TRIGGER test_renew_lease_trigger
        AFTER UPDATE ON source_documents
        FOR EACH ROW WHEN (NEW.status = 'failed')
        EXECUTE FUNCTION test_renew_lease_after_doc_failed()
      `)
      try {
        await reconcileStaleProcessing(userId)
      } finally {
        await owner.execute(sql`DROP TRIGGER IF EXISTS test_renew_lease_trigger ON source_documents`)
        await owner.execute(sql`DROP FUNCTION IF EXISTS test_renew_lease_after_doc_failed()`)
      }

      // 文 1 は doc を failed にした(trigger が発火した証跡)。
      expect(await readSourceDocStatus(sourceDocumentId)).toBe('failed')
      // 文 2 は「今 live な op」を上書きしない。
      const op = await readOperation(operationId)
      expect(op.status).toBe('processing')
      expect(op.lastErrorCode).toBeNull()
      expect(op.preparedPayload).toBeNull() // 元から NULL(上書きされていないことの確認)
    })

    // 文 1 側の保護(live op を持つ doc は failed にしない)。 文 2 まで到達しない
    // 経路の pin であり、上の trigger test とは見ているものが違う。
    it('valid lease を持つ op の doc は文 1 で守られ、op も無傷(文 1 の保護)', async () => {
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
// exam would show a "failed" badge even though the DB row is still
// 'processing'. These tests exercise the
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
    await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared', {
      createdAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000),
      leaseExpiresAt: null,
    })

    const statuses = await getExamStatusMap(userId)

    expect(statuses.get(examId)).toBe('failed')
  })

  it('a non-terminal op with a currently VALID lease protects the display even past retention (concurrently-advancing op shows "processing")', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedStaleProcessingSourceDoc(userId)
    await seedUploadOperation(userId, examId, sourceDocumentId, 'prepared', {
      createdAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000),
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
