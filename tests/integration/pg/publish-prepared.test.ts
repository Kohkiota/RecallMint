// ②-4a Task 12: publishPreparedUploadTx + orchestrator の実 PG 検証。
//
// 本 task の最重要不変条件 = **最終防衛 fencing**(stale lease_version の worker を
// 拒否しカード二重作成を防ぐ)。 それに加え保護 UPDATE 期待未満 fail / 冪等再 publish /
// crop 全滅 text publish / ON CONFLICT なし重複 loud fail / ロック順(happy path
// end-to-end)を実 RLS 下で検証する。
//
// R2(getObject/putObject)と Clerk(getCurrentUser)は mock(実 R2/実 Clerk を
// 叩かない)。 tx 系 test は publishPreparedUploadTx を直接叩く(crop/auth 不要)。
// orchestrator 系(crop 全滅)のみ publishPreparedUpload を叩く。
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
  sourceAssets,
  sourceDocuments,
  uploadOperations,
  uploadRecords,
  users,
  type CardImage,
} from '@/lib/db/schema'
import type { PreparedCard, PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockGetCurrentUser, mockGetObject, mockPutObject } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockGetObject: vi.fn(),
  mockPutObject: vi.fn(),
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))
vi.mock('@/lib/storage/r2', () => ({
  getObject: mockGetObject,
  putObject: mockPutObject,
}))

// vi.mock は import より前に hoist される。
import {
  publishPreparedUpload,
  publishPreparedUploadTx,
} from '@/app/(app)/app/upload/_actions/publish-prepared'

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
    status: 'awaiting_sources' | 'claimed' | 'prepared' | 'completed' | 'terminal_failed'
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

async function seedReadySourceAsset(
  userId: string,
  sourceDocumentId: string,
  sourceId: string,
  status: 'reserved' | 'ready' | 'deleting' = 'ready',
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const id = randomUUID()
  await owner.insert(sourceAssets).values({
    id,
    userId,
    sourceDocumentId,
    sourceId,
    objectKey: `users/${userId}/src/${id}.png`,
    mime: 'image/png',
    contentHash: `hash_${id}`,
    byteSize: 100,
    width: 100,
    height: 100,
    status,
    originalFilename: 'a.png',
    readyAt: status === 'ready' ? new Date() : null,
  })
  return id
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
  mockGetCurrentUser.mockReset()
  mockGetObject.mockReset()
  mockPutObject.mockReset()
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
    // upload_records.file_size_bytes = SUM(source_assets.byte_size)。 1 source(100B)。
    await seedReadySourceAsset(userId, sourceDocumentId, 's1', 'ready')
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
    expect(records[0]!.fileSizeBytes).toBe(100) // SUM(source_assets.byte_size)
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
      }),
    )
    expect(result).toEqual({ outcome: 'stale' })
    expect(await countCards(userA)).toBe(0)
    expect(await countCards(userB)).toBe(0)
    expect((await readOp(opB)).status).toBe('prepared')
  })
})

