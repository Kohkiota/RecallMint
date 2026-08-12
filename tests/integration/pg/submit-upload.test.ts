// ②-4a 単一 invocation Sprint Task S-1: submitUploadTx(sync phase の 1 tx)の実 PG 検証。
// advisory lock → 冪等 replay → live-op gate(+ supersede)→ daily cap →
// operation('processing') + exam + source_document('processing') 作成 + lease 発行
// までを 1 tx で行うことを確認する。
//
// submitUploadTx は Clerk 認証を持たない(prepare-upload.ts の prepareUploadTx と
// 同型 — tx と user を呼出側から受け取るだけ)ため asTenant + Pick<User,'id'> で
// 直接 exercise できる。gate / supersede は submitUploadTx を直接呼ぶ:
// action(submitUpload)経由だと S-1 スタブ(OCR/crop 未実装 = 即 terminal 化)が
// 走って valid-lease な op が残らず、gate の対象そのものが消えるため。
//
// 実 OS レベルの同時 advisory lock 競合(2 接続が同時に同じ hashtext を取り合う)は
// iso で決定的に再現できないため対象外。「同時 2 submit で片方だけ通る」の実効は
// live-op gate(valid lease を持つ processing op があれば in_progress)が担い、
// そちらは決定的に検証できる。
//
// mutating test ゆえ beforeEach で truncate(各 test を clean state から)。
import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OCR_MAX_PAGES } from '@/lib/ai/ocr-limits'
import { closeDb } from '@/lib/db'
import {
  aiUsage,
  exams,
  integrationFailures,
  sourceDocuments,
  uploadOperations,
  users,
} from '@/lib/db/schema'
import { hasLiveUploadOperation } from '@/lib/exams/source-doc-status'
import { todayInJst } from '@/lib/jst'
import { LEASE_TTL_MS } from '@/app/(app)/app/upload/_lib/constants'

const { mockGetCurrentUser, mockCallGemini, mockAfter, mockNotifyOps, ...r2Spies } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockCallGemini: vi.fn(),
    mockAfter: vi.fn(),
    mockNotifyOps: vi.fn(),
    presignPutUrl: vi.fn(),
    presignGetUrl: vi.fn(),
    headObject: vi.fn(),
    getObject: vi.fn(),
    putObject: vi.fn(),
    deleteObject: vi.fn(),
  }))

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
// S-4: 本処理は `after()` に載る。実物の `after` は request scope の外(vitest)では
// 必ず throw する(next/dist/server/after: workStore 不在 → E468)ため、登録された
// callback を捕まえて test が明示的に走らせる = platform が応答後に実行する分の再現。
vi.mock('next/server', () => ({ after: mockAfter }))
// 外部副作用の遮断: after() 境界の防波堤 / pipeline の台帳記録は実
// `recordIntegrationFailure` → `notifyOps` を通るため、通知だけ mock で塞ぐ
// (integration_failures への実書込は検証し続ける)。
vi.mock('@/lib/ops', () => ({
  notifyOps: mockNotifyOps,
  notifyWebhookError: vi.fn(),
}))
// spec §2: 新経路は source を R2 に置かない(画像は request body のバイトのみを
// 使う)。R2 client の全 export を spy にしているが、**「1 度も呼ばれない」は
// 画像のみ経路(orderManifest 不在)にのみ当てはまる主張**である点に注意
// ([[lesson_single_point_claims_decay]] — 完全性の主張は適用範囲を書かないと
// 黙って部分的に偽になる)。②-4b T7 以降、PDF 経路の pre-tx 層 2(spec D6)は
// `headObject` を**正当に**呼ぶ(下記「PDF manifest 経路」describe が
// `r2Spies.headObject.mockResolvedValue(...)` している)。呼ばれてよいのは
// `headObject` のみ — 他の export(presignPutUrl/presignGetUrl/getObject/
// putObject/deleteObject)は submit-upload.ts の責務外のままで、file 全体を通じて
// 未使用のはず(unit 側 `submit-upload.test.ts` の regex pin と二重に担保)。
vi.mock('@/lib/storage/r2', () => r2Spies)
// S-2 以降 action は OCR phase(pipeline)まで走るため実 API を叩かせない
// (CLAUDE.md AI 絶対ルール 3)。
vi.mock('@/lib/ai/clients/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/clients/gemini')>()
  return { ...actual, callGemini: mockCallGemini }
})

// vi.mock は import より前に hoist される。
import {
  submitUpload,
  submitUploadTx,
  type SubmitUploadFileMeta,
  type SubmitUploadInput,
  type SubmitUploadPdfMeta,
} from '@/app/(app)/app/upload/_actions/submit-upload'

import { asTenant } from './setup/as-tenant'
import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

// after() に登録された callback。応答後に platform が走らせる分を test が再現する。
let afterTasks: Array<() => unknown> = []

async function runAfterTasks(): Promise<void> {
  const tasks = afterTasks
  afterTasks = []
  for (const task of tasks) await task()
}

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// upload_operations.source_document_id は NOT NULL (Sprint B (DB 全体掃除) §5.1)。
// seed する operation にも実在の source_document を対応させる。
async function seedSourceDoc(userId: string, examId: string): Promise<string> {
  const id = randomUUID()
  await getFixtureOwnerDb().insert(sourceDocuments).values({
    id,
    userId,
    examId,
    fileType: 'image',
    filename: 'seed.png',
    fileSizeBytes: 100,
    status: 'processing',
  })
  return id
}

