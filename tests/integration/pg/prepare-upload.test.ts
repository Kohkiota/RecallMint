// ②-4a Phase B Task 4 (2026-07-31 改訂): prepareUpload の tx 本体 (prepareUploadTx) の
// 実 PG 検証。1 tx で advisory lock → idempotency → live-operation gate → 全体サイズ
// 早期検査 → 入力検証 → operation(awaiting_sources) + exam(new/existing) +
// source_document(processing) + source_asset(reserved, lean 列のみ)を作ることを
// 確認する(spec §2/§3/§6.1)。
//
// prepareUploadTx は Clerk 認証を持たない (upload-guard.ts の runUploadGuardTx と
// 同型 — tx と user を呼出側から受け取るだけ) ため asTenant + Pick<User,'id'> で
// 直接 exercise できる。 外側の prepareUpload (Clerk 経由) はこの iso suite の対象外。
//
// advisory lock の真の OS レベル並行性 (2 接続が同時に同じ hashtext を取り合う) は
// iso で決定的に再現しづらいため対象外とする。同時 1 upload 制限は live-operation
// gate (別 key の非終端 operation があれば in_progress) で担保され、そちらは
// 決定的にテストできる。
//
// mutating test ゆえ beforeEach で truncate→seed(各 test を clean state から)。
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import {
  exams,
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  users,
} from '@/lib/db/schema'
import { TOTAL_UPLOAD_LIMIT_BYTES } from '@/app/(app)/app/upload/_lib/constants'
import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { STALE_PROCESSING_MS } from '@/lib/exams/derive-exam-statuses'

const { mockGetCurrentUser, mockDeleteObject } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockDeleteObject: vi.fn(),
}))

// prepareUpload(外側 wrapper)は既存 test(malformed input guard)がすでに
// Clerk mock 無しで直接呼んでいる(currentUserOrNull() より前に return する
// 分岐のみ)。 ②-4a Task 14b′ の completeness test はここで初めて Clerk を
// 実際に通す必要があるため、file 全体にこの mock を追加する(既存 test は
// mock 追加後も無影響 — 呼ばれない分岐のため)。
vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))
// deleteObject: purgeOperationSources(prepareUpload wrapper が supersede 後に
// 呼ぶ)向け。
vi.mock('@/lib/storage/r2', () => ({
  deleteObject: mockDeleteObject,
}))

// vi.mock は import より前に hoist される。
import {
  prepareUpload,
  prepareUploadTx,
  type PrepareUploadInput,
} from '@/app/(app)/app/upload/_actions/prepare-upload'

import { asTenant } from './setup/as-tenant'
import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

function twoSources(prefix: string): PrepareUploadInput['sources'] {
  return [
    {
      sourceId: 's1',
      mime: 'image/png',
      byteSize: 1000,
      width: 100,
      height: 200,
      filename: `${prefix}-1.png`,
    },
    {
      sourceId: 's2',
      mime: 'image/jpeg',
      byteSize: 2000,
      width: 300,
      height: 400,
      filename: `${prefix}-2.jpg`,
    },
  ]
}

async function noWritesFor(userId: string): Promise<void> {
  const owner = getFixtureOwnerDb()
  const opRows = await owner
    .select({ id: uploadOperations.id })
    .from(uploadOperations)
    .where(eq(uploadOperations.userId, userId))
  expect(opRows).toHaveLength(0)
  const docRows = await owner
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.userId, userId))
  expect(docRows).toHaveLength(0)
  const assetRows = await owner
    .select({ id: sourceAssets.id })
    .from(sourceAssets)
    .where(eq(sourceAssets.userId, userId))
  expect(assetRows).toHaveLength(0)
}

