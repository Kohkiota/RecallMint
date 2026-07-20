// get-session-cards の unit test。
// mock DB chain で user_id filter / order by due ASC / limit 渡しを検証する。

import { describe, it, expect, vi, beforeEach } from 'vitest'
// RLS-P2: getSessionCards は dbc を必須引数 (limit の後・now の前) で受け取る。
// mock された getDb() を dbc として渡し、既存 chain mock を通す。
import { getDb } from '@/lib/db'

// -----------------------------------------------------------------------
// Hoisted mocks
// -----------------------------------------------------------------------
const { dbState, limitSpy } = vi.hoisted(() => ({
  dbState: { queue: [] as Record<string, unknown>[][] },
  limitSpy: vi.fn(),
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
    for (const m of ['from', 'where', 'orderBy']) obj[m] = () => obj
    obj.limit = (n: unknown) => { limitSpy(n); return obj }
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
  limitSpy.mockClear()
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
    const result = await getSessionCards('user-1', 20, getDb())
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
    const result = await getSessionCards('user-1', 20, getDb())
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'card-1' })
  })

  it('filters by user_id (tenant-isolation guard)', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards('user-42', 10, getDb())
    const eqCalls = vi.mocked(eq).mock.calls
    expect(eqCalls).toContainEqual([cards.userId, 'user-42'])
  })

  it('filters by due <= now (lte guard)', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const { lte } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    const now = new Date('2025-06-01T00:00:00Z')
    await getSessionCards('user-1', 10, getDb(), now)
    const lteCalls = vi.mocked(lte).mock.calls
    expect(lteCalls).toContainEqual([cards.due, now])
  })

  it('passes limit to query', async () => {
    // The chain mock always returns queue[0], we just verify it resolves
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    // limit=5: should call .limit(5) on the query chain
    const result = await getSessionCards('user-1', 5, getDb())
    expect(result).toEqual([])
    expect(limitSpy).toHaveBeenCalledWith(5)
  })

  it('uses asc ordering on cards.due', async () => {
    dbState.queue = [[]]
    const { getSessionCards } = await import('./get-session-cards')
    const { asc } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards('user-1', 20, getDb())
    const ascCalls = vi.mocked(asc).mock.calls
    expect(ascCalls).toContainEqual([cards.due])
  })

  it('limit=null → .limit() を呼ばずに全件返す (上限なし)', async () => {
    const card1 = { id: 'card-a', userId: 'user-1', due: new Date('2020-01-01') }
    const card2 = { id: 'card-b', userId: 'user-1', due: new Date('2020-01-02') }
    const card3 = { id: 'card-c', userId: 'user-1', due: new Date('2020-01-03') }
    dbState.queue = [[card1, card2, card3]]
    const { getSessionCards } = await import('./get-session-cards')
    // limit=null: chain mock resolves with all queued cards (no .limit(N) truncation)
    const result = await getSessionCards('user-1', null, getDb())
    expect(result).toHaveLength(3)
    expect(result.map((c) => c.id)).toEqual(['card-a', 'card-b', 'card-c'])
    expect(limitSpy).not.toHaveBeenCalled()
  })
})
