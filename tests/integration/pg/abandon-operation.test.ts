// ②-4a-cutover 案 D(2026-08-02・OT 確定): abandonUploadOperation の実 PG 検証。
//
// 案 D の核心 = 「UI は失敗した operation を resume せず失敗表示時に abandon する」。
// abandon は非終端 operation(client 所有)を terminal_failed へ確定し、prepared_payload /
// lease / next_retry を NULL 化し、**同一 tx で関連 source_document を failed 化**する
// (source_document を failed にしないと legacy 共存 gate の processing 検出で最大 15 分
// in_progress が継続する — OT critical 副次発見)。
//
// claimed / prepared の終端化は client が現在の lease_version を保持している時だけ許す
// (別 worker/takeover を clobber しない fencing)。completed は上書きしない。既に
// terminal は冪等成功。owner-scope で他ユーザーの operation は触れない。
//
// abandonUploadOperationTx は Clerk 認証を持たない(claim-operation と同型 — tx と user を
// 呼出側から受け取る)ため asTenant + Pick<User,'id'> で直接 exercise できる。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { exams, sourceDocuments, uploadOperations, users } from '@/lib/db/schema'
import { abandonUploadOperationTx } from '@/app/(app)/app/upload/_actions/abandon-operation'

import { asTenant } from './setup/as-tenant'
import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

type OpStatus = 'awaiting_sources' | 'claimed' | 'prepared' | 'completed' | 'terminal_failed'

type SeedOverrides = Partial<{
  status: OpStatus
  leaseVersion: number
  leaseExpiresAt: Date | null
  nextRetryAt: Date | null
  preparedPayload: Record<string, unknown> | null
  resultSummary: Record<string, unknown> | null
  docStatus: 'processing' | 'completed' | 'failed'
}>

async function seedOperation(
  userId: string,
  overrides: SeedOverrides = {},
): Promise<{ operationId: string; sourceDocumentId: string }> {
  const owner = getFixtureOwnerDb()
  const examId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'テスト試験' })
  const sourceDocumentId = randomUUID()
  await owner.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'image',
    filename: 'test.png',
    fileSizeBytes: 1000,
    status: overrides.docStatus ?? 'processing',
    pagesTotal: 1,
  })
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId,
    idempotencyKey: `idem-${operationId}`,
    examId,
    sourceDocumentId,
    status: overrides.status ?? 'awaiting_sources',
    leaseVersion: overrides.leaseVersion ?? 0,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    attemptCount: 0,
    nextRetryAt: overrides.nextRetryAt ?? null,
    preparedPayload: overrides.preparedPayload ?? null,
    resultSummary: overrides.resultSummary ?? null,
    expectedSourceCount: 1,
  })
  return { operationId, sourceDocumentId }
}

async function readOp(operationId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select({
      status: uploadOperations.status,
      leaseVersion: uploadOperations.leaseVersion,
      leaseExpiresAt: uploadOperations.leaseExpiresAt,
      nextRetryAt: uploadOperations.nextRetryAt,
      preparedPayload: uploadOperations.preparedPayload,
    })
    .from(uploadOperations)
    .where(eq(uploadOperations.id, operationId))
  return rows[0]
}

async function readDoc(sourceDocumentId: string) {
  const owner = getFixtureOwnerDb()
  const rows = await owner
    .select({ status: sourceDocuments.status })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
  return rows[0]
}

