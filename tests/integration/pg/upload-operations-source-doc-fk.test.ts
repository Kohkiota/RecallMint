// Sprint B (DB 全体掃除) Task 8: `upload_operations.source_document_id` の
// NOT NULL 化 + FK `ON DELETE SET NULL → CASCADE` 張替え (migration 0036・spec §5.1) を
// 実 PG で pin する。
//
// なぜ 3 経路に分けるか (spec §5.1 / Codex r3 指摘 8): 「operation が消える」ことは経路ごとに
// 別の DDL が担う。exam cascade は exam_id FK、退会 handler は exams への明示 DELETE 起点の
// 同じ chain、source_documents の直接 DELETE だけが今回張り替えた source_document_id FK を
// 直接刺激する。3 つ目が本 task の本丸で、旧 SET NULL のままなら NOT NULL 違反 (23502) に、
// NO ACTION なら FK 違反 (23503) になる — つまり「エラーにならず行が消える」ことが
// CASCADE であることの behavioral な証明になっている。
//
// 併せて NOT NULL 自体を INSERT 側から pin する (23502)。
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 退会 handler (経路 b) は外部 I/O を伴う。lifecycle-behavioral.test.ts と同じ遮断構成で
// Stripe / Clerk API / Discord / R2 を mock し、DB 側の挙動だけを見る。
const {
  stripeListMock,
  stripeRetrieveMock,
  cancelWithRetryMock,
  syncMetadataMock,
  notifyOpsMock,
  notifyWebhookErrorMock,
  recordFailureMock,
  listObjectsBoundedMock,
  deleteObjectMock,
} = vi.hoisted(() => ({
  stripeListMock: vi.fn(() => (async function* () {})()),
  stripeRetrieveMock: vi.fn(),
  cancelWithRetryMock: vi.fn().mockResolvedValue(undefined),
  syncMetadataMock: vi.fn().mockResolvedValue({ ok: true }),
  notifyOpsMock: vi.fn().mockResolvedValue(undefined),
  notifyWebhookErrorMock: vi.fn().mockResolvedValue(undefined),
  recordFailureMock: vi.fn().mockResolvedValue(undefined),
  listObjectsBoundedMock: vi.fn().mockResolvedValue({ keys: [], truncated: false }),
  deleteObjectMock: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
}))

vi.mock('@/lib/stripe/client', () => ({
  stripe: { subscriptions: { list: stripeListMock, retrieve: stripeRetrieveMock } },
  cancelWithRetry: cancelWithRetryMock,
}))
vi.mock('@/lib/auth/clerk-metadata', () => ({ syncClerkPublicMetadata: syncMetadataMock }))
vi.mock('@/lib/ops', () => ({
  notifyOps: notifyOpsMock,
  notifyWebhookError: notifyWebhookErrorMock,
}))
vi.mock('@/lib/integration-failures', () => ({ recordIntegrationFailure: recordFailureMock }))
vi.mock('@/lib/storage/r2', async (importOriginal) => {
  const { LIST_TIMEOUT_MS, DELETE_TIMEOUT_MS } =
    await importOriginal<typeof import('@/lib/storage/r2')>()
  return {
    LIST_TIMEOUT_MS,
    DELETE_TIMEOUT_MS,
    listObjectsBounded: listObjectsBoundedMock,
    deleteObject: deleteObjectMock,
  }
})

import { closeDb } from '@/lib/db'
import { hasSqlState } from '@/lib/db/p0rls'
import { exams, sourceDocuments, uploadOperations, users } from '@/lib/db/schema'
import { handleEvent as handleClerkEvent } from '@/lib/clerk/handle-clerk-event'

import {
  type TenantFixture,
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  seedTwoTenants,
  truncateAllUserTables,
} from './setup/fixture'

let fixture: TenantFixture

async function operationIdsOf(userId: string): Promise<string[]> {
  const rows = await getFixtureOwnerDb()
    .select({ id: uploadOperations.id })
    .from(uploadOperations)
    .where(eq(uploadOperations.userId, userId))
  return rows.map((r) => r.id)
}

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

beforeEach(async () => {
  await truncateAllUserTables()
  fixture = await seedTwoTenants()
  vi.clearAllMocks()
  stripeListMock.mockImplementation(() => (async function* () {})())
  cancelWithRetryMock.mockResolvedValue(undefined)
  syncMetadataMock.mockResolvedValue({ ok: true })
  notifyOpsMock.mockResolvedValue(undefined)
  notifyWebhookErrorMock.mockResolvedValue(undefined)
  recordFailureMock.mockResolvedValue(undefined)
  listObjectsBoundedMock.mockResolvedValue({ keys: [], truncated: false })
  deleteObjectMock.mockResolvedValue({ ok: true, status: 204 })
})

describe('upload_operations.source_document_id — NOT NULL', () => {
  it('source_document_id 無しの INSERT は 23502 で拒否される', async () => {
    let caught: unknown
    let resolved = false
    try {
      await getFixtureOwnerDb().execute(
        sql`INSERT INTO upload_operations (user_id, idempotency_key, exam_id, expected_source_count)
            VALUES (${fixture.a.userId}::uuid, 'no_source_doc', ${fixture.a.examId}::uuid, 1)`,
      )
      resolved = true
    } catch (e) {
      caught = e
    }
    expect(resolved, 'source_document_id 省略の INSERT が通ってしまった').toBe(false)
    expect(hasSqlState(caught, '23502'), `got ${String(caught)}`).toBe(true)
  })
})

describe('upload_operations.source_document_id — 削除 3 経路で行が残らない', () => {
  it('(a) exam 削除の cascade', async () => {
    expect(await operationIdsOf(fixture.a.userId)).toHaveLength(1)

    // throw しないこと自体が assertion (エラーになれば test は fail する)。
    await getFixtureOwnerDb().delete(exams).where(eq(exams.id, fixture.a.examId))

    expect(await operationIdsOf(fixture.a.userId)).toHaveLength(0)
    // 非空振り: 別テナントの operation は無関係に生き残る。
    expect(await operationIdsOf(fixture.b.userId)).toHaveLength(1)
  })

  it('(b) 退会 handler (handleUserDeleted の exams 明示 DELETE)', async () => {
    const [row] = await getFixtureOwnerDb()
      .select({ clerkId: users.clerkId })
      .from(users)
      .where(eq(users.id, fixture.a.userId))
    expect(row?.clerkId).toBeTruthy()
    expect(await operationIdsOf(fixture.a.userId)).toHaveLength(1)

    await expect(
      handleClerkEvent({ type: 'user.deleted', data: { id: row!.clerkId! } }, Date.now()),
    ).resolves.toBeUndefined()

    expect(await operationIdsOf(fixture.a.userId)).toHaveLength(0)
    expect(await operationIdsOf(fixture.b.userId)).toHaveLength(1)
  })

  it('(c) source_documents の直接 DELETE (張り替えた FK を直接刺激)', async () => {
    expect(await operationIdsOf(fixture.a.userId)).toHaveLength(1)

    // 旧 SET NULL なら NOT NULL 違反 (23502)、NO ACTION なら FK 違反 (23503) になる箇所。
    // throw しないこと自体が assertion。
    await getFixtureOwnerDb()
      .delete(sourceDocuments)
      .where(eq(sourceDocuments.id, fixture.a.sourceDocumentId))

    expect(await operationIdsOf(fixture.a.userId)).toHaveLength(0)
    expect(await operationIdsOf(fixture.b.userId)).toHaveLength(1)
  })
})