function twoFiles(prefix: string): SubmitUploadFileMeta[] {
  return [
    { filename: `${prefix}-1.png`, byteSize: 1000 },
    { filename: `${prefix}-2.png`, byteSize: 2000 },
  ]
}

function imageFile(name: string, byteSize: number): File {
  const bytes = Buffer.alloc(byteSize)
  Buffer.from(PNG_MAGIC).copy(bytes, 0)
  return new File([bytes], name, { type: 'image/png' })
}

// action 経路は S-2 で OCR phase(実 sharp decode)まで走るため、magic bytes だけ
// 揃えた合成バイトでは decode に失敗する。実 PNG を作る。
async function realImageFile(name: string): Promise<File> {
  const bytes = await sharp({
    create: { width: 8, height: 6, channels: 3, background: { r: 10, g: 120, b: 60 } },
  })
    .png()
    .toBuffer()
  return new File([bytes], name, { type: 'image/png' })
}

const VALID_CARD = {
  title: '問 1',
  question_text: '設問本文',
  options: [
    { id: 'a', text: '選択肢 A', is_correct: true },
    { id: 'b', text: '選択肢 B', is_correct: false },
  ],
}

function geminiOk() {
  return {
    text: JSON.stringify({ cards: [VALID_CARD] }),
    inputTokens: 10,
    outputTokens: 20,
    thoughtsTokens: 0,
  }
}

function buildFormData(files: File[], idempotencyKey: string): FormData {
  const fd = new FormData()
  fd.set('idempotencyKey', idempotencyKey)
  fd.set('mode', 'new')
  for (const f of files) fd.append('files', f)
  return fd
}

// ②-4b T7: orderManifest(PDF 経路)を積んだ FormData(spec §3.4 の wire 契約)。
function buildManifestFormData(
  images: File[],
  pdfEntries: SubmitUploadPdfMeta[],
  idempotencyKey: string,
  uploadSessionId: string,
): FormData {
  const fd = buildFormData(images, idempotencyKey)
  const manifest = [
    ...images.map((_, i) => ({ kind: 'image', fileIndex: i })),
    ...pdfEntries.map((e) => ({ kind: 'pdf', ...e })),
  ]
  fd.set('orderManifest', JSON.stringify(manifest))
  fd.set('uploadSessionId', uploadSessionId)
  return fd
}

