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

import { closeDb } from '@/lib/db'
import {
  aiUsage,
  exams,
  sourceDocuments,
  uploadOperations,
  users,
} from '@/lib/db/schema'
import { todayInJst } from '@/lib/jst'
import { LEASE_TTL_MS } from '@/app/(app)/app/upload/_lib/constants'

const { mockGetCurrentUser, mockCallGemini, ...r2Spies } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockCallGemini: vi.fn(),
  presignPutUrl: vi.fn(),
  presignGetUrl: vi.fn(),
  headObject: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({ getCurrentUser: mockGetCurrentUser }))
// spec §2: 新経路は source を R2 に置かない(request body のバイトのみを使う)。
// R2 client の全 export を spy にして「1 度も呼ばれない」ことを pin する
// (将来 submit-upload が R2 を import したらここが落ちる)。
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
} from '@/app/(app)/app/upload/_actions/submit-upload'

import { asTenant } from './setup/as-tenant'
import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

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

describe('submitUploadTx (S-1)', () => {
  let userAId: string
  let userBId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    mockGetCurrentUser.mockReset()
    mockCallGemini.mockReset()
    mockCallGemini.mockResolvedValue(geminiOk())
    for (const spy of Object.values(r2Spies)) spy.mockReset()
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

  it('rejects an archived exam and writes nothing', async () => {
    const owner = getFixtureOwnerDb()
    const archivedExamId = randomUUID()
    await owner.insert(exams).values({
      id: archivedExamId,
      userId: userAId,
      name: 'アーカイブ済',
      archivedAt: new Date(),
    })

    const result = await asTenant(userAId, (tx) =>
      submitUploadTx(
        tx,
        { id: userAId },
        {
          idempotencyKey: 'idem-archived-1',
          destination: { mode: 'existing', examId: archivedExamId },
        },
        twoFiles('archived'),
      ),
    )
    expect(result).toEqual({ outcome: 'exam_not_found', archived: true })
    await expectNoOperationsOrDocs(userAId)
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
    expect(result).toEqual({ outcome: 'exam_not_found', archived: false })
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

    it.each(['claimed', 'prepared', 'processing'] as const)(
      'a %s operation with a valid lease blocks a different-key call (in_progress)',
      async (status) => {
        const owner = getFixtureOwnerDb()
        const seedExamId = randomUUID()
        await owner.insert(exams).values({ id: seedExamId, userId: userAId, name: 'seed exam' })
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
        mode: 'new',
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

    it('別テナントの live operation は gate に影響しない', async () => {
      const owner = getFixtureOwnerDb()
      const bExamId = randomUUID()
      await owner.insert(exams).values({ id: bExamId, userId: userBId, name: 'B の試験' })
      await owner.insert(uploadOperations).values({
        userId: userBId,
        idempotencyKey: 'idem-b-live',
        examId: bExamId,
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

  // --- (e) action 経路(sync tx → OCR phase)+ R2 呼出 0 ---
  describe('submitUpload(action・S-2 OCR phase)', () => {
    it('accepted を返し、同一 invocation で OCR まで走らせて prepared にする(R2 client 未使用)', async () => {
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
      const opRows = await owner
        .select({
          status: uploadOperations.status,
          lastErrorCode: uploadOperations.lastErrorCode,
          preparedSchemaVersion: uploadOperations.preparedSchemaVersion,
        })
        .from(uploadOperations)
        .where(eq(uploadOperations.id, result.operationId))
      expect(opRows[0]?.status).toBe('prepared')
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
