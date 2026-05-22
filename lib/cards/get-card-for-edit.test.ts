import { describe, it, expect, vi, beforeEach } from 'vitest'

// getCardForEdit の owner-isolation 回帰防止 test。 mock DB chain で、
// WHERE 句が cards.userId / cards.id で絞っているかを eq スパイで検証する。

const { dbState } = vi.hoisted(() => ({
  dbState: { queue: [] as Record<string, unknown>[][] },
}))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
  }
})

vi.mock('@/lib/db', () => {
  function chain() {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'where', 'limit']) obj[m] = () => obj
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

beforeEach(async () => {
  dbState.queue = []
  const { eq } = await import('drizzle-orm')
  vi.mocked(eq).mockClear()
})

describe('getCardForEdit', () => {
  it('returns null when no row (other user / unknown card)', async () => {
    dbState.queue = [[]]
    const { getCardForEdit } = await import('./get-card-for-edit')
    expect(await getCardForEdit('user-1', 'card-x')).toBeNull()
  })

  it('returns the card row joined with exam name when found', async () => {
    const row = {
      id: 'card-1',
      examId: 'exam-1',
      examName: '基本情報技術者',
      title: '問1',
      questionText: '問題文',
      options: [{ id: 'a', text: 'A', is_correct: true }],
      explanationText: '解説',
    }
    dbState.queue = [[row]]
    const { getCardForEdit } = await import('./get-card-for-edit')
    expect(await getCardForEdit('user-1', 'card-1')).toEqual(row)
  })

  it('filters by cards.userId and cards.id (tenant-isolation guard)', async () => {
    dbState.queue = [[]]
    const { getCardForEdit } = await import('./get-card-for-edit')
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getCardForEdit('user-1', 'card-1')
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([cards.id, 'card-1'])
    expect(calls).toContainEqual([cards.userId, 'user-1'])
  })
})