describe('publishPreparedUpload (T12 orchestrator) — crop 全滅 text publish', () => {
  it('全 figure が crop 不能(source 消失)でも text card を publish する(§8.3)', async () => {
    const userId = await seedUser()
    mockGetCurrentUser.mockResolvedValue({ id: userId })
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    // source_asset を reserved(= 未 ready)で seed → cropFigureAndStore は
    // source_not_ready を返す(R2 到達前)→ disposition 'exclude' → 全滅。
    await seedReadySourceAsset(userId, sourceDocumentId, 's1', 'reserved')

    const card = makePreparedCard({
      figures: [
        { assetId: randomUUID(), sourceId: 's1', box_2d: [0, 0, 100, 100], target: 'question_text', label: null },
      ],
    })
    const payload: PreparedPayloadV1 = {
      schemaVersion: 1,
      cards: [card],
      cardsTotal: 1,
      cardsExcluded: 0,
      figuresExcluded: { coordinate_null: 0, source_id_invalid: 0, malformed: 0, asset_id_invalid: 0 },
    }
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      preparedPayload: payload as unknown as Record<string, unknown>,
    })

    const result = await publishPreparedUpload({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'published', cardsPublished: 1, figuresAttached: 0 })

    const owner = getFixtureOwnerDb()
    const cardRows = await owner.select().from(cards).where(eq(cards.id, card.cardId))
    expect(cardRows).toHaveLength(1)
    expect(cardRows[0]!.images).toEqual([]) // text-only(crop 全滅)
    // refs は張られない。
    const refRows = await owner
      .select()
      .from(cardAssetRefs)
      .where(eq(cardAssetRefs.cardId, card.cardId))
    expect(refRows).toHaveLength(0)
    // op 完了 + payload NULL 化 + result_summary に crop_failed=1。
    const op = await readOp(operationId)
    expect(op.status).toBe('completed')
    expect(op.preparedPayload).toBeNull()
    const summary = op.resultSummary as { figuresExcluded: { crop_failed: number } }
    expect(summary.figuresExcluded.crop_failed).toBe(1)
  })

  it('Fix #1: source_document 削除済(source_document_id=NULL)は publish せず terminal_failed(cards 0)', async () => {
    const userId = await seedUser()
    mockGetCurrentUser.mockResolvedValue({ id: userId })
    const { examId } = await seedExamAndSourceDoc(userId)
    // source_document が T14 GC / T15 GDPR で削除された prepared op を模す
    // (FK onDelete:set null ⇒ source_document_id=NULL)。 payload は健全でも publish
    // してはならない(detached content 再作成 = privacy boundary)。
    const card = makePreparedCard()
    const payload: PreparedPayloadV1 = {
      schemaVersion: 1,
      cards: [card],
      cardsTotal: 1,
      cardsExcluded: 0,
      figuresExcluded: { coordinate_null: 0, source_id_invalid: 0, malformed: 0, asset_id_invalid: 0 },
    }
    const operationId = await seedPreparedOperation(userId, examId, null, {
      preparedPayload: payload as unknown as Record<string, unknown>,
    })

    const result = await publishPreparedUpload({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'failed', reason: 'source_document_deleted' })

    // 恒久失敗を fenced terminal で確定・cards は 1 枚も作らない。
    expect(await countCards(userId)).toBe(0)
    const op = await readOp(operationId)
    expect(op.status).toBe('terminal_failed')
    expect(op.preparedPayload).toBeNull()
    expect(op.lastErrorCode).toBe('source_document_deleted')
  })

  it('Fix #2: 破損 payload(parse 不能)は terminal_failed で確定(prepared のまま残さない)', async () => {
    const userId = await seedUser()
    mockGetCurrentUser.mockResolvedValue({ id: userId })
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    // schemaVersion=1 に一致するが V1 の必須 field を欠く = discriminated union は
    // V1 を選び inner validation で fail する(= parse throw の「破損」)。
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      preparedPayload: { schemaVersion: 1 } as unknown as Record<string, unknown>,
    })

    const result = await publishPreparedUpload({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'failed', reason: 'payload_corrupt' })

    const op = await readOp(operationId)
    expect(op.status).toBe('terminal_failed') // prepared のまま残さない(無限ループ防止)
    expect(op.preparedPayload).toBeNull()
    expect(await countCards(userId)).toBe(0)
  })

  it('Fix #2: 有効カード 0(空 payload)は terminal_failed で確定', async () => {
    const userId = await seedUser()
    mockGetCurrentUser.mockResolvedValue({ id: userId })
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    const emptyPayload: PreparedPayloadV1 = {
      schemaVersion: 1,
      cards: [],
      cardsTotal: 0,
      cardsExcluded: 0,
      figuresExcluded: { coordinate_null: 0, source_id_invalid: 0, malformed: 0, asset_id_invalid: 0 },
    }
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      preparedPayload: emptyPayload as unknown as Record<string, unknown>,
    })

    const result = await publishPreparedUpload({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'failed', reason: 'empty_payload' })

    const op = await readOp(operationId)
    expect(op.status).toBe('terminal_failed')
    expect(op.preparedPayload).toBeNull()
  })

  it('Fix round 2: prepared だが prepared_payload=NULL は terminal_failed で確定(T12b takeover 前に閉じる)', async () => {
    const userId = await seedUser()
    mockGetCurrentUser.mockResolvedValue({ id: userId })
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    // 正常 flow では到達不能(stage は payload と status='prepared' を atomic 書込)。
    // DB state としては表現可能なので直接構築する: prepared + payload NULL。
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      preparedPayload: null,
    })

    const result = await publishPreparedUpload({ operationId, leaseVersion: 1 })
    expect(result).toEqual({ outcome: 'failed', reason: 'prepared_without_payload' })

    const op = await readOp(operationId)
    expect(op.status).toBe('terminal_failed') // prepared のまま残さない(reclaim ループ防止)
    expect(op.lastErrorCode).toBe('prepared_without_payload')
    expect(await countCards(userId)).toBe(0)
  })

  it('fencing: stale lease_version は orchestrator 段でも stale(cards 作らない)', async () => {
    const userId = await seedUser()
    mockGetCurrentUser.mockResolvedValue({ id: userId })
    const { examId, sourceDocumentId } = await seedExamAndSourceDoc(userId)
    const card = makePreparedCard()
    const payload: PreparedPayloadV1 = {
      schemaVersion: 1,
      cards: [card],
      cardsTotal: 1,
      cardsExcluded: 0,
      figuresExcluded: { coordinate_null: 0, source_id_invalid: 0, malformed: 0, asset_id_invalid: 0 },
    }
    const operationId = await seedPreparedOperation(userId, examId, sourceDocumentId, {
      leaseVersion: 7,
      preparedPayload: payload as unknown as Record<string, unknown>,
    })

    const result = await publishPreparedUpload({ operationId, leaseVersion: 3 })
    expect(result).toEqual({ outcome: 'stale' })
    expect(await countCards(userId)).toBe(0)
  })
})
