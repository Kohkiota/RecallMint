// ②-4a Task 14b′ observability fix(2026-08-03・OT 指示): purge の
// success-path observability(`lib/media/source-purge.ts`)を実 PG 上で検証する。
//
// 目的: purge は従来 成功時に無言だった — stg smoke が「purge が走って速かった」
// と「purge が一度も呼ばれていない」を区別できないのは、新軸の中核 action として
// 受容できないと判定された(coordinator 指示)。本 file は
// `purgeOperationSources`/`purgeOperationSourcesForOp` を直接叩き、
// `logger.info` が `source_purge.done`/`source_purge.noop` を正しい trigger 付きで
// 発火することを pin する(action 層経由の completeness は既存の
// claim/abandon/stage/publish/prepare-upload の iso test が別途担保済)。
//
// R2(deleteObject)・logger は mock する(実 R2 を叩かない・§C1 の禁則。
// logger は console.* 実装のため mock してアサーションを決定的にする)。
//
// mutating test ゆえ beforeEach で truncate→seed。
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb } from '@/lib/db'
import { exams, sourceAssets, sourceDocuments, uploadOperations, users } from '@/lib/db/schema'

import { closeFixtureOwnerDb, getFixtureOwnerDb, truncateAllUserTables } from './setup/fixture'

const { mockDeleteObject, mockLoggerInfo, mockLoggerError } = vi.hoisted(() => ({
  mockDeleteObject: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}))

vi.mock('@/lib/storage/r2', () => ({
  deleteObject: mockDeleteObject,
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: mockLoggerError },
}))

// vi.mock は import より前に hoist されるため top-level import で問題ない。
import { purgeOperationSources, purgeOperationSourcesForOp } from '@/lib/media/source-purge'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

