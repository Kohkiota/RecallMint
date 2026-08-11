// ②-4a Task 12 / S-5: publishPreparedUploadTx の実 PG 検証。
//
// 最重要不変条件 = **最終防衛 fencing**(stale lease_version の worker を拒否し
// カード二重作成を防ぐ)。 それに加え保護 UPDATE 期待未満 fail / 冪等再 publish /
// ON CONFLICT なし重複 loud fail / ロック順(happy path end-to-end)を
// 実 RLS 下で検証する。
//
// **S-5(旧経路撤去)で削除した describe**: 公開 action `publishPreparedUpload` と
// 内部 orchestrator `runPublishPrepared`(crop 全滅 text publish / deadline_excluded /
// payload 読取 guard 群)、および source purge の主経路。いずれも撤去した
// 旧経路 file(`_lib/publish-prepared-orchestrate.ts` / `lib/media/source-purge.ts`)が
// 対象で、**対象そのものが消えた**。同等の保証は新経路側にある:
//   ・crop 全滅 → text publish  = tests/integration/pg/upload-pipeline.test.ts
//   ・deadline_excluded の計上   = app/(app)/app/upload/_lib/upload-pipeline.test.ts
//                                 + _lib/publish-prepared-plan.test.ts(pure)
//   ・orchestrator 段の fencing  = 本 file 冒頭の tx 段 fencing test(同じ CAS)
//
// tx 系 test は publishPreparedUploadTx を直接叩く(crop/auth 不要)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { getCurrentMonthOcrPages } from '@/lib/ai-usage-mcq'
import {
  assets,
  cardAssetRefs,
  cards,
  exams,
  sourceDocuments,
  uploadOperations,
  uploadRecords,
  users,
  type CardImage,
} from '@/lib/db/schema'
import { initialFsrsState } from '@/lib/cards/domain/initial-fsrs-state'
import type { PreparedCard } from '@/lib/ocr/prepared-schema'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

