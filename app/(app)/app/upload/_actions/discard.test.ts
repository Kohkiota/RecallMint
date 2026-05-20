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
    // 全 delete() (db 直 + transaction 内 tx 経由) の table を順序付きで record。
    deleteTables: [] as unknown[],
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
  function recordingDelete(table: unknown) {
    dbState.deleteTables.push(table)
    return chain(undefined)
  }
  return {
    getDb: () => ({
      select: () => chain(dbState.selectFound ? [{ id: 'sdoc-id' }] : []),
      // mode='new' の exam DELETE は transaction 外で db.delete を直接使う
      delete: recordingDelete,
      transaction: async (
        fn: (tx: { delete: typeof recordingDelete }) => Promise<void>,
      ) => {
        dbState.transactionRan = true
        await fn({ delete: recordingDelete })
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
  dbState.deleteTables = []
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
  it('auth fail → revalidates, no deletes', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(false)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(dbState.deleteTables).toHaveLength(0)
  })

  it('not-found (other user / already deleted) → silent ok + revalidate, no deletes', async () => {
    dbState.selectFound = false
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id', 'exam-uuid')
    expect(r.ok).toBe(true)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(dbState.deleteTables).toHaveLength(0)
    expect(dbState.transactionRan).toBe(false)
  })

  it('mode=new (autoCreatedExamId): deletes exam only, source_documents + cards go via FK CASCADE', async () => {
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id', 'exam-uuid')
    expect(r.ok).toBe(true)
    // exam 1 文のみ DELETE (cascade は DB 側、 アプリは cards/source_documents を消さない)
    expect(dbState.deleteTables.map((t) => getTableName(t as never))).toEqual([
      'exams',
    ])
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('mode=existing (no autoCreatedExamId): deletes cards + source_documents in a transaction, exam untouched', async () => {
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(true)
    expect(dbState.transactionRan).toBe(true)
    expect(dbState.deleteTables.map((t) => getTableName(t as never))).toEqual([
      'cards',
      'source_documents',
    ])
    // exams は触らない
    expect(
      dbState.deleteTables.map((t) => getTableName(t as never)),
    ).not.toContain('exams')
  })

  it('never touches upload_records (= 月次 quota は返金されない、 Bug A 解消)', async () => {
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    // mode=new
    await discardUpload('sdoc-id', 'exam-uuid')
    // mode=existing
    await discardUpload('sdoc-id')
    expect(
      dbState.deleteTables.map((t) => getTableName(t as never)),
    ).not.toContain('upload_records')
  })
})
