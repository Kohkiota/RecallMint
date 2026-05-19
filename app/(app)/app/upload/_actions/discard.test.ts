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
    // review I-3: delete() に渡された table reference を順序付きで record。
    // cards → source_documents の順序が逆だと cards が orphan 化するため、
    // 順序自体が correctness-critical (discard.ts: ON DELETE SET NULL 設計)。
    deleteTables: [] as unknown[],
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
    const passthrough = ['from', 'where', 'limit']
    for (const m of passthrough) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(returnValue).then(onFulfilled, onRejected)
    return obj
  }
  return {
    getDb: () => ({
      select: () =>
        chain(dbState.selectFound ? [{ id: 'sdoc-id' }] : []),
      delete: (table: unknown) => {
        dbState.deleteTables.push(table)
        return chain(undefined)
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
  })

  it('not-found (other user / already deleted) → silent ok + revalidate', async () => {
    dbState.selectFound = false
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(true)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('happy path: cards deleted BEFORE source_documents (order matters: ON DELETE SET NULL would orphan cards otherwise), revalidatePath called', async () => {
    dbState.selectFound = true
    const { discardUpload } = await importDiscard()
    const r = await discardUpload('sdoc-id')
    expect(r.ok).toBe(true)
    // 順序検証: cards → source_documents (逆だと cards が source_document_id=NULL で残る)。
    // PgTable 自体は Symbol-keyed metadata + 別 module 経路で reference が分裂
    // するため、 getTableName で table 名を取り出して比較する。
    expect(dbState.deleteTables.map((t) => getTableName(t as never))).toEqual([
      'cards',
      'source_documents',
    ])
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout')
  })
})