// publish-prepared.ts は R2 を import しないが、同 module graph の
// upload-persistence 経由で server-only guard に触れうるため、既存どおり
// R2 client 全体を無害な mock で塞ぐ(実 R2 を叩かない)。
const { mockGetObject, mockPutObject, mockDeleteObject } = vi.hoisted(() => ({
  mockGetObject: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => ({
  getObject: mockGetObject,
  putObject: mockPutObject,
  deleteObject: mockDeleteObject,
}))

// vi.mock は import より前に hoist される。
import { publishPreparedUploadTx } from '@/app/(app)/app/upload/_actions/publish-prepared'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_${userId}` })
  return userId
}

async function seedExamAndSourceDoc(userId: string): Promise<{ examId: string; sourceDocumentId: string }> {
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
  })
  return { examId, sourceDocumentId }
}

async function seedPreparedOperation(
  userId: string,
  examId: string,
  sourceDocumentId: string | null,
  overrides: Partial<{
    status: 'prepared' | 'processing' | 'completed' | 'terminal_failed'
    leaseVersion: number
    preparedPayload: Record<string, unknown> | null
  }> = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId,
    idempotencyKey: `idem-${operationId}`,
    examId,
    sourceDocumentId,
    status: overrides.status ?? 'prepared',
    leaseVersion: overrides.leaseVersion ?? 1,
    leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    expectedSourceCount: 1,
    preparedPayload: overrides.preparedPayload ?? null,
  })
  return operationId
}

// crop-derived asset(既に crop 済みと想定)を ready で seed する。 unreferencedAt を
// 明示的に非 null で入れ、 保護 UPDATE が NULL 化することを観測可能にする。
async function seedReadyCropAsset(userId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const assetId = randomUUID()
  await owner.insert(assets).values({
    id: assetId,
    userId,
    objectKey: `users/${userId}/${assetId}.webp`,
    mime: 'image/webp',
    byteSize: 100,
    width: 10,
    height: 10,
    hash: `hash_${assetId}`,
    status: 'ready',
    unreferencedAt: new Date('2026-07-01T00:00:00Z'),
  })
  return assetId
}

function makePreparedCard(overrides: Partial<PreparedCard> = {}): PreparedCard {
  return {
    cardId: randomUUID(),
    title: 'T',
    sortKey: null,
    questionText: 'Q?',
    options: [
      { id: 'a', uid: randomUUID(), text: 'A', isCorrect: true },
      { id: 'b', uid: randomUUID(), text: 'B', isCorrect: false },
    ],
    correctAnswerIds: ['a'],
    explanationText: null,
    memo: null,
    figures: [],
    customProps: {},
    ...overrides,
  }
}

async function countCards(userId: string): Promise<number> {
  const owner = getFixtureOwnerDb()
  const rows = await owner.select({ id: cards.id }).from(cards).where(eq(cards.userId, userId))
  return rows.length
}

async function readOp(operationId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select()
    .from(uploadOperations)
    .where(eq(uploadOperations.id, operationId))
  return rows[0]!
}

async function readExamCardCount(examId: string): Promise<number> {
  const owner = getFixtureOwnerDb()
  const rows = await owner.select({ cardCount: exams.cardCount }).from(exams).where(eq(exams.id, examId))
  return rows[0]!.cardCount
}

async function readSourceDoc(sourceDocumentId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
  return rows[0]!
}

async function readUploadRecords(userId: string) {
  const owner = getFixtureOwnerDb()
  return owner.select().from(uploadRecords).where(eq(uploadRecords.userId, userId))
}

beforeEach(async () => {
  await truncateAllUserTables()
  mockGetObject.mockReset()
  mockPutObject.mockReset()
  mockDeleteObject.mockReset()
  mockDeleteObject.mockResolvedValue({ ok: true, status: 200 })
})

describe('publishPreparedUploadTx (T12) — fencing / lock-order / protective / idempotent', () => {
  it('FINAL-DEFENSE fencing: stale lease_version は publish を拒否(cards を作らない)', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    // DB 上の operation は lease_version=5(takeover 後の新 version)。
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      leaseVersion: 5,
    })
    const card = makePreparedCard()

    // 旧 worker は自分が握る lease_version=3 で publish しようとする。
    const result = await withTenantTx(userId, (tx) =>
      publishPreparedUploadTx(tx, {
        userId,
        operationId,
        leaseVersion: 3,
        cards: [card],
        cardImagesByCardId: {},
        resultSummary: { marker: 'stale-attempt' },
        fileSizeBytes: 0,
      }),
    )
    expect(result).toEqual({ outcome: 'stale' })

    // カードは 1 枚も作られない・operation は完了しない・payload/status 不変。
    expect(await countCards(userId)).toBe(0)
    const op = await readOp(operationId)
    expect(op.status).toBe('prepared')
    expect(op.leaseVersion).toBe(5)
    expect(op.completedAt).toBeNull()
  })

  it('happy publish(ロック順 end-to-end): cards + refs + counter + finalize を 1 tx で確定', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      leaseVersion: 2,
    })
    const cropAssetId = await seedReadyCropAsset(userId)
    const card = makePreparedCard()
    const image: CardImage = { key: cropAssetId, target: 'question_text', alt: '' }

    const result = await withTenantTx(userId, (tx) =>
      publishPreparedUploadTx(tx, {
        userId,
        operationId,
        leaseVersion: 2,
        cards: [card],
        cardImagesByCardId: { [card.cardId]: [image] },
        resultSummary: { marker: 'published' },
        // Task S-3: 記帳値は引数で決まる(tx は source 台帳を読まない)。
        fileSizeBytes: 4242,
      }),
    )
    expect(result).toEqual({ outcome: 'published' })

    const owner = getFixtureOwnerDb()
    // card 行(images に crop asset)。
    const cardRows = await owner.select().from(cards).where(eq(cards.id, card.cardId))
    expect(cardRows).toHaveLength(1)
    expect(cardRows[0]!.images).toEqual([image])
    expect(cardRows[0]!.options).toEqual([
      { id: 'a', uid: card.options[0].uid, text: 'A', is_correct: true },
      { id: 'b', uid: card.options[1].uid, text: 'B', is_correct: false },
    ])
    // ref 行(T11 projection)。
    const refRows = await owner
      .select()
      .from(cardAssetRefs)
      .where(eq(cardAssetRefs.cardId, card.cardId))
    expect(refRows).toHaveLength(1)
    expect(refRows[0]!.assetId).toBe(cropAssetId)
    expect(refRows[0]!.fieldKey).toBe('question_text')
    // 保護 UPDATE が unreferencedAt を NULL 化。
    const assetRows = await owner.select().from(assets).where(eq(assets.id, cropAssetId))
    expect(assetRows[0]!.unreferencedAt).toBeNull()
    // counter + finalize。
    expect(await readExamCardCount(examId)).toBe(1)
    const op = await readOp(operationId)
    expect(op.status).toBe('completed')
    expect(op.preparedPayload).toBeNull()
    expect(op.resultSummary).toEqual({ marker: 'published' })
    expect(op.completedAt).not.toBeNull()

    // fix round 3(A): source_documents finalize。
    const sd = await readSourceDoc(sourceDocumentId)
    expect(sd.status).toBe('completed')
    expect(sd.pagesProcessed).toBe(1) // expected_source_count(seed=1)
    expect(sd.cardsExtracted).toBe(1) // published card 数
    expect(sd.completedAt).not.toBeNull()

    // fix round 3(B): upload_records 台帳(月次 quota SUM 対象)。
    const records = await readUploadRecords(userId)
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('completed')
    expect(records[0]!.pagesProcessed).toBe(1) // 実 source 画像数(0 でない)
    expect(records[0]!.fileSizeBytes).toBe(4242) // 引数で渡した値がそのまま入る
    expect(records[0]!.ocrCostYen).toBeNull() // 新 flow は cost を持たない
    expect(records[0]!.filename).toBe('a.png') // source_documents.filename
    // 月次 quota SUM がこの行を数える(記帳の実効を pin・enforcement は ②-5)。
    const monthPages = await withTenantTx(userId, (tx) => getCurrentMonthOcrPages(userId, tx))
    expect(monthPages).toBe(1)
  })

  it('保護 UPDATE 期待未満(crop asset が deleting)→ throw + rollback(cards 0・op prepared)', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId)
    // ready でない crop asset(GC で deleting 化した想定)を参照する。
    const owner = getFixtureOwnerDb()
    const deletingAssetId = randomUUID()
    await owner.insert(assets).values({
      id: deletingAssetId,
      userId,
      objectKey: `users/${userId}/${deletingAssetId}.webp`,
      mime: 'image/webp',
      byteSize: 100,
      width: 10,
      height: 10,
      hash: `hash_${deletingAssetId}`,
      status: 'deleting',
    })
    const card = makePreparedCard()
    const image: CardImage = { key: deletingAssetId, target: 'question_text', alt: '' }

    await expect(
      withTenantTx(userId, (tx) =>
        publishPreparedUploadTx(tx, {
          userId,
          operationId,
          leaseVersion: 1,
          cards: [card],
          cardImagesByCardId: { [card.cardId]: [image] },
          resultSummary: {},
          fileSizeBytes: 0,
        }),
      ),
    ).rejects.toThrow()

    // rollback: cards 0・op は prepared のまま。
    expect(await countCards(userId)).toBe(0)
    expect((await readOp(operationId)).status).toBe('prepared')
    // fix round 3: source_documents finalize + upload_records も同 tx ゆえ rollback。
    expect((await readSourceDoc(sourceDocumentId)).status).toBe('processing')
    expect(await readUploadRecords(userId)).toHaveLength(0)
  })

  it('冪等: 同 op を 2 回 publish しても card 数は増えない(2 回目は fencing で stale)', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId)
    const card = makePreparedCard()

    const first = await withTenantTx(userId, (tx) =>
      publishPreparedUploadTx(tx, {
        userId,
        operationId,
        leaseVersion: 1,
        cards: [card],
        cardImagesByCardId: {},
        resultSummary: { n: 1 },
        fileSizeBytes: 0,
      }),
    )
    expect(first).toEqual({ outcome: 'published' })
    expect(await countCards(userId)).toBe(1)
    expect(await readExamCardCount(examId)).toBe(1)

    // 2 回目: op は completed(status !== 'prepared')ゆえ fencing で stale。
    const second = await withTenantTx(userId, (tx) =>
      publishPreparedUploadTx(tx, {
        userId,
        operationId,
        leaseVersion: 1,
        cards: [card],
        cardImagesByCardId: {},
        resultSummary: { n: 2 },
        fileSizeBytes: 0,
      }),
    )
    expect(second).toEqual({ outcome: 'stale' })
    expect(await countCards(userId)).toBe(1) // 増えない
    expect(await readExamCardCount(examId)).toBe(1) // 増えない
  })

  it('cards に ON CONFLICT なし: 既存 card id と衝突すると loud fail(throw + rollback・他 card も未挿入)', async () => {
    const userId = await seedUser()
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId)
    const dupCard = makePreparedCard()
    const otherCard = makePreparedCard()
    // dupCard.cardId と同一 id の card を事前に挿入(衝突を作る)。
    const owner = getFixtureOwnerDb()
    await owner.insert(cards).values({
      id: dupCard.cardId,
      userId,
      examId,
      title: 'pre-existing',
      questionText: 'pre?',
      options: [{ id: 'a', uid: randomUUID(), text: 'A', is_correct: true }],
      correctAnswerIds: ['a'],
      ...initialFsrsState(new Date()),
    })

    await expect(
      withTenantTx(userId, (tx) =>
        publishPreparedUploadTx(tx, {
          userId,
          operationId,
          leaseVersion: 1,
          cards: [dupCard, otherCard],
          cardImagesByCardId: {},
          resultSummary: {},
          fileSizeBytes: 0,
        }),
      ),
    ).rejects.toThrow()

    // loud fail = swallow しない: 既存 1 枚のみ・otherCard は rollback で未挿入。
    expect(await countCards(userId)).toBe(1)
    const owner2 = getFixtureOwnerDb()
    const otherRows = await owner2.select().from(cards).where(eq(cards.id, otherCard.cardId))
    expect(otherRows).toHaveLength(0)
    // op も prepared のまま(finalize 未到達)。
    expect((await readOp(operationId)).status).toBe('prepared')
    // fix round 3: source_documents finalize + upload_records も同 tx ゆえ rollback。
    expect((await readSourceDoc(sourceDocumentId)).status).toBe('processing')
    expect(await readUploadRecords(userId)).toHaveLength(0)
  })

  it('tenancy: 他 user の operation は publish できない(owner scope で stale・cards 作らない)', async () => {
    const userA = await seedUser()
    const userB = await seedUser()
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userB)
    const opB = await seedPreparedOperation(userB, examId, sourceDocumentId)
    const card = makePreparedCard()

    // userA が userB の operation を騙って publish(RLS + owner scope WHERE)。
    const result = await withTenantTx(userA, (tx) =>
      publishPreparedUploadTx(tx, {
        userId: userA,
        operationId: opB,
        leaseVersion: 1,
        cards: [card],
        cardImagesByCardId: {},
        resultSummary: {},
        fileSizeBytes: 0,
      }),
    )
    expect(result).toEqual({ outcome: 'stale' })
    expect(await countCards(userA)).toBe(0)
    expect(await countCards(userB)).toBe(0)
    expect((await readOp(opB)).status).toBe('prepared')
  })
})