describe('submitUploadTx (S-1)', () => {
  let userAId: string
  let userBId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetCurrentUser.mockReset()
    mockCallGemini.mockReset()
    mockCallGemini.mockResolvedValue(geminiOk())
    for (const spy of Object.values(r2Spies)) spy.mockReset()
    mockNotifyOps.mockReset()
    afterTasks = []
    mockAfter.mockReset()
    mockAfter.mockImplementation((task: () => unknown) => {
      afterTasks.push(task)
    })
    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
  })

  // --- (a) 作成: operation('processing') + exam + source_document + lease ---
  it('creates operation(processing, lease 発行) + exam + source_document(processing) in one tx', async () => {
    const input: SubmitUploadInput = {
      idempotencyKey: 'idem-new-1',
      destination: { mode: 'new' },
    }
    const before = Date.now()
    const result = await asTenant(userAId, (tx) =>
      submitUploadTx(tx, { id: userAId }, input, twoFiles('new')),
    )
    if (result.outcome !== 'accepted') {
      throw new Error(`expected accepted, got ${result.outcome}`)
    }

    const owner = getFixtureOwnerDb()

    const examRows = await owner
      .select({ id: exams.id, name: exams.name, userId: exams.userId })
      .from(exams)
      .where(eq(exams.id, result.examId))
    expect(examRows).toHaveLength(1)
    expect(examRows[0]?.userId).toBe(userAId)
    expect(examRows[0]?.name).toMatch(/^アップロード \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

    const docRows = await owner
      .select({
        userId: sourceDocuments.userId,
        examId: sourceDocuments.examId,
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
    expect(docRows[0]?.fileType).toBe('image')
    expect(docRows[0]?.status).toBe('processing')
    expect(docRows[0]?.fileSizeBytes).toBe(3000) // 1000 + 2000
    expect(docRows[0]?.pagesTotal).toBe(2)
    expect(docRows[0]?.filename).toBe('new-1.png ほか 1 件')

    const opRows = await owner
      .select({
        idempotencyKey: uploadOperations.idempotencyKey,
        examId: uploadOperations.examId,
        sourceDocumentId: uploadOperations.sourceDocumentId,
        status: uploadOperations.status,
        leaseVersion: uploadOperations.leaseVersion,
        attemptCount: uploadOperations.attemptCount,
        expectedSourceCount: uploadOperations.expectedSourceCount,
        leaseExpiresAt: uploadOperations.leaseExpiresAt,
      })
      .from(uploadOperations)
      .where(eq(uploadOperations.id, result.operationId))
    expect(opRows).toHaveLength(1)
    expect(opRows[0]?.idempotencyKey).toBe('idem-new-1')
    expect(opRows[0]?.examId).toBe(result.examId)
    expect(opRows[0]?.sourceDocumentId).toBe(result.sourceDocumentId)
    expect(opRows[0]?.status).toBe('processing')
    expect(opRows[0]?.leaseVersion).toBe(0)
    expect(opRows[0]?.attemptCount).toBe(0)
    expect(opRows[0]?.expectedSourceCount).toBe(2)
    // lease は PG now() 基準で now + LEASE_TTL_MS。時計差を吸収する幅で確認する。
    const leaseMs = opRows[0]!.leaseExpiresAt!.getTime()
    expect(leaseMs).toBeGreaterThan(before + LEASE_TTL_MS - 60_000)
    expect(leaseMs).toBeLessThan(Date.now() + LEASE_TTL_MS + 60_000)
  })

  it('reuses an active exam owned by the caller (mode=existing)', async () => {
    const owner = getFixtureOwnerDb()
    const activeExamId = randomUUID()
    await owner.insert(exams).values({ id: activeExamId, userId: userAId, name: '元の試験名' })

    const result = await asTenant(userAId, (tx) =>
      submitUploadTx(
        tx,
        { id: userAId },
        { idempotencyKey: 'idem-existing-1', destination: { mode: 'existing', examId: activeExamId } },
        twoFiles('existing'),
      ),
    )
    if (result.outcome !== 'accepted') {
      throw new Error(`expected accepted, got ${result.outcome}`)
    }
    expect(result.examId).toBe(activeExamId)
    const examRows = await owner.select({ id: exams.id }).from(exams).where(eq(exams.userId, userAId))
    expect(examRows).toHaveLength(1)
  })

  it('rejects a foreign exam (owned by another tenant) as not-found', async () => {
    const owner = getFixtureOwnerDb()
    const foreignExamId = randomUUID()
    await owner.insert(exams).values({ id: foreignExamId, userId: userBId, name: 'B の試験' })

    const result = await asTenant(userAId, (tx) =>
      submitUploadTx(
        tx,
        { id: userAId },
        {
          idempotencyKey: 'idem-foreign-1',
          destination: { mode: 'existing', examId: foreignExamId },
        },
        twoFiles('foreign'),
      ),
    )
    expect(result).toEqual({ outcome: 'exam_not_found' })
    await expectNoOperationsOrDocs(userAId)
  })

  // --- (b) live-op gate: valid lease を持つ processing op が別 key の submit を弾く ---
  describe('live-operation gate(同時 2 submit)', () => {
    it('2 回目の submit(別 key)は 1 回目が発行した lease が生きている間 in_progress で弾かれる', async () => {
      const first = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-first', destination: { mode: 'new' } },
          twoFiles('first'),
        ),
      )
      if (first.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${first.outcome}`)
      }

      const second = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-second', destination: { mode: 'new' } },
          twoFiles('second'),
        ),
      )
      expect(second).toEqual({ outcome: 'in_progress' })

      // 1 回目の op は無傷(clobber しない)・2 回目は何も書いていない。
      const owner = getFixtureOwnerDb()
      const opRows = await owner
        .select({ id: uploadOperations.id, status: uploadOperations.status })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(opRows).toHaveLength(1)
      expect(opRows[0]?.status).toBe('processing')
    })

    it.each(['prepared', 'processing'] as const)(
      'a %s operation with a valid lease blocks a different-key call (in_progress)',
      async (status) => {
        const owner = getFixtureOwnerDb()
        const seedExamId = randomUUID()
        await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
        await owner.insert(uploadOperations).values({
          userId: userAId,
          idempotencyKey: `idem-seed-${status}`,
          examId: seedExamId,
          sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
          status,
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000), // valid lease
          attemptCount: 1,
          expectedSourceCount: 1,
        })

        const result = await asTenant(userAId, (tx) =>
          submitUploadTx(
            tx,
            { id: userAId },
            { idempotencyKey: 'idem-newer', destination: { mode: 'new' } },
            twoFiles('newer'),
          ),
        )
        expect(result).toEqual({ outcome: 'in_progress' })

        const opRows = await owner
          .select({ id: uploadOperations.id, status: uploadOperations.status })
          .from(uploadOperations)
          .where(eq(uploadOperations.userId, userAId))
        expect(opRows).toHaveLength(1)
        expect(opRows[0]?.status).toBe(status)
      },
    )

    it('lease 失効した processing operation は supersede される(terminal_failed + doc failed)', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      const staleDocId = randomUUID()
      await owner.insert(sourceDocuments).values({
        id: staleDocId,
        userId: userAId,
        examId: seedExamId,
        fileType: 'image',
        filename: 'stale.png',
        fileSizeBytes: 100,
        status: 'processing',
      })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey: 'idem-seed-expired',
        examId: seedExamId,
        sourceDocumentId: staleDocId,
        status: 'processing',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() - 60_000), // 失効済
        attemptCount: 1,
        expectedSourceCount: 1,
      })

      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-fresh', destination: { mode: 'new' } },
          twoFiles('fresh'),
        ),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }

      const opRows = await owner
        .select({
          idempotencyKey: uploadOperations.idempotencyKey,
          status: uploadOperations.status,
          leaseExpiresAt: uploadOperations.leaseExpiresAt,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(opRows).toHaveLength(2)
      const seeded = opRows.find((r) => r.idempotencyKey === 'idem-seed-expired')
      expect(seeded?.status).toBe('terminal_failed')
      expect(seeded?.leaseExpiresAt).toBeNull()

      const staleDoc = await owner
        .select({ status: sourceDocuments.status })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, staleDocId))
      expect(staleDoc[0]?.status).toBe('failed')
    })

    // --- S-5b: 撤去した prepare-upload.test.ts の supersede 系保証をここへ移植 ---
    // (旧 test は prepareUploadTx を対象にしていたため file ごと消えるが、gate の
    //  semantics 自体は新経路へそのまま引き継がれている。移植しないと「終端 op を
    //  巻き込まない」「1 件でも live なら全体を守る」「live が無ければ全件掃く」の
    //  3 つが無検証になる。)
    it('終端 operation(completed)は gate に無関係・触られもしない', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey: 'idem-seed-completed',
        examId: seedExamId,
        sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
        status: 'completed',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000), // 終端なので lease は無視される
        attemptCount: 1,
        expectedSourceCount: 1,
      })

      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-fresh', destination: { mode: 'new' } },
          twoFiles('fresh'),
        ),
      )
      expect(result.outcome).toBe('accepted')

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

    it('mixed-state: 1 件でも valid lease があれば in_progress・失効側も terminalize しない', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values([
        {
          userId: userAId,
          idempotencyKey: 'idem-valid',
          examId: seedExamId,
          sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
          status: 'processing',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000), // valid
          attemptCount: 1,
          expectedSourceCount: 1,
        },
        {
          userId: userAId,
          idempotencyKey: 'idem-expired',
          examId: seedExamId,
          sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
          status: 'processing',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() - 60_000), // expired
          attemptCount: 1,
          expectedSourceCount: 1,
        },
      ])

      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-fresh', destination: { mode: 'new' } },
          twoFiles('fresh'),
        ),
      )
      expect(result).toEqual({ outcome: 'in_progress' })

      // 実行中の worker を守るため、どちらの seed op も terminalize しない。
      const rows = await owner
        .select({
          idempotencyKey: uploadOperations.idempotencyKey,
          status: uploadOperations.status,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(rows).toHaveLength(2) // 新規 op は作られない
      expect(rows.every((r) => r.status === 'processing')).toBe(true)
    })

    it('multi-op: valid lease が 1 件も無ければ非終端 op を全て supersede して進む', async () => {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values([
        {
          userId: userAId,
          idempotencyKey: 'idem-null-lease',
          examId: seedExamId,
          sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
          status: 'prepared',
          leaseVersion: 0,
          leaseExpiresAt: null,
          attemptCount: 0,
          expectedSourceCount: 1,
        },
        {
          userId: userAId,
          idempotencyKey: 'idem-expired',
          examId: seedExamId,
          sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
          status: 'processing',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() - 60_000),
          attemptCount: 1,
          expectedSourceCount: 1,
        },
      ])

      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-fresh', destination: { mode: 'new' } },
          twoFiles('fresh'),
        ),
      )
      expect(result.outcome).toBe('accepted')

      const rows = await owner
        .select({
          idempotencyKey: uploadOperations.idempotencyKey,
          status: uploadOperations.status,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.userId, userAId))
      expect(rows).toHaveLength(3) // 2 seed + 1 新規
      const byKey = Object.fromEntries(rows.map((r) => [r.idempotencyKey, r.status]))
      expect(byKey['idem-null-lease']).toBe('terminal_failed')
      expect(byKey['idem-expired']).toBe('terminal_failed')
      expect(byKey['idem-fresh']).toBe('processing')
    })

    it('別テナントの live operation は gate に影響しない', async () => {
      const owner = getFixtureOwnerDb()
      const bExamId = randomUUID()
      await owner.insert(exams).values({ id: bExamId, userId: userBId, name: 'B の試験' })
      await owner.insert(uploadOperations).values({
        userId: userBId,
        idempotencyKey: 'idem-b-live',
        examId: bExamId,
        sourceDocumentId: await seedSourceDoc(userBId, bExamId),
        status: 'processing',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        attemptCount: 1,
        expectedSourceCount: 1,
      })

      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-a-1', destination: { mode: 'new' } },
          twoFiles('a'),
        ),
      )
      expect(result.outcome).toBe('accepted')
    })
  })

  // --- (b') S-5b 追加項目 A: form を隠す判定と live-op gate が同じ述語を読む ---
  // 「form は出るのに submit すると in_progress で拒否される」窓を構造的に作らない
  // ため、`/app/upload` の form 表示 gate(`hasLiveUploadOperation`)と submit を弾く
  // gate(`submitUploadTx`)を **同一の seed 状態に対して突き合わせる**。
  //
  // 数字を揃えているのではなく判定そのものを共有していることの pin: 旧実装
  // (`source_documents` の `status='processing'` かつ作成が 15 分以内 = lease を
  // 読まない)へ戻すと、下の legacy ケースで両者の結論が割れて fail する。
  describe('form 表示 gate と live-op gate の一致(S-5b 追加項目 A)', () => {
    async function seedOp(
      idempotencyKey: string,
      status: 'prepared' | 'processing' | 'completed' | 'terminal_failed',
      leaseExpiresAt: Date | null,
    ): Promise<void> {
      const owner = getFixtureOwnerDb()
      const seedExamId = randomUUID()
      await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
      await owner.insert(uploadOperations).values({
        userId: userAId,
        idempotencyKey,
        examId: seedExamId,
        sourceDocumentId: await seedSourceDoc(userAId, seedExamId),
        status,
        leaseVersion: 1,
        leaseExpiresAt,
        attemptCount: 1,
        expectedSourceCount: 1,
      })
    }

    // 判定を **submit の前**に取る(submit が accepted だと自分で live op を作るため)。
    async function bothGates(): Promise<{ formHidden: boolean; submitBlocked: boolean }> {
      const formHidden = await hasLiveUploadOperation(userAId)
      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-parity-probe', destination: { mode: 'new' } },
          twoFiles('parity'),
        ),
      )
      return { formHidden, submitBlocked: result.outcome === 'in_progress' }
    }

    it('valid lease の非終端 op: 両方とも「実行中」と判定する', async () => {
      await seedOp('idem-live', 'processing', new Date(Date.now() + 60_000))
      expect(await bothGates()).toEqual({ formHidden: true, submitBlocked: true })
    })

    it('lease 失効の非終端 op: 両方とも「実行中でない」と判定する', async () => {
      await seedOp('idem-expired', 'processing', new Date(Date.now() - 60_000))
      expect(await bothGates()).toEqual({ formHidden: false, submitBlocked: false })
    })

    it('lease NULL の非終端 op: 両方とも「実行中でない」と判定する', async () => {
      await seedOp('idem-null-lease', 'prepared', null)
      expect(await bothGates()).toEqual({ formHidden: false, submitBlocked: false })
    })

    it('終端 op は lease が生きていても両方とも「実行中でない」', async () => {
      await seedOp('idem-completed', 'completed', new Date(Date.now() + 60_000))
      expect(await bothGates()).toEqual({ formHidden: false, submitBlocked: false })
    })

    // **本 describe の中核**(挙動変更を固定する)。`upload_operations` 行を持たない
    // legacy な processing の `source_document`(旧 process.ts 経路の残骸)は、
    // live-op gate が元々弾かない。旧実装の form gate はこれを「実行中」と読んで
    // form を隠していたため、隠すのに submit は通るというねじれがあった。
    // 判定を共有した今は **両方とも false** で一致する。
    it('upload_operations 行を持たない legacy な processing doc: 両方とも「実行中でない」', async () => {
      const owner = getFixtureOwnerDb()
      const legacyExamId = randomUUID()
      await owner
        .insert(exams)
        .values({ id: legacyExamId, userId: userAId, name: 'legacy exam' })
      await owner.insert(sourceDocuments).values({
        userId: userAId,
        examId: legacyExamId,
        fileType: 'image',
        filename: 'legacy.png',
        fileSizeBytes: 100,
        status: 'processing',
        // createdAt は既定(たった今)= 旧実装の 15 分 window の内側。
      })

      expect(await bothGates()).toEqual({ formHidden: false, submitBlocked: false })
    })

    it('別テナントの live op は form 表示 gate にも影響しない(owner-scope)', async () => {
      const owner = getFixtureOwnerDb()
      const bExamId = randomUUID()
      await owner.insert(exams).values({ id: bExamId, userId: userBId, name: 'B の試験' })
      await owner.insert(uploadOperations).values({
        userId: userBId,
        idempotencyKey: 'idem-b-live',
        examId: bExamId,
        sourceDocumentId: await seedSourceDoc(userBId, bExamId),
        status: 'processing',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        attemptCount: 1,
        expectedSourceCount: 1,
      })

      expect(await bothGates()).toEqual({ formHidden: false, submitBlocked: false })
    })
  })

  // --- (c) 冪等 replay: 同一 key は状態不問で同じ 3 ID に収束 ---
  describe('冪等 replay', () => {
    it('同一 key の 2 回目は同じ 3 ID を返し、行を重複させない', async () => {
      const input: SubmitUploadInput = {
        idempotencyKey: 'idem-replay-1',
        destination: { mode: 'new' },
      }
      const first = await asTenant(userAId, (tx) =>
        submitUploadTx(tx, { id: userAId }, input, twoFiles('replay')),
      )
      if (first.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${first.outcome}`)
      }

      const second = await asTenant(userAId, (tx) =>
        submitUploadTx(tx, { id: userAId }, input, twoFiles('replay-different')),
      )
      // 3 ID は一致し、replayed だけが false → true に変わる(呼出側が post-tx
      // phase を実行してよいのは replayed=false のときだけ)。
      expect(second).toEqual({ ...first, replayed: true })
      expect(first.replayed).toBe(false)

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
    })

    it.each(['completed', 'terminal_failed'] as const)(
      '既存 op が %s(終状態)でも同じ 3 ID を返す(状態不問)',
      async (status) => {
        const input: SubmitUploadInput = {
          idempotencyKey: `idem-replay-${status}`,
          destination: { mode: 'new' },
        }
        const first = await asTenant(userAId, (tx) =>
          submitUploadTx(tx, { id: userAId }, input, twoFiles('replay-terminal')),
        )
        if (first.outcome !== 'accepted') {
          throw new Error(`expected accepted, got ${first.outcome}`)
        }
        await getFixtureOwnerDb()
          .update(uploadOperations)
          .set({ status, leaseExpiresAt: null })
          .where(eq(uploadOperations.id, first.operationId))

        const second = await asTenant(userAId, (tx) =>
          submitUploadTx(tx, { id: userAId }, input, twoFiles('replay-terminal')),
        )
        expect(second).toEqual({ ...first, replayed: true })
      },
    )
  })

  // --- (d) daily cap ---
  describe('daily cap(GEMINI_DAILY_LIMIT)', () => {
    let originalDailyLimit: string | undefined
    const today = todayInJst()

    beforeEach(async () => {
      originalDailyLimit = process.env.GEMINI_DAILY_LIMIT
      process.env.GEMINI_DAILY_LIMIT = '5'
      await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
    })

    afterEach(async () => {
      if (originalDailyLimit === undefined) {
        delete process.env.GEMINI_DAILY_LIMIT
      } else {
        process.env.GEMINI_DAILY_LIMIT = originalDailyLimit
      }
      await getFixtureOwnerDb().delete(aiUsage).where(eq(aiUsage.date, today))
    })

    it('上限到達なら daily_limit_exceeded を返し、何も書かない', async () => {
      await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 5 })

      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-cap', destination: { mode: 'new' } },
          twoFiles('cap'),
        ),
      )
      expect(result).toEqual({ outcome: 'daily_limit_exceeded', current: 5, limit: 5 })
      await expectNoOperationsOrDocs(userAId)
      const examRows = await getFixtureOwnerDb()
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.userId, userAId))
      expect(examRows).toHaveLength(0)
    })

    it('上限未満なら通す', async () => {
      await getFixtureOwnerDb().insert(aiUsage).values({ date: today, count: 4 })
      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(
          tx,
          { id: userAId },
          { idempotencyKey: 'idem-under-cap', destination: { mode: 'new' } },
          twoFiles('under-cap'),
        ),
      )
      expect(result.outcome).toBe('accepted')
    })
  })

  // --- (e) action 経路(sync tx → 即応答 → after() で OCR → crop → publish)---
  describe('submitUpload(action・S-2 OCR phase + S-3 crop/publish + S-4 after())', () => {
    it('応答は sync tx の直後に返り、pipeline は after() の実行で completed になる', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      const result = await submitUpload(
        buildFormData(
          [await realImageFile('a.png'), await realImageFile('b.png')],
          'idem-action-1',
        ),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }
      // client 向けの戻り値に lease_version を出さない(client 往復の廃止)。
      expect(result).not.toHaveProperty('leaseVersion')

      const owner = getFixtureOwnerDb()

      // **応答時点では本処理は 1 度も走っていない**(即応答の実体)。
      expect(mockCallGemini).not.toHaveBeenCalled()
      const beforeAfter = await owner
        .select({ status: uploadOperations.status })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(beforeAfter[0]?.status).toBe('processing')

      // 応答後に platform が after() の callback を走らせる。
      expect(mockAfter).toHaveBeenCalledTimes(1)
      await runAfterTasks()
      const opRows = await owner
        .select({
          status: uploadOperations.status,
          lastErrorCode: uploadOperations.lastErrorCode,
          preparedSchemaVersion: uploadOperations.preparedSchemaVersion,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.status).toBe('completed')
      expect(opRows[0]?.lastErrorCode).toBeNull()
      expect(opRows[0]?.preparedSchemaVersion).toBe(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)

      for (const [name, spy] of Object.entries(r2Spies)) {
        expect(spy, `R2 client の ${name} が呼ばれた`).not.toHaveBeenCalled()
      }
    })

    it('decode できない file は OCR を呼ばずに terminal(op + doc failed)', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })

      // magic bytes は PNG だが本体は 0 埋め = sharp decode に失敗する。
      const result = await submitUpload(
        buildFormData([imageFile('a.png', 500)], 'idem-action-broken'),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }
      await runAfterTasks()

      const owner = getFixtureOwnerDb()
      const opRows = await owner
        .select({
          status: uploadOperations.status,
          lastErrorCode: uploadOperations.lastErrorCode,
          leaseExpiresAt: uploadOperations.leaseExpiresAt,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.status).toBe('terminal_failed')
      expect(opRows[0]?.lastErrorCode).toBe('image_decode_failed')
      expect(opRows[0]?.leaseExpiresAt).toBeNull()

      const docRows = await owner
        .select({ status: sourceDocuments.status })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.status).toBe('failed')
      expect(mockCallGemini).not.toHaveBeenCalled()
    })

    // 冪等 replay(transport retry)で OCR phase を再実行しないことの pin
    // (spec §4.3「再送のたびに Gemini を再実行しない」そのもの)。
    it('同一 key で action を 2 回呼んでも Gemini は 1 度しか走らない', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      const owner = getFixtureOwnerDb()
      const file = await realImageFile('a.png')

      const first = await submitUpload(buildFormData([file], 'idem-action-replay'))
      if (first.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${first.outcome}`)
      }
      await runAfterTasks()
      expect(first.replayed).toBe(false)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)

      // 1 回目の結果を「完了した operation」に置き換える(2 回目が誤って OCR phase を
      // 走らせたら必ず観測できる状態にする)。
      await owner
        .update(uploadOperations)
        .set({
          status: 'completed',
          lastErrorCode: null,
          preparedPayload: null,
          resultSummary: { cardsPublished: 3 },
        })
        .where(eq(uploadOperations.id, first.operationId))
      await owner
        .update(sourceDocuments)
        .set({ status: 'completed' })
        .where(eq(sourceDocuments.id, first.sourceDocumentId))

      const second = await submitUpload(buildFormData([file], 'idem-action-replay'))
      // replay は after() を登録すらしない(再送のたびに Gemini を再実行しない)。
      expect(mockAfter).toHaveBeenCalledTimes(1)
      await runAfterTasks()
      expect(second).toEqual({ ...first, replayed: true })
      expect(mockCallGemini).toHaveBeenCalledTimes(1)

      const opRows = await owner
        .select({
          status: uploadOperations.status,
          lastErrorCode: uploadOperations.lastErrorCode,
          resultSummary: uploadOperations.resultSummary,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, first.operationId))
      expect(opRows[0]?.status).toBe('completed')
      expect(opRows[0]?.lastErrorCode).toBeNull()
      expect(opRows[0]?.resultSummary).toEqual({ cardsPublished: 3 })

      const docRows = await owner
        .select({ status: sourceDocuments.status })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, first.sourceDocumentId))
      expect(docRows[0]?.status).toBe('completed')
    })

    // spec §4.4 の (a)〜(e) いずれにも属さない穴: after() の **登録** が失敗すると
    // callback が一度も走らず、pipeline 内部の catch も境界の catch も発火しない。
    // 同期側の terminal 化がこのクラスの唯一の検出経路。
    it('after() の登録が失敗したら同期側で op + doc を terminal 化する', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      mockAfter.mockImplementationOnce(() => {
        throw new Error('after() unavailable')
      })

      const result = await submitUpload(
        buildFormData([await realImageFile('a.png')], 'idem-after-register-fail'),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }

      // callback は 1 度も走っていない = Gemini も呼ばれない。
      expect(afterTasks).toHaveLength(0)
      expect(mockCallGemini).not.toHaveBeenCalled()

      const owner = getFixtureOwnerDb()
      const opRows = await owner
        .select({
          status: uploadOperations.status,
          lastErrorCode: uploadOperations.lastErrorCode,
          leaseExpiresAt: uploadOperations.leaseExpiresAt,
          preparedPayload: uploadOperations.preparedPayload,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.status).toBe('terminal_failed')
      expect(opRows[0]?.lastErrorCode).toBe('pipeline_unexpected_error')
      expect(opRows[0]?.leaseExpiresAt).toBeNull()
      expect(opRows[0]?.preparedPayload).toBeNull()

      // doc も同一 tx で failed(「processing のまま」を残さない)。
      const docRows = await owner
        .select({ status: sourceDocuments.status })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.status).toBe('failed')

      // 予期しない失敗ゆえ台帳にも 1 行載る(運用シグナル・PII-free)。
      const failures = await owner
        .select()
        .from(integrationFailures)
        .where(eq(integrationFailures.userId, userAId))
      expect(failures).toHaveLength(1)
      expect(failures[0]!.operation).toBe('upload.ocr_pipeline')
      expect(failures[0]!.context).toEqual({
        operationId: result.operationId,
        errorCode: 'pipeline_unexpected_error',
      })
    })
  })

  // --- (f) ②-4b T7: PDF manifest 経路の sentinel 値(spec D6) ---
  describe('②-4b T7: PDF manifest 経路(sentinel 値)', () => {
    function twoPdfFiles(prefix: string): SubmitUploadPdfMeta[] {
      return [
        { fileId: randomUUID(), filename: `${prefix}-1.pdf`, pageCount: 3, declaredBytes: 1000 },
        { fileId: randomUUID(), filename: `${prefix}-2.pdf`, pageCount: 5, declaredBytes: 2000 },
      ]
    }

    it('画像 + PDF 混在: fileType=pdf / pagesTotal=NULL / expectedSourceCount=0 sentinel', async () => {
      const pdfFiles = twoPdfFiles('mix')
      const input: SubmitUploadInput = {
        idempotencyKey: 'idem-pdf-mix',
        destination: { mode: 'new' },
      }
      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(tx, { id: userAId }, input, twoFiles('mix-img'), pdfFiles),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }

      const owner = getFixtureOwnerDb()
      const docRows = await owner
        .select({
          fileType: sourceDocuments.fileType,
          pagesTotal: sourceDocuments.pagesTotal,
          filename: sourceDocuments.filename,
          fileSizeBytes: sourceDocuments.fileSizeBytes,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.fileType).toBe('pdf')
      expect(docRows[0]?.pagesTotal).toBeNull()
      // filename 合成(D3「単一=原名/複数=Aほか N件」・「先頭」= 画像優先):
      // 画像 2 + PDF 2 = 合計 4 件。
      expect(docRows[0]?.filename).toBe('mix-img-1.png ほか 3 件')
      // fileSizeBytes = 画像 byteSize 合計(1000+2000)+ PDF declaredBytes 合計(1000+2000)。
      expect(docRows[0]?.fileSizeBytes).toBe(6000)

      const opRows = await owner
        .select({ expectedSourceCount: uploadOperations.expectedSourceCount })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.expectedSourceCount).toBe(0)
    })

    it('PDF のみ(画像 0 件): fileType=pdf / pagesTotal=NULL / expectedSourceCount=0 / filename は PDF 先頭', async () => {
      const pdfFiles = twoPdfFiles('pdfonly')
      const input: SubmitUploadInput = {
        idempotencyKey: 'idem-pdf-only',
        destination: { mode: 'new' },
      }
      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(tx, { id: userAId }, input, [], pdfFiles),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }
      const owner = getFixtureOwnerDb()
      const docRows = await owner
        .select({
          fileType: sourceDocuments.fileType,
          pagesTotal: sourceDocuments.pagesTotal,
          filename: sourceDocuments.filename,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.fileType).toBe('pdf')
      expect(docRows[0]?.pagesTotal).toBeNull()
      expect(docRows[0]?.filename).toBe('pdfonly-1.pdf ほか 1 件')

      const opRows = await owner
        .select({ expectedSourceCount: uploadOperations.expectedSourceCount })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.expectedSourceCount).toBe(0)
    })

    it('画像のみ(pdfFiles 省略)は従来値のまま不変(fileType=image / pagesTotal=枚数 / expectedSourceCount=枚数)', async () => {
      // 既存 test(本 describe 冒頭の「creates operation…」)が同じ保証を既に
      // カバーしているが、pdfFiles 引数追加後も default `[]` 経由で完全に
      // 同一の値になることをここで明示 pin する(brief 完了条件「画像のみ経路の
      // 従来値が不変であること」)。
      const input: SubmitUploadInput = {
        idempotencyKey: 'idem-img-unchanged',
        destination: { mode: 'new' },
      }
      const result = await asTenant(userAId, (tx) =>
        submitUploadTx(tx, { id: userAId }, input, twoFiles('unchanged')),
      )
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }
      const owner = getFixtureOwnerDb()
      const docRows = await owner
        .select({ fileType: sourceDocuments.fileType, pagesTotal: sourceDocuments.pagesTotal })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.fileType).toBe('image')
      expect(docRows[0]?.pagesTotal).toBe(2)
      const opRows = await owner
        .select({ expectedSourceCount: uploadOperations.expectedSourceCount })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.expectedSourceCount).toBe(2)
    })
  })

  // --- (g) ②-4b T7: 層 2 却下(spec D6・行ゼロ) ---
  describe('②-4b T7: layer 2 却下(行ゼロ)', () => {
    it('画像枚数 + Σecho pageCount > OCR_MAX_PAGES は tx を開かず、exam/source_document/upload_operation 行ゼロ(HEAD fan-out 前に却下)', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      const uploadSessionId = randomUUID()
      // fix round 2(Codex Important): headObject は mock しない — 層 2 の判定が
      // HEAD fan-out より前にあることをこの test 自体が強制する(呼ばれたら
      // mock 未設定で reject し見逃さない)。

      const fd = buildManifestFormData(
        [],
        [
          {
            fileId: randomUUID(),
            filename: 'big.pdf',
            pageCount: OCR_MAX_PAGES + 1,
            declaredBytes: 1000,
          },
        ],
        'idem-layer2-reject',
        uploadSessionId,
      )
      const result = await submitUpload(fd)
      expect(result.outcome).toBe('invalid_input')
      expect(r2Spies.headObject).not.toHaveBeenCalled()

      await expectNoOperationsOrDocs(userAId)
      const examRows = await getFixtureOwnerDb()
        .select({ id: exams.id })
        .from(exams)
        .where(eq(exams.userId, userAId))
      expect(examRows).toHaveLength(0)
      expect(mockCallGemini).not.toHaveBeenCalled()
    })

    it('層 2 の境界(合計ちょうど OCR_MAX_PAGES)は受理され、pagesTotal=NULL/expectedSourceCount=0 で行が作られる', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: userAId })
      const uploadSessionId = randomUUID()
      r2Spies.headObject.mockResolvedValue({ exists: true, contentLength: 1000 })

      const fd = buildManifestFormData(
        [],
        [
          {
            fileId: randomUUID(),
            filename: 'exact.pdf',
            pageCount: OCR_MAX_PAGES,
            declaredBytes: 1000,
          },
        ],
        'idem-layer2-boundary',
        uploadSessionId,
      )
      const result = await submitUpload(fd)
      if (result.outcome !== 'accepted') {
        throw new Error(`expected accepted, got ${result.outcome}`)
      }

      const owner = getFixtureOwnerDb()
      const docRows = await owner
        .select({
          fileType: sourceDocuments.fileType,
          pagesTotal: sourceDocuments.pagesTotal,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, result.sourceDocumentId))
      expect(docRows[0]?.fileType).toBe('pdf')
      expect(docRows[0]?.pagesTotal).toBeNull()
    })
  })
})

async function expectNoOperationsOrDocs(userId: string): Promise<void> {
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
}
