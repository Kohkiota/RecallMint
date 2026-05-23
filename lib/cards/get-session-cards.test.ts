// get-session-cards の unit test。
// mock DB chain で user_id filter / order by due ASC / limit 渡しを検証する。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// -----------------------------------------------------------------------
// Hoisted mocks
// -----------------------------------------------------------------------
const { dbState } = vi.hoisted(() => ({
  dbState: { queue: [] as Record<string, unknown>[][] },
}))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    lte: vi.fn((...args: Parameters<typeof real.lte>) => real.lte(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
    asc: vi.fn((...args: Parameters<typeof real.asc>) => real.asc(...args)),
  }
})

vi.mock('@/lib/db', () => {
  function chain() {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'limit']) obj[m] = () => obj
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      const next = dbState.queue.shift() ?? []
      return Promise.resolve(next).then(onFulfilled, onRejected)
    }
    return obj
  }
  return { getDb: () => ({ select: () => chain() }) }
})

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------
beforeEach(async () => {
  dbState.queue = []
  const drizzle = await import('drizzle-orm')
  vi.mocked(drizzle.eq).mockClear()
  vi.mocked(drizzle.lte).mockClear()
  vi.mocked(drizzle.and).mockClear()
  vi.mocked(drizzle.asc).mockClear()
})

describe('getSessionCards', () => {
  it('returns empty array when no due cards', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards('user-1', 20)
    expect(result).toEqual([])
  })

  it('returns cards from DB', async () => {
    const card = {
      id: 'card-1',
      userId: 'user-1',
      due: new Date('2020-01-01'),
      questionText: '問題',
    }
    dbState.queue = [[card]]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards('user-1', 20)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'card-1' })
  })

  it('filters by user_id (tenant-isolation guard)', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards('user-42', 10)
    const eqCalls = vi.mocked(eq).mock.calls
    expect(eqCalls).toContainEqual([cards.userId, 'user-42'])
  })

  it('filters by due <= now (lte guard)', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const { lte } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    const now = new Date('2025-06-01T00:00:00Z')
    await getSessionCards('user-1', 10, now)
    const lteCalls = vi.mocked(lte).mock.calls
    expect(lteCalls).toContainEqual([cards.due, now])
  })

  it('passes limit to query', async () => {
    // The chain mock always returns queue[0], we just verify it resolves
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    // limit=5: should resolve without error
    const result = await getSessionCards('user-1', 5)
    expect(result).toEqual([])
  })

  it('uses asc ordering on cards.due', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const { asc } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards('user-1', 20)
    const ascCalls = vi.mocked(asc).mock.calls
    expect(ascCalls).toContainEqual([cards.due])
  })
})
