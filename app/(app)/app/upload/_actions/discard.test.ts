import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const {
  mockGetCurrentUser,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    selectFound: false,
    // transaction 内の tx.delete() 呼び出しを順序付きで record。
    // 各 entry = { table (PgTable reference), where (条件 SQL or undefined) }。
    deletes: [] as Array<{ table: unknown; where: unknown }>,
    transactionRan: false,
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/db', () => {
  function chain(returnValue: unknown) {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'limit']) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(returnValue).then(onFulfilled, onRejected)
    return obj
  }
  // transaction 内で discard.ts に渡す tx mock。 delete は { table, where } を
  // record、 select は notExists subquery の base (実評価されない、 lazy)。
  function makeTx() {
    return {
      delete: (table: unknown) => ({
        where: (cond: unknown) => {
          dbState.deletes.push({ table, where: cond })
          return chain(undefined)
        },
      }),
      select: () => chain([]),
    }
  }
  return {
    getDb: () => ({
      // 所有者確認 SELECT (transaction 外)
      select: () => chain(dbState.selectFound ? [{ id: 'sdoc-id' }] : []),
      transaction: async (
        fn: (tx: ReturnType<typeof makeTx>) => Promise<void>,
      ) => {
        dbState.transactionRan = true
        await fn(makeTx())
      },
    }),
  }
})

async function importDiscard() {
  return await import('./discard')
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  dbState.selectFound = false
  dbState.deletes = []
  dbState.transactionRan = false
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-uuid',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
})

describe('discardUpload', () => {
  it('auth fail → still revalidates (idempotent)', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(false)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(dbState.transactionRan).toBe(false)
  })

  it('not-found (other user / already deleted) → silent ok + revalidate, no deletes', async () => {
    dbState.selectFound = false
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(true)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(dbState.transactionRan).toBe(false)
  })

  it('without autoCreatedExamId (mode=existing): cards + source_documents deleted in order, exam untouched', async () => {
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(true)
    // 順序検証: cards → source_documents、 exams は触らない
    expect(dbState.deletes.map((d) => getTableName(d.table as never))).toEqual([
      'cards',
      'source_documents',
    ])
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('with autoCreatedExamId (mode=new): cards + source_documents + exams deleted in order', async () => {
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id', 'exam-uuid')
    expect(r.ok).toBe(true)
    expect(dbState.deletes.map((d) => getTableName(d.table as never))).toEqual([
      'cards',
      'source_documents',
      'exams',
    ])
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('auto-created exam DELETE is always guarded by a WHERE condition (never an unconditional DELETE FROM exams)', async () => {
    // 「他 user の exam を消さない」 「中身の残る exam を消さない」 は exams
    // DELETE の WHERE (user_id 一致 + cards / source_documents への NOT EXISTS
    // 2 条件) が DB 側で enforce する。 mock DB は条件評価をしないため、 unit
    // test で検証できるのは「exam DELETE が無条件ではなく必ず WHERE で
    // guard されている」 こと。 実際の「残る / 消える」 outcome は staging
    // smoke (シナリオ 6) で確認する。
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    await discardUpload('sdoc-id', 'exam-uuid')
    const examDelete = dbState.deletes.find(
      (d) => getTableName(d.table as never) === 'exams',
    )
    expect(examDelete).toBeDefined()
    // where が undefined = 無条件 DELETE。 必ず条件 SQL を伴うこと。
    expect(examDelete?.where).toBeDefined()
  })
})