describe('abandonUploadOperationTx (案 D)', () => {
  let userAId: string
  let userBId: string

  beforeEach(async () => {
    await truncateAllUserTables()
    const owner = getFixtureOwnerDb()
    userAId = randomUUID()
    userBId = randomUUID()
    await owner.insert(users).values([
      { id: userAId, clerkId: `clerk_A_${userAId}` },
      { id: userBId, clerkId: `clerk_B_${userBId}` },
    ])
  })

  it('awaiting_sources → abandoned; operation=terminal_failed かつ source_document=failed', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'awaiting_sources',
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId }),
    )

    expect(res.outcome).toBe('abandoned')
    expect((await readOp(operationId)).status).toBe('terminal_failed')
    // OT critical 副次発見: doc を failed にしないと legacy gate に引っかかる。
    expect((await readDoc(sourceDocumentId)).status).toBe('failed')
  })

  it('claimed + 一致 lease_version → abandoned; payload/lease/next_retry を NULL 化 + doc failed', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'claimed',
      leaseVersion: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      nextRetryAt: new Date(Date.now() + 60_000),
      preparedPayload: { foo: 'bar' },
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId, leaseVersion: 3 }),
    )

    expect(res.outcome).toBe('abandoned')
    const op = await readOp(operationId)
    expect(op.status).toBe('terminal_failed')
    expect(op.preparedPayload).toBeNull()
    expect(op.leaseExpiresAt).toBeNull()
    expect(op.nextRetryAt).toBeNull()
    expect((await readDoc(sourceDocumentId)).status).toBe('failed')
  })

  it('prepared + 一致 lease_version(payload 保持中)→ abandoned; payload NULL 化 + doc failed', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'prepared',
      leaseVersion: 2,
      leaseExpiresAt: null,
      preparedPayload: { cards: [1, 2, 3] },
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId, leaseVersion: 2 }),
    )

    expect(res.outcome).toBe('abandoned')
    const op = await readOp(operationId)
    expect(op.status).toBe('terminal_failed')
    expect(op.preparedPayload).toBeNull()
    expect((await readDoc(sourceDocumentId)).status).toBe('failed')
  })

  it('claimed + 不一致 lease_version → stale; operation/doc は不変(clobber しない)', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'claimed',
      leaseVersion: 5,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId, leaseVersion: 4 }),
    )

    expect(res.outcome).toBe('stale')
    expect((await readOp(operationId)).status).toBe('claimed')
    expect((await readDoc(sourceDocumentId)).status).toBe('processing')
  })

  it('claimed + leaseVersion 未指定 → stale(所有証明なし・clobber しない)', async () => {
    const { operationId } = await seedOperation(userAId, {
      status: 'claimed',
      leaseVersion: 1,
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId }),
    )

    expect(res.outcome).toBe('stale')
    expect((await readOp(operationId)).status).toBe('claimed')
  })

  it('completed → completed(上書きしない); sourceDocumentId を返す', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'completed',
      docStatus: 'completed',
      resultSummary: { cardsPublished: 4 },
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId }),
    )

    expect(res).toEqual({ outcome: 'completed', sourceDocumentId })
    expect((await readOp(operationId)).status).toBe('completed')
    expect((await readDoc(sourceDocumentId)).status).toBe('completed')
  })

  it('terminal_failed → abandoned(冪等)。server-side terminalize が残した processing doc を failed 化する', async () => {
    // claim/stage/publish の terminal_failed は op のみ terminal 化し source_document を
    // processing のまま残す。UI はその後 abandon を呼ぶが op は既に terminal ゆえ、
    // abandon が doc を failed にしないと legacy 共存 gate で最大 15 分 block される
    // (canonical Important #1)。
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'terminal_failed',
      preparedPayload: null,
      docStatus: 'processing', // server-side terminalize は doc を触らない
    })

    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId }),
    )

    expect(res.outcome).toBe('abandoned')
    expect((await readOp(operationId)).status).toBe('terminal_failed')
    // doc は failed 化される(legacy gate の 15 分 block を防ぐ)。
    expect((await readDoc(sourceDocumentId)).status).toBe('failed')
  })

  it('存在しない operationId → not_found', async () => {
    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId: randomUUID() }),
    )
    expect(res.outcome).toBe('not_found')
  })

  it('非 UUID の operationId → not_found(Postgres cast error 化を防ぐ)', async () => {
    const res = await asTenant(userAId, (tx) =>
      abandonUploadOperationTx(tx, { id: userAId }, { operationId: 'not-a-uuid' }),
    )
    expect(res.outcome).toBe('not_found')
  })

  it('owner 分離: user B は user A の operation を abandon できない(not_found・不変)', async () => {
    const { operationId, sourceDocumentId } = await seedOperation(userAId, {
      status: 'awaiting_sources',
    })

    const res = await asTenant(userBId, (tx) =>
      abandonUploadOperationTx(tx, { id: userBId }, { operationId }),
    )

    expect(res.outcome).toBe('not_found')
    // user A の operation/doc は無傷。
    expect((await readOp(operationId)).status).toBe('awaiting_sources')
    expect((await readDoc(sourceDocumentId)).status).toBe('processing')
  })
})