describe('prepareUploadTx (T4, 2026-07-31 改訂)', () => {
  let userAId: string
  let userBId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetCurrentUser.mockReset()
    mockDeleteObject.mockReset()
    mockDeleteObject.mockResolvedValue({ ok: true, status: 200 })
    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
  })

  // --- (a) 新規 exam 経路: lean reservation ---
  describe('new-exam path', () => {
    it('creates operation(awaiting_sources) + exam + source_document + lean reservations in one tx', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-new-1',
        destination: { mode: 'new' },
        sources: twoSources('new'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )

      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }
      expect(result.reserved).toHaveLength(2)

      const owner = getFixtureOwnerDb()

      // exam: 新規作成・JST date + HH:mm 形式の仮 name
      const examRows = await owner
        .select({ id: exams.id, name: exams.name, userId: exams.userId })
        .from(exams)
        .where(eq(exams.id, result.examId))
      expect(examRows).toHaveLength(1)
      expect(examRows[0]?.userId).toBe(userAId)
      expect(examRows[0]?.name).toBe(result.examName)
      expect(examRows[0]?.name).toMatch(/^アップロード \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

      // source_document: status='processing', fileType='image', 合算サイズ
      const docRows = await owner
        .select({
          id: sourceDocuments.id,
          userId: sourceDocuments.userId,
          examId: sourceDocuments.examId,
          mode: sourceDocuments.mode,
          fileType: sourceDocuments.fileType,
          status: sourceDocuments.status,
          fileSizeBytes: sourceDocuments.fileSizeBytes,
          pagesTotal: sourceDocuments.pagesTotal,
          filename: sourceDocuments.filename,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows).toHaveLength(1)
      expect(docRows[0]?.userId).toBe(userAId)
      expect(docRows[0]?.examId).toBe(result.examId)
      expect(docRows[0]?.mode).toBe('new')
      expect(docRows[0]?.fileType).toBe('image')
      expect(docRows[0]?.status).toBe('processing')
      expect(docRows[0]?.fileSizeBytes).toBe(3000) // 1000 + 2000
      expect(docRows[0]?.pagesTotal).toBe(2)
      expect(docRows[0]?.filename).toBe('new-1.png ほか 1 件')

      // upload_operations: status='awaiting_sources', leaseVersion=0, attemptCount=0
      const opRows = await owner
        .select({
          userId: uploadOperations.userId,
          idempotencyKey: uploadOperations.idempotencyKey,
          examId: uploadOperations.examId,
          sourceDocumentId: uploadOperations.sourceDocumentId,
          status: uploadOperations.status,
          leaseVersion: uploadOperations.leaseVersion,
          attemptCount: uploadOperations.attemptCount,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows).toHaveLength(1)
      expect(opRows[0]?.userId).toBe(userAId)
      expect(opRows[0]?.idempotencyKey).toBe('idem-new-1')
      expect(opRows[0]?.examId).toBe(result.examId)
      expect(opRows[0]?.sourceDocumentId).toBe(result.sourceDocumentId)
      expect(opRows[0]?.status).toBe('awaiting_sources')
      expect(opRows[0]?.leaseVersion).toBe(0)
      expect(opRows[0]?.attemptCount).toBe(0)

      // source_assets: 2 reservation rows, lean columns only (改訂 2026-07-31:
      // 検証済み 5 列は NULL のまま — finalize (T5) が条件付き UPDATE で確定する)
      const assetRows = await owner
        .select({
          sourceId: sourceAssets.sourceId,
          objectKey: sourceAssets.objectKey,
          mime: sourceAssets.mime,
          contentHash: sourceAssets.contentHash,
          byteSize: sourceAssets.byteSize,
          width: sourceAssets.width,
          height: sourceAssets.height,
          status: sourceAssets.status,
          sourceKind: sourceAssets.sourceKind,
          originalFilename: sourceAssets.originalFilename,
          userId: sourceAssets.userId,
        })
        .from(sourceAssets)
        .where(eq(sourceAssets.sourceDocumentId, result.sourceDocumentId))
      expect(assetRows).toHaveLength(2)
      const bySourceId = new Map(assetRows.map((r) => [r.sourceId, r]))
      const s1 = bySourceId.get('s1')
      expect(s1?.userId).toBe(userAId)
      expect(s1?.status).toBe('reserved')
      expect(s1?.sourceKind).toBe('image')
      expect(s1?.originalFilename).toBe('new-1.png')
      // lean reservation: 検証済み5列は書かない(nullable・finalize確定)
      expect(s1?.mime).toBeNull()
      expect(s1?.contentHash).toBeNull()
      expect(s1?.byteSize).toBeNull()
      expect(s1?.width).toBeNull()
      expect(s1?.height).toBeNull()

      const reservedS1 = result.reserved.find((r) => r.sourceId === 's1')
      expect(reservedS1?.objectKey).toBe(s1?.objectKey)
      expect(s1?.objectKey).toBe(`users/${userAId}/src/tmp/${reservedS1?.assetId}`)
    })
  })

  // --- (b) 既存 exam 経路: owner + archived 検証 ---
  describe('existing-exam path', () => {
    it('reuses an active exam owned by the caller', async () => {
      const owner = getFixtureOwnerDb()
      const activeExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: activeExamId, userId: userAId, name: '元の試験名' })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-existing-1',
        destination: { mode: 'existing', examId: activeExamId },
        sources: twoSources('existing'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }
      expect(result.examId).toBe(activeExamId)
      expect(result.examName).toBe('元の試験名')

      const docRows = await owner
        .select({ examId: sourceDocuments.examId, mode: sourceDocuments.mode })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.examId).toBe(activeExamId)
      expect(docRows[0]?.mode).toBe('existing')

      // exam 行自体は増えていない (再利用のみ)
      const examCount = await owner
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.userId, userAId))
      expect(examCount).toHaveLength(1)
    })

    it('rejects an archived exam and writes nothing', async () => {
      const owner = getFixtureOwnerDb()
      const archivedExamId = randomUUID()
      await owner.insert(exams).values({
        id: archivedExamId,
        userId: userAId,
        name: 'アーカイブ済',
        archivedAt: new Date(),
      })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-archived-1',
        destination: { mode: 'existing', examId: archivedExamId },
        sources: twoSources('archived'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result).toEqual({ outcome: 'exam_not_found', archived: true })
      await noWritesFor(userAId)
    })

    it('rejects a foreign exam (owned by another tenant) as not-found and writes nothing', async () => {
      const owner = getFixtureOwnerDb()
      const foreignExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: foreignExamId, userId: userBId, name: 'B の試験' })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-foreign-1',
        destination: { mode: 'existing', examId: foreignExamId },
        sources: twoSources('foreign'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result).toEqual({ outcome: 'exam_not_found', archived: false })

      const docRows = await owner
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.userId, userAId))
      expect(docRows).toHaveLength(0)
      // B の exam は無傷
      const bExam = await owner
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.id, foreignExamId))
      expect(bExam).toHaveLength(1)
    })
  })

  // --- (c) idempotent 再送: 同一 key の 2 回目は新規作成しない (引数が異なっても) ---
  describe('idempotent re-send (§2 冪等契約)', () => {
    it('returns the same operation even when the 2nd call args differ, and does not duplicate rows', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-replay-1',
        destination: { mode: 'new' },
        sources: twoSources('replay'),
      }

      const first = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (first.outcome !== 'success') {
        throw new Error(`expected success, got ${first.outcome}`)
      }

      // 2 回目は同じ idempotencyKey だが destination も sources も別内容
      // (別 exam・別 source 集合・本来なら invalid_input/size_exceeded になり得る値)。
      // 冪等契約(§2): 引数の妥当性を問わず最初の operation をそのまま返す。
      const differentInput: PrepareUploadInput = {
        idempotencyKey: 'idem-replay-1',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 'different-source',
            mime: 'image/gif' as PrepareUploadInput['sources'][number]['mime'],
            byteSize: -1,
            width: 1,
            height: 1,
            filename: 'ignored.gif',
          },
        ],
      }

      const second = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, differentInput),
      )
      if (second.outcome !== 'success') {
        throw new Error(`expected success, got ${second.outcome}`)
      }

      expect(second.operationId).toBe(first.operationId)
      expect(second.examId).toBe(first.examId)
      expect(second.sourceDocumentId).toBe(first.sourceDocumentId)
      expect(second.examName).toBe(first.examName)
      expect(second.reserved).toEqual(first.reserved)

      const owner = getFixtureOwnerDb()
      const opRows = await owner
        .select({ id: uploadOperations.id })
        .from(uploadOperations)
        .where(
          and(
            eq(uploadOperations.userId, userAId),
            eq(uploadOperations.idempotencyKey, 'idem-replay-1'),
          ),
        )
      expect(opRows).toHaveLength(1)

      const docRows = await owner
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.userId, userAId))
      expect(docRows).toHaveLength(1)

      const examRows = await owner
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.userId, userAId))
      expect(examRows).toHaveLength(1)

      const assetRows = await owner
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(eq(sourceAssets.sourceDocumentId, first.sourceDocumentId))
      expect(assetRows).toHaveLength(2) // 4 (二重) でも 1 (差替え) でもない
    })

    // review fix #A (regression from #5): reserved の順序は source_id 昇順に
    // 固定される(新規作成パス・冪等再送パス双方で同じ順序)。fix #5 は replay
    // 側の SELECT にだけ ORDER BY を足し、新規作成パスは入力順のまま返していた
    // ため、入力順が辞書順と異なる場合(この test の 's-2' → 's-10' のように)
    // 1 回目と replay で異なる配列を返しうる regression があった。
    it('returns reserved sorted by sourceId (not input order) on both create and replay', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-order-1',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 's-2',
            mime: 'image/png',
            byteSize: 100,
            width: 10,
            height: 10,
            filename: 'b.png',
          },
          {
            sourceId: 's-10',
            mime: 'image/jpeg',
            byteSize: 200,
            width: 20,
            height: 20,
            filename: 'a.jpg',
          },
        ],
      }

      const first = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (first.outcome !== 'success') {
        throw new Error(`expected success, got ${first.outcome}`)
      }
      // 辞書順: 's-10' < 's-2' ('1' < '2' で先頭の differing 文字が決まる)。
      // 入力順 ['s-2', 's-10'] とは逆順であることが本 test の要点。
      expect(first.reserved.map((r) => r.sourceId)).toEqual(['s-10', 's-2'])

      const second = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (second.outcome !== 'success') {
        throw new Error(`expected success, got ${second.outcome}`)
      }
      expect(second.reserved).toEqual(first.reserved)
    })

    // review fix #C(#A の fix 自体が regression だった件の再修正): JS 側
    // `.sort()`(UTF-16 code-unit 順)と DB の `ORDER BY sourceId`(DB 設定
    // collation 順)は非 ASCII source_id で一致する保証が無い。両パスを
    // selectReservedSources(DB ORDER BY 1 本)に統一したことで、実際の順序が
    // 何であれ create と replay が必ず一致することだけを検証する(具体的な
    // 順序そのものは assert しない — collation 依存で不安定なため)。
    it('returns an identical reserved order on create and replay for non-ASCII and mixed-order source IDs', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-order-non-ascii',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 'ページ-2',
            mime: 'image/png',
            byteSize: 100,
            width: 10,
            height: 10,
            filename: 'b.png',
          },
          {
            sourceId: 's-10',
            mime: 'image/jpeg',
            byteSize: 200,
            width: 20,
            height: 20,
            filename: 'a.jpg',
          },
          {
            sourceId: 'café',
            mime: 'image/webp',
            byteSize: 150,
            width: 15,
            height: 15,
            filename: 'c.webp',
          },
        ],
      }

      const first = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (first.outcome !== 'success') {
        throw new Error(`expected success, got ${first.outcome}`)
      }
      expect(first.reserved).toHaveLength(3)
      expect(new Set(first.reserved.map((r) => r.sourceId))).toEqual(
        new Set(['ページ-2', 's-10', 'café']),
      )

      const second = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (second.outcome !== 'success') {
        throw new Error(`expected success, got ${second.outcome}`)
      }
      expect(second.reserved).toEqual(first.reserved)
    })
  })

  // --- (d) live-operation gate: 別 key かつ live な awaiting operation があれば in_progress ---
  describe('live-operation gate (同時 1 upload 制限)', () => {
    // ②-4a-cutover 案 D(2026-08-02・OT 確定): 別 key + valid lease の claimed/prepared
    // (= 実行中の worker が存在)だけが in_progress でブロックする(最大 LEASE_TTL_MS の
    // 保護)。それ以外の非終端 op は supersede される(下記)。
    it.each(['claimed', 'prepared'] as const)(
      'a %s operation with a valid lease blocks a different-key call (in_progress)',
      async (status) => {
        const owner = getFixtureOwnerDb()
        const seedExamId = randomUUID()
        await owner
          .insert(exams)
          .values({ id: seedExamId, userId: userAId, name: 'seed exam' })
        await owner.insert(uploadOperations).values({
          userId: userAId,
          idempotencyKey: `idem-seed-${status}`,
          examId: seedExamId,
          status,
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000), // valid lease
          attemptCount: 1,
          expectedSourceCount: 1,
        })

        const input: PrepareUploadInput = {
          idempotencyKey: 'idem-newer',
          destination: { mode: 'new' },
          sources: twoSources('newer'),
        }
        const result = await asTenant(userAId, (tx) =>
          prepareUploadTx(tx, { id: userAId }, input),
        )
        expect(result).toEqual({ outcome: 'in_progress' })

        // 新規呼出は何も書かない・seed した 1 件は不変(clobber しない)
        const opRows = await owner
          .select({ id: uploadOperations.id, status: uploadOperations.status })
          .from(uploadOperations)
          .where(eq(uploadOperations.userId, userAId))
        expect(opRows).toHaveLength(1)
        expect(opRows[0]?.status).toBe(status)
      },
    )

    // 案 D: awaiting_sources は経過時間を問わず「旧 submit の放棄意思」とみなして
    // supersede する(terminal_failed 化 + doc failed)。resume はしない(1 submit =
    // 1 operation)。旧 op の doc を failed にするのは legacy 共存 gate の processing
    // 検出を避けるため(OT critical 副次発見)。
    it('supersedes a different-key awaiting_sources operation (terminalize + doc failed) and creates a fresh one', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      const staleDocId = randomUUID()
      await owner.insert(sourceDocuments).values({
        id: staleDocId,
        userId: userAId,
        examId: seedExamId,
        mode: 'new',
        fileType: 'image',
        filename: 'stale.png',
        fileSizeBytes: 100,
        status: 'processing',
      })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey: 'idem-seed-await',
        examId: seedExamId,
        sourceDocumentId: staleDocId,
        status: 'awaiting_sources',
        leaseVersion: 0,
        attemptCount: 0,
        expectedSourceCount: 1,
      })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-fresh',
        destination: { mode: 'new' },
        sources: twoSources('fresh'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }

      // 旧 op は terminal_failed 化、旧 doc は failed 化、新規 op が追加(計 2 件)。
      const opRows = await owner
        .select({ idempotencyKey: uploadOperations.idempotencyKey, status: uploadOperations.status })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(opRows).toHaveLength(2)
      const seeded = opRows.find((r) => r.idempotencyKey === 'idem-seed-await')
      expect(seeded?.status).toBe('terminal_failed')
      const staleDoc = await owner
        .select({ status: sourceDocuments.status })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, staleDocId))
      expect(staleDoc[0]?.status).toBe('failed')
    })

    // ②-4a Task 14b′ 主経路 completeness: prepareUpload(外側 wrapper・Clerk 経由)が
    // supersede した旧 op の source_assets を purge することを実 PG 上で pin する。
    // prepareUploadTx を直接叩く上のテスト群は wrapper をバイパスするため、
    // purge 配線(post-commit・wrapper level)はこのテストでのみ検証できる。
    it('wrapper(prepareUpload)は supersede した旧 op の reserved source_asset を purge する', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      const staleDocId = randomUUID()
      await owner.insert(sourceDocuments).values({
        id: staleDocId,
        userId: userAId,
        examId: seedExamId,
        mode: 'new',
        fileType: 'image',
        filename: 'stale.png',
        fileSizeBytes: 100,
        status: 'processing',
      })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey: 'idem-seed-await-2',
        examId: seedExamId,
        sourceDocumentId: staleDocId,
        status: 'awaiting_sources',
        leaseVersion: 0,
        attemptCount: 0,
        expectedSourceCount: 1,
      })
      const staleAssetId = randomUUID()
      const staleObjectKey = `users/${userAId}/src/tmp/${staleAssetId}`
      await owner.insert(sourceAssets).values({
        id: staleAssetId,
        userId: userAId,
        sourceDocumentId: staleDocId,
        sourceId: 's-stale',
        objectKey: staleObjectKey,
        status: 'reserved',
        originalFilename: 'stale.png',
      })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-fresh-2',
        destination: { mode: 'new' },
        sources: twoSources('fresh2'),
      }
      const result = await prepareUpload(input)
      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }
      expect(result.supersededSourceDocumentIds).toEqual([staleDocId])

      expect(mockDeleteObject).toHaveBeenCalledWith(staleObjectKey)
      const remaining = await owner
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, staleAssetId))
      expect(remaining).toHaveLength(0)
    })

    // Codex Important fix(2026-08-03 review): supersede は commit 済のまま、
    // その後の別チェック(ここでは size_exceeded)で early return しても、
    // supersede した旧 op の source は main-path で purge されなければならない
    // (旧実装は 'success' 到達時にしか purge しておらず、この経路は main-path
    // miss だった — RED 検証は report §12 参照)。
    it('wrapper(prepareUpload)は supersede 後に size_exceeded で早期 return しても旧 op の source を purge する', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      const staleDocId = randomUUID()
      await owner.insert(sourceDocuments).values({
        id: staleDocId,
        userId: userAId,
        examId: seedExamId,
        mode: 'new',
        fileType: 'image',
        filename: 'stale.png',
        fileSizeBytes: 100,
        status: 'processing',
      })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey: 'idem-seed-await-3',
        examId: seedExamId,
        sourceDocumentId: staleDocId,
        status: 'awaiting_sources',
        leaseVersion: 0,
        attemptCount: 0,
        expectedSourceCount: 1,
      })
      const staleAssetId = randomUUID()
      const staleObjectKey = `users/${userAId}/src/tmp/${staleAssetId}`
      await owner.insert(sourceAssets).values({
        id: staleAssetId,
        userId: userAId,
        sourceDocumentId: staleDocId,
        sourceId: 's-stale',
        objectKey: staleObjectKey,
        status: 'reserved',
        originalFilename: 'stale.png',
      })

      // 合計サイズが TOTAL_UPLOAD_LIMIT_BYTES を超える新規 submit(別
      // idempotencyKey)。 supersede(step 3)は size 検査(step 5)より前に走る
      // ため、supersede は commit された上で size_exceeded が返る。
      const half = Math.floor(TOTAL_UPLOAD_LIMIT_BYTES / 2) + 1000
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-fresh-3',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 's1',
            mime: 'image/png',
            byteSize: half,
            width: 100,
            height: 100,
            filename: 'big-1.png',
          },
          {
            sourceId: 's2',
            mime: 'image/png',
            byteSize: half,
            width: 100,
            height: 100,
            filename: 'big-2.png',
          },
        ],
      }
      const result = await prepareUpload(input)
      expect(result).toEqual({
        outcome: 'size_exceeded',
        current: half * 2,
        limit: TOTAL_UPLOAD_LIMIT_BYTES,
      })

      // supersede 自体は commit 済(旧 op は terminal_failed 化)。
      const seeded = await owner
        .select({ status: uploadOperations.status })
        .from(uploadOperations)
        .where(
          and(
            eq(uploadOperations.userId, userAId),
            eq(uploadOperations.idempotencyKey, 'idem-seed-await-3'),
          ),
        )
      expect(seeded[0]?.status).toBe('terminal_failed')

      // Codex fix の核心: size_exceeded(非 success)でも旧 op の source は
      // main-path で purge される(消え残らない)。
      expect(mockDeleteObject).toHaveBeenCalledWith(staleObjectKey)
      const remaining = await owner
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, staleAssetId))
      expect(remaining).toHaveLength(0)
    })

    // 案 D: lease が NULL / 期限切れの claimed/prepared(= 実行中 worker 不在)は
    // supersede する(terminalize + doc failed)。stage/publish 失敗で lease を解放した
    // まま放置された op が次回 submit で掃除される中核パス。
    it.each(['claimed', 'prepared'] as const)(
      'supersedes a different-key %s operation whose lease is expired (terminalize + doc failed)',
      async (status) => {
        const owner = getFixtureOwnerDb()
        const seedExamId = randomUUID()
        await owner
          .insert(exams)
          .values({ id: seedExamId, userId: userAId, name: 'seed exam' })
        const staleDocId = randomUUID()
        await owner.insert(sourceDocuments).values({
          id: staleDocId,
          userId: userAId,
          examId: seedExamId,
          mode: 'new',
          fileType: 'image',
          filename: 'stale.png',
          fileSizeBytes: 100,
          status: 'processing',
        })
        await owner.insert(uploadOperations).values({
          userId: userAId,
          idempotencyKey: `idem-seed-${status}`,
          examId: seedExamId,
          sourceDocumentId: staleDocId,
          status,
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() - 60_000), // expired
          attemptCount: 1,
          expectedSourceCount: 1,
        })

        const input: PrepareUploadInput = {
          idempotencyKey: 'idem-fresh',
          destination: { mode: 'new' },
          sources: twoSources('fresh'),
        }
        const result = await asTenant(userAId, (tx) =>
          prepareUploadTx(tx, { id: userAId }, input),
        )
        if (result.outcome !== 'success') {
          throw new Error(`expected success, got ${result.outcome}`)
        }

        const seeded = await owner
          .select({ status: uploadOperations.status })
          .from(uploadOperations)
          .where(
            and(
              eq(uploadOperations.userId, userAId),
              eq(uploadOperations.idempotencyKey, `idem-seed-${status}`),
            ),
          )
        expect(seeded[0]?.status).toBe('terminal_failed')
        const staleDoc = await owner
          .select({ status: sourceDocuments.status })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, staleDocId))
        expect(staleDoc[0]?.status).toBe('failed')
      },
    )

    // 案 D: completed op は非 live(触らない)。別 key の新規呼出は success。
    it('does not touch a completed operation and proceeds with a fresh one', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey: 'idem-seed-completed',
        examId: seedExamId,
        status: 'completed',
        leaseVersion: 1,
        attemptCount: 1,
        expectedSourceCount: 1,
      })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-fresh',
        destination: { mode: 'new' },
        sources: twoSources('fresh'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }

      const seeded = await owner
        .select({ status: uploadOperations.status })
        .from(uploadOperations)
        .where(
          and(
            eq(uploadOperations.userId, userAId),
            eq(uploadOperations.idempotencyKey, 'idem-seed-completed'),
          ),
        )
      expect(seeded[0]?.status).toBe('completed')
    })

    // 案 D: 複数の別 key 非終端 op のうち **1 件でも valid lease** があれば in_progress で
    // ブロックし、どれも terminalize しない(実行中 worker を保護)。
    it('mixed-state: valid-lease claimed + expired claimed が併存 → in_progress・どちらも不変', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values([
        {
          userId: userAId,
          idempotencyKey: 'idem-valid',
          examId: seedExamId,
          status: 'claimed',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000), // valid
          attemptCount: 1,
          expectedSourceCount: 1,
        },
        {
          userId: userAId,
          idempotencyKey: 'idem-expired',
          examId: seedExamId,
          status: 'claimed',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() - 60_000), // expired
          attemptCount: 1,
          expectedSourceCount: 1,
        },
      ])

      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, {
          idempotencyKey: 'idem-fresh',
          destination: { mode: 'new' },
          sources: twoSources('fresh'),
        }),
      )
      expect(result).toEqual({ outcome: 'in_progress' })

      // どちらの seed op も terminalize されない(valid worker がいるため全体をブロック)。
      const rows = await owner
        .select({ idempotencyKey: uploadOperations.idempotencyKey, status: uploadOperations.status })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(rows).toHaveLength(2) // 新規 op は作られない
      expect(rows.every((r) => r.status === 'claimed')).toBe(true)
    })

    // 案 D: valid lease が 1 件も無ければ、複数の inactive op を **全て** terminalize して進む。
    it('multi-op: awaiting_sources + expired claimed(いずれも inactive)→ 両方 supersede + 新規 success', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values([
        {
          userId: userAId,
          idempotencyKey: 'idem-await',
          examId: seedExamId,
          status: 'awaiting_sources',
          leaseVersion: 0,
          attemptCount: 0,
          expectedSourceCount: 1,
        },
        {
          userId: userAId,
          idempotencyKey: 'idem-expired',
          examId: seedExamId,
          status: 'claimed',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() - 60_000), // expired
          attemptCount: 1,
          expectedSourceCount: 1,
        },
      ])

      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, {
          idempotencyKey: 'idem-fresh',
          destination: { mode: 'new' },
          sources: twoSources('fresh'),
        }),
      )
      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }

      const rows = await owner
        .select({ idempotencyKey: uploadOperations.idempotencyKey, status: uploadOperations.status })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(rows).toHaveLength(3) // 2 seed + 1 新規
      const byKey = Object.fromEntries(rows.map((r) => [r.idempotencyKey, r.status]))
      expect(byKey['idem-await']).toBe('terminal_failed')
      expect(byKey['idem-expired']).toBe('terminal_failed')
      expect(byKey['idem-fresh']).toBe('awaiting_sources')
    })

    // review fix #D (Critical・cross-flow coexistence): legacy runUploadGuardTx
    // flow は upload_operations 行を作らず source_documents(status='processing')
    // だけで in-flight を表す。non-stale な legacy processing 行があれば新 flow の
    // prepareUploadTx も in_progress を返すことを確認する。
    it('a non-stale legacy source_documents(processing) row blocks a new prepareUploadTx call', async () => {
      const owner = getFixtureOwnerDb()
      const legacyExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: legacyExamId, userId: userAId, name: 'legacy exam' })
      await owner.insert(sourceDocuments).values({
        userId: userAId,
        examId: legacyExamId,
        mode: 'new',
        fileType: 'image',
        filename: 'legacy.png',
        fileSizeBytes: 100,
        status: 'processing',
        // createdAt はデフォルト now()。 STALE_PROCESSING_MS 以内 = non-stale。
      })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-legacy-block',
        destination: { mode: 'new' },
        sources: twoSources('legacy-block'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result).toEqual({ outcome: 'in_progress' })

      // 新規呼出は何も書かない (upload_operations は 0 件のまま)
      const opRows = await owner
        .select({ id: uploadOperations.id })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(opRows).toHaveLength(0)
    })

    // review fix #D: STALE_PROCESSING_MS を超えて古い legacy processing 行は
    // 放棄済とみなし、ブロックしない(legacy upload-guard.ts:76-90 と同じ判定)。
    it('a stale legacy source_documents(processing) row does not block a new prepareUploadTx call', async () => {
      const owner = getFixtureOwnerDb()
      const legacyExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: legacyExamId, userId: userAId, name: 'legacy exam (stale)' })
      const staleCreatedAt = new Date(Date.now() - STALE_PROCESSING_MS - 60_000) // STALE + 1 分
      await owner.insert(sourceDocuments).values({
        userId: userAId,
        examId: legacyExamId,
        mode: 'new',
        fileType: 'image',
        filename: 'legacy-stale.png',
        fileSizeBytes: 100,
        status: 'processing',
        createdAt: staleCreatedAt,
      })

      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-legacy-stale',
        destination: { mode: 'new' },
        sources: twoSources('legacy-stale'),
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      if (result.outcome !== 'success') {
        throw new Error(`expected success, got ${result.outcome}`)
      }

      const opRows = await owner
        .select({ id: uploadOperations.id })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(opRows).toHaveLength(1)
    })
  })

  // --- (e) 全体サイズ上限の早期検査 ---
  describe('size_exceeded (early total-size check)', () => {
    it('rejects when the declared total size exceeds TOTAL_UPLOAD_LIMIT_BYTES and writes nothing', async () => {
      const half = Math.floor(TOTAL_UPLOAD_LIMIT_BYTES / 2) + 1000 // 2 つ足すと超過
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-oversize-1',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 's1',
            mime: 'image/png',
            byteSize: half,
            width: 100,
            height: 100,
            filename: 'big-1.png',
          },
          {
            sourceId: 's2',
            mime: 'image/png',
            byteSize: half,
            width: 100,
            height: 100,
            filename: 'big-2.png',
          },
        ],
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result).toEqual({
        outcome: 'size_exceeded',
        current: half * 2,
        limit: TOTAL_UPLOAD_LIMIT_BYTES,
      })
      await noWritesFor(userAId)
    })
  })

  // --- (f) 入力検証 (asset-actions.ts reserveInputSchema 相当の zod 境界) ---
  describe('invalid_input (zod 境界)', () => {
    it('rejects an unsupported mime type and writes nothing', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-bad-mime',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 's1',
            mime: 'image/gif',
            byteSize: 100,
            width: 10,
            height: 10,
            filename: 'a.gif',
          },
        ],
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result.outcome).toBe('invalid_input')
      await noWritesFor(userAId)
    })

    it('rejects a non-positive byteSize and writes nothing', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-bad-size',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 's1',
            mime: 'image/png',
            byteSize: 0,
            width: 10,
            height: 10,
            filename: 'a.png',
          },
        ],
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result.outcome).toBe('invalid_input')
      await noWritesFor(userAId)
    })

    it('rejects a duplicate client source_id within the same call and writes nothing', async () => {
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-dup-source',
        destination: { mode: 'new' },
        sources: [
          {
            sourceId: 'dup',
            mime: 'image/png',
            byteSize: 100,
            width: 10,
            height: 10,
            filename: 'a.png',
          },
          {
            sourceId: 'dup',
            mime: 'image/png',
            byteSize: 100,
            width: 10,
            height: 10,
            filename: 'b.png',
          },
        ],
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result.outcome).toBe('invalid_input')
      await noWritesFor(userAId)
    })

    // review fix #3: source 件数上限(MAX_SOURCES_PER_UPLOAD = OCR_MAX_PAGES 再利用)。
    it('rejects a source count over OCR_MAX_PAGES and writes nothing', async () => {
      const oversizedSources: PrepareUploadInput['sources'] = Array.from(
        { length: OCR_MAX_PAGES + 1 },
        (_, i) => ({
          sourceId: `s${i}`,
          mime: 'image/png' as const,
          byteSize: 100,
          width: 10,
          height: 10,
          filename: `a${i}.png`,
        }),
      )
      const input: PrepareUploadInput = {
        idempotencyKey: 'idem-too-many-sources',
        destination: { mode: 'new' },
        sources: oversizedSources,
      }
      const result = await asTenant(userAId, (tx) =>
        prepareUploadTx(tx, { id: userAId }, input),
      )
      expect(result.outcome).toBe('invalid_input')
      await noWritesFor(userAId)
    })
  })

  // --- (g) 外側 wrapper: malformed input(null 等)は dereference 前に弾く
  // (review fix #B)。 prepareUpload(null) は currentUserOrNull()(Clerk auth())を
  // 呼ぶより前に invalid_input を返す設計のため、Clerk mock 無しでも直接呼べる。
  describe('prepareUpload (outer wrapper) — malformed input guard', () => {
    it('returns invalid_input for a null input without throwing or writing', async () => {
      const result = await prepareUpload(null as unknown as PrepareUploadInput)
      expect(result).toEqual({ outcome: 'invalid_input', error: '入力内容が正しくありません' })

      const owner = getFixtureOwnerDb()
      const opRows = await owner.select({ id: uploadOperations.id }).from(uploadOperations)
      expect(opRows).toHaveLength(0)
    })

    it('returns invalid_input for a non-object input (string) without throwing or writing', async () => {
      const result = await prepareUpload('not-an-object' as unknown as PrepareUploadInput)
      expect(result.outcome).toBe('invalid_input')

      const owner = getFixtureOwnerDb()
      const opRows = await owner.select({ id: uploadOperations.id }).from(uploadOperations)
      expect(opRows).toHaveLength(0)
    })
  })
})
