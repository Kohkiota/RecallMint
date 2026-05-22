import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

// deleteCard server action の test。 owner-scoped で examId を引いてから
// owner-scoped DELETE する経路を検証する。 実 DB は叩かず getDb を mock。
// B1 (S2.0c): SELECT → DELETE → exams.card_count -1 を 1 transaction で実行する
// ため、 getDb mock は transaction() を提供し tx 内の select/delete/update を記録する。

const { mockGetCurrentUser, mockRevalidatePath, dbState } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    selectRows: [] as Record<string, unknown>[],
    deleteTables: [] as unknown[],
    updateTables: [] as unknown[],
    updateVals: [] as Record<string, unknown>[],
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
  // delete / update の末尾 (.where() で締めて await) 用の awaitable chain。
  function awaitable() {
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
  // transaction の tx は db と同じ select/delete/update API を持つ。
  function txApi() {
    return {
      select: () => selectChain(),
      delete: (table: unknown) => {
        dbState.deleteTables.push(table)
        return awaitable()
      },
      update: (table: unknown) => {
        dbState.updateTables.push(table)
        return {
          set: (vals: Record<string, unknown>) => {
            dbState.updateVals.push(vals)
            return awaitable()
          },
        }
      },
    }
  }
  return {
    getDb: () => ({
      transaction: async (fn: (tx: ReturnType<typeof txApi>) => unknown) =>
        await fn(txApi()),
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
  dbState.updateTables = []
  dbState.updateVals = []
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

  // B1 (S2.0c): card 削除と同一 transaction で exams.card_count を -1 する。
  it('B1: card 削除時 exams.card_count を -1 更新する', async () => {
    const { deleteCard } = await importDeleteCard()
    await deleteCard('card-1')
    expect(dbState.updateTables.map((t) => getTableName(t as never))).toEqual([
      'exams',
    ])
    expect(dbState.updateVals[0]).toHaveProperty('cardCount')
    // updatedAt を明示 set し $onUpdate による updatedAt bump を抑止する
    expect(dbState.updateVals[0]).toHaveProperty('updatedAt')
  })

  it('B1: card 不在時は DELETE も card_count 更新も行わない', async () => {
    dbState.selectRows = []
    const { deleteCard } = await importDeleteCard()
    await deleteCard('card-x')
    expect(dbState.deleteTables).toHaveLength(0)
    expect(dbState.updateTables).toHaveLength(0)
  })
})
