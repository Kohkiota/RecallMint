// ②-4a T16-a: `getLatestCompletedUploadSummary` の op 選択規則を実 PG で pin する。
//
// なぜ実 PG か: 選択規則は「WHERE status='completed'」+「ORDER BY completed_at DESC,
// id DESC LIMIT 1」という SQL そのものであり、mock では規則ではなく mock の返し値を
// 検証してしまう。 1 doc に複数 op が並ぶのは replay / supersede のときで、supersede
// された側は terminal になる — terminal を拾うと result_summary が NULL のため
// 「何も取り込めなかった」と誤誘導する。
//
// 何を保証しないか: summary の中身の検証(読み手側 `buildUploadResultSummaryView` の
// unit が持つ)と、page の描画。
//
// mutating test ゆえ beforeEach で truncate→seed(write-isolation.test.ts と同規約)。
import { randomUUID } from 'node:crypto'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { closeDb } from '@/lib/db'
import { withTenantTx } from '@/lib/db/tenant-tx'
import { exams, sourceDocuments, uploadOperations, users } from '@/lib/db/schema'
import { getLatestCompletedUploadSummary } from '@/lib/exams/list'

import {
  closeFixtureOwnerDb,
  getFixtureOwnerDb,
  truncateAllUserTables,
} from './setup/fixture'

afterAll(async () => {
  await closeDb()
  await closeFixtureOwnerDb()
})

const T0 = new Date('2026-08-05T00:00:00.000Z')

async function seedDoc(): Promise<{
  userId: string
  examId: string
  sourceDocumentId: string
}> {
  const owner = getFixtureOwnerDb()
  const userId = randomUUID()
  const examId = randomUUID()
  const sourceDocumentId = randomUUID()
  await owner.insert(users).values({ id: userId, clerkId: `clerk_${userId}` })
  await owner.insert(exams).values({ id: examId, userId, name: 'exam' })
  await owner.insert(sourceDocuments).values({
    id: sourceDocumentId,
    userId,
    examId,
    mode: 'new',
    fileType: 'image',
    filename: 'a.png',
    fileSizeBytes: 1000,
    status: 'completed',
  })
  return { userId, examId, sourceDocumentId }
}

async function seedOperation(
  ctx: { userId: string; examId: string; sourceDocumentId: string },
  status: 'prepared' | 'processing' | 'completed' | 'terminal_failed',
  over: { completedAt?: Date; resultSummary?: Record<string, unknown> } = {},
): Promise<string> {
  const owner = getFixtureOwnerDb()
  const operationId = randomUUID()
  await owner.insert(uploadOperations).values({
    id: operationId,
    userId: ctx.userId,
    idempotencyKey: `idem-${operationId}`,
    examId: ctx.examId,
    sourceDocumentId: ctx.sourceDocumentId,
    status,
    expectedSourceCount: 1,
    completedAt: over.completedAt ?? null,
    resultSummary: over.resultSummary ?? null,
  })
  return operationId
}

async function read(ctx: {
  userId: string
  sourceDocumentId: string
}): Promise<Record<string, unknown> | null> {
  return withTenantTx(ctx.userId, (tx) =>
    getLatestCompletedUploadSummary(ctx.userId, ctx.sourceDocumentId, tx),
  )
}

beforeEach(async () => {
  await truncateAllUserTables()
})

describe('getLatestCompletedUploadSummary — op 選択規則 (T16-a)', () => {
  it('completed の op が 1 件だけならその summary を返す', async () => {
    const ctx = await seedDoc()
    await seedOperation(ctx, 'completed', {
      completedAt: T0,
      resultSummary: { marker: 'only' },
    })

    expect(await read(ctx)).toEqual({ marker: 'only' })
  })

  // replay で completed が 2 件並ぶケース。 後から確定したほうが現在の内訳。
  it('completed が複数なら completed_at が最新のものを返す', async () => {
    const ctx = await seedDoc()
    await seedOperation(ctx, 'completed', {
      completedAt: new Date(T0.getTime() - 60_000),
      resultSummary: { marker: 'older' },
    })
    await seedOperation(ctx, 'completed', {
      completedAt: T0,
      resultSummary: { marker: 'newer' },
    })

    expect(await read(ctx)).toEqual({ marker: 'newer' })
  })

  // supersede された op は terminal になる。 「作成が最新の op」で選ぶとこれを拾い、
  // result_summary が NULL のため「何も取り込めなかった」と誤誘導する。
  it('completed より新しい terminal_failed があっても terminal は拾わない', async () => {
    const ctx = await seedDoc()
    await seedOperation(ctx, 'completed', {
      completedAt: new Date(T0.getTime() - 60_000),
      resultSummary: { marker: 'completed' },
    })
    await seedOperation(ctx, 'terminal_failed', {
      completedAt: T0,
      resultSummary: { marker: 'terminal' },
    })

    expect(await read(ctx)).toEqual({ marker: 'completed' })
  })

  it('非終端 (processing / prepared) の op も拾わない', async () => {
    const ctx = await seedDoc()
    await seedOperation(ctx, 'processing', { resultSummary: { marker: 'processing' } })
    await seedOperation(ctx, 'prepared', { resultSummary: { marker: 'prepared' } })

    expect(await read(ctx)).toBeNull()
  })

  it('completed の op が無ければ null', async () => {
    const ctx = await seedDoc()
    await seedOperation(ctx, 'terminal_failed', { completedAt: T0 })

    expect(await read(ctx)).toBeNull()
  })

  it('op が 1 件も無ければ null (旧 doc / 台帳より前の取り込み)', async () => {
    const ctx = await seedDoc()

    expect(await read(ctx)).toBeNull()
  })

  it('別 doc の completed op を混ぜない', async () => {
    const ctx = await seedDoc()
    const owner = getFixtureOwnerDb()
    const otherDocId = randomUUID()
    await owner.insert(sourceDocuments).values({
      id: otherDocId,
      userId: ctx.userId,
      examId: ctx.examId,
      mode: 'new',
      fileType: 'image',
      filename: 'b.png',
      fileSizeBytes: 1000,
      status: 'completed',
    })
    await seedOperation(
      { ...ctx, sourceDocumentId: otherDocId },
      'completed',
      { completedAt: T0, resultSummary: { marker: 'other-doc' } },
    )

    expect(await read(ctx)).toBeNull()
  })

  it('completed だが summary 未設定なら null (op の存在を内訳と混同しない)', async () => {
    const ctx = await seedDoc()
    await seedOperation(ctx, 'completed', { completedAt: T0 })

    expect(await read(ctx)).toBeNull()
  })

  // CLAUDE.md 絶対ルール(全 query に `WHERE user_id = ?`)の behavioral pin。
  // RLS があっても述語の有無は観測できる — tx の tenant context(GUC)と引数 userId を
  // **わざと食い違わせる**と、RLS が通す行(= 文脈テナント自身の行)に対して述語だけが
  // 効く状況が作れる。 述語を落とすと A の summary が「他人の userId で」引けてしまう。
  it('引数の userId で owner-scope する (tx の tenant context に依らない)', async () => {
    const a = await seedDoc()
    await seedOperation(a, 'completed', {
      completedAt: T0,
      resultSummary: { marker: 'A' },
    })
    const other = await seedDoc()

    const got = await withTenantTx(a.userId, (tx) =>
      getLatestCompletedUploadSummary(other.userId, a.sourceDocumentId, tx),
    )

    expect(got).toBeNull()
  })
})