async function seedUser(): Promise<string> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_${userId}` })
  return userId
}

async function seedExam(userId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const examId = randomUUID()
  await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
  return examId
}

async function seedSourceDocument(userId: string, examId: string): Promise<string> {
  const owner = getFixtureOwnerDb()
  const sourceDocumentId = randomUUID()
  await owner.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'image',
    filename: 'doc.png',
    fileSizeBytes: 100,
  })
  return sourceDocumentId
}

async function seedReadySourceAsset(
  userId: string,
  sourceDocumentId: string,
): Promise<{ id: string; objectKey: string }> {
  const owner = getFixtureOwnerDb()
  const id = randomUUID()
  const objectKey = `users/${userId}/src/${id}.png`
  await owner.insert(sourceAssets).values({
    id,
    userId,
    sourceDocumentId,
    sourceId: `s-${id}`,
    objectKey,
    status: 'ready',
    mime: 'image/png',
    byteSize: 100,
    originalFilename: 'a.png',
  })
  return { id, objectKey }
}

beforeEach(async () => {
  await truncateAllUserTables()
  mockDeleteObject.mockReset()
  mockDeleteObject.mockResolvedValue({ ok: true, status: 200 })
  mockLoggerInfo.mockReset()
  mockLoggerError.mockReset()
})

describe('purgeOperationSources — success-path observability(②-4a Task 14b′)', () => {
  it('purge した source があれば logger.info({event:"source_purge.done", trigger, ...}) を発火する(reclaimed に識別子+R2 key を含む)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    const { id, objectKey } = await seedReadySourceAsset(userId, sourceDocumentId)

    const summary = await purgeOperationSources(userId, sourceDocumentId, 'publish_completed')

    expect(summary.marked).toBe(1)
    expect(summary.rowDeleteOk).toBe(1)
    expect(summary.reclaimed).toEqual([{ sourceAssetId: id, objectKey }])

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'source_purge.done',
        trigger: 'publish_completed',
        userId,
        sourceDocumentId,
        marked: 1,
        r2DeleteOk: 1,
        r2Delete404: 0,
        r2DeleteFailed: 0,
        rowDeleteOk: 1,
        rowDeleteFailed: 0,
        reclaimed: [{ sourceAssetId: id, objectKey }],
      }),
    )
    // noop は発火しない(done と noop は排他)。
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'source_purge.noop' }),
    )
  })

  it('purge 対象が無ければ logger.info({event:"source_purge.noop", trigger, ...}) を発火する(呼ばれたが対象無し ≠ 呼ばれていない)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    // source_assets を一切 seed しない。

    const summary = await purgeOperationSources(userId, sourceDocumentId, 'claim_terminal')

    expect(summary.marked).toBe(0)
    expect(summary.reclaimed).toEqual([])
    expect(mockDeleteObject).not.toHaveBeenCalled()

    expect(mockLoggerInfo).toHaveBeenCalledWith({
      event: 'source_purge.noop',
      trigger: 'claim_terminal',
      userId,
      sourceDocumentId,
    })
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'source_purge.done' }),
    )
  })

  it('各 trigger 値がそのままログに透過する(union の 6 値を代表 4 件で確認・publish_terminal 含む)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    for (const trigger of ['stage_terminal', 'abandon', 'supersede', 'publish_terminal'] as const) {
      const sourceDocumentId = await seedSourceDocument(userId, examId)
      await purgeOperationSources(userId, sourceDocumentId, trigger)
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'source_purge.noop', trigger, sourceDocumentId }),
      )
    }
  })

  // Codex fix(2026-08-03 review・Important): 並行 purge(design が明示的に許容
  // する冪等 replay / defense-in-depth の二重呼出・例 abandon-operation.ts の
  // 'abandoned'/'completed' 両分岐)が同じ 'deleting' candidate を対象にした
  // 場合、後着の行 DELETE は 0 行に影響する。Drizzle は 0 行 DELETE で throw
  // しないため、`.returning()` の長さを見ずに rowDeleteOk++/reclaimed.push
  // すると、後着が「自分が reclaim した」と誤って telemetry に報告してしまう
  // (この fix 自体の目的=正確な telemetry に反する)。 真の並行呼出の
  // interleaving はタイミング依存で iso 上再現が不安定なため、`deleteObject`
  // mock の実装内で「R2 削除の裏で別プロセスが先に行 DELETE を終えていた」
  // 状況を決定的に再現する(reviewer 提示の代替アプローチ)。
  it('行 DELETE が 0 行(他の並行 purge が先に削除済)なら rowDeleteOk/reclaimed を増やさない(returning-count gate)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    const { id } = await seedReadySourceAsset(userId, sourceDocumentId)
    const owner = getFixtureOwnerDb()

    // R2 delete が成功で返る「裏」で、別の並行 purge 呼出が先に行 DELETE を
    // 終えていた状況を mock 内の副作用で再現する(この purge 呼出自身の行
    // DELETE が 0 行になる経路を決定的に踏む)。
    mockDeleteObject.mockImplementationOnce(async () => {
      await owner.delete(sourceAssets).where(eq(sourceAssets.id, id))
      return { ok: true, status: 200 }
    })

    const summary = await purgeOperationSources(userId, sourceDocumentId, 'publish_completed')

    expect(summary.marked).toBe(1) // mark 自体は普通に成功(この呼出が mark した)。
    expect(summary.r2DeleteOk).toBe(1) // R2 側は正常応答として計上される。
    expect(summary.rowDeleteOk).toBe(0) // 0 行 DELETE はカウントしない(fix の核心)。
    expect(summary.rowDeleteFailed).toBe(0) // throw していないので失敗計上でもない。
    expect(summary.reclaimed).toEqual([]) // 誤って reclaim 報告しない。

    // "done" ログ自体は出る(marked=1・candidates=1 で noop 条件に該当しない)
    // が、rowDeleteOk/reclaimed は正確に 0 を反映する。
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'source_purge.done',
        trigger: 'publish_completed',
        rowDeleteOk: 0,
        reclaimed: [],
      }),
    )
    // 行自体は既に(mock の副作用で)消えている。
    const remaining = await owner
      .select({ id: sourceAssets.id })
      .from(sourceAssets)
      .where(eq(sourceAssets.id, id))
    expect(remaining).toHaveLength(0)
  })
})

describe('purgeOperationSourcesForOp — observability(②-4a Task 14b′)', () => {
  it('source_document_id が null(FK SET NULL 済)の op は logger.info({event:"source_purge.noop", reason:"source_document_null"}) を発火する(purgeOperationSources 自体は呼ばれない)', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const owner = getFixtureOwnerDb()
    const operationId = randomUUID()
    await owner.insert(uploadOperations).values({
      id: operationId,
      userId,
      idempotencyKey: `idem-${operationId}`,
      examId,
      sourceDocumentId: null,
      status: 'terminal_failed',
      expectedSourceCount: 1,
    })

    // Finding 2(Minor・2026-08-03 review): purgeOperationSourcesForOp 側でも
    // 'publish_terminal' の trigger passthrough を確認する(union 6 値の
    // symmetry・完全性のみが目的で挙動リスクは無い)。
    await purgeOperationSourcesForOp(userId, operationId, 'publish_terminal')

    expect(mockDeleteObject).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledWith({
      event: 'source_purge.noop',
      trigger: 'publish_terminal',
      userId,
      operationId,
      reason: 'source_document_null',
    })
  })

  it('source_document_id を持つ op は purgeOperationSources へ trigger を透過し done ログが出る', async () => {
    const userId = await seedUser()
    const examId = await seedExam(userId)
    const sourceDocumentId = await seedSourceDocument(userId, examId)
    const { id, objectKey } = await seedReadySourceAsset(userId, sourceDocumentId)
    const owner = getFixtureOwnerDb()
    const operationId = randomUUID()
    await owner.insert(uploadOperations).values({
      id: operationId,
      userId,
      idempotencyKey: `idem-${operationId}`,
      examId,
      sourceDocumentId,
      status: 'terminal_failed',
      expectedSourceCount: 1,
    })

    await purgeOperationSourcesForOp(userId, operationId, 'stage_terminal')

    expect(mockDeleteObject).toHaveBeenCalledWith(objectKey)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'source_purge.done',
        trigger: 'stage_terminal',
        userId,
        sourceDocumentId,
        reclaimed: [{ sourceAssetId: id, objectKey }],
      }),
    )
    const remaining = await owner
      .select({ id: sourceAssets.id })
      .from(sourceAssets)
      .where(eq(sourceAssets.id, id))
    expect(remaining).toHaveLength(0)
  })
})
