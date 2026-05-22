import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

// deleteCard server action の test。 owner-scoped で examId を引いてから
// owner-scoped DELETE する経路を検証する。 実 DB は叩かず getDb を mock。

const { mockGetCurrentUser, mockRevalidatePath, dbState } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    selectRows: [] as Record<string, unknown>[],
    deleteTables: [] as unknown[],
    whereArgs: [] as unknown[][],
  },
}))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
  }
})

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/db', () => {
  function selectChain() {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'limit']) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(dbState.selectRows).then(onFulfilled, onRejected)
    return obj
  }
  function deleteChain() {
    const obj: Record<string, unknown> = {}
    obj.where = (...args: unknown[]) => {
      dbState.whereArgs.push(args)
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(undefined).then(onFulfilled, onRejected)
    return obj
  }
  return {
    getDb: () => ({
      select: () => selectChain(),
      delete: (table: unknown) => {
        dbState.deleteTables.push(table)
        return deleteChain()
      },
    }),
  }
})

async function importDeleteCard() {
  return await import('./delete-card')
}

beforeEach(async () => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  dbState.selectRows = [{ examId: 'exam-1' }]
  dbState.deleteTables = []
  dbState.whereArgs = []
  const { eq } = await import('drizzle-orm')
  vi.mocked(eq).mockClear()
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-1',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
})

describe('deleteCard', () => {
  it('auth fail → { ok: false }, no DELETE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { deleteCard } = await importDeleteCard()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(dbState.deleteTables).toHaveLength(0)
  })

  it('found → owner-scoped DELETE on cards, returns examId', async () => {
    const { deleteCard } = await importDeleteCard()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ examId: 'exam-1' })
    expect(dbState.deleteTables.map((t) => getTableName(t as never))).toEqual([
      'cards',
    ])
  })

  it('not found / other user (0 行) → { ok: false }, no DELETE', async () => {
    dbState.selectRows = []
    const { deleteCard } = await importDeleteCard()
    const r = await deleteCard('card-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('カードが見つかりません')
    expect(dbState.deleteTables).toHaveLength(0)
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('success → revalidates the exam detail page', async () => {
    const { deleteCard } = await importDeleteCard()
    await deleteCard('card-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams/exam-1')
  })

  it('owner-scoped: eq(cards.id) と eq(cards.userId) で絞る', async () => {
    const { deleteCard } = await importDeleteCard()
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await deleteCard('card-1')
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([cards.id, 'card-1'])
    expect(calls).toContainEqual([cards.userId, 'user-1'])
  })
})
