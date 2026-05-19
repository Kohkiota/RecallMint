import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSelect, mockFrom, mockWhere } = vi.hoisted(() => {
  // chainable mock: select().from().where() resolves to rows
  const mockWhere = vi.fn()
  const mockFrom = vi.fn(() => ({ where: mockWhere }))
  const mockSelect = vi.fn(() => ({ from: mockFrom }))
  return { mockSelect, mockFrom, mockWhere }
})

vi.mock('@/lib/db', () => ({
  getDb: () => ({ select: mockSelect }),
}))

async function importModule() {
  return await import('./ai-usage-mcq')
}

beforeEach(() => {
  mockSelect.mockClear()
  mockFrom.mockClear()
  mockWhere.mockReset()
})

describe('jstMonthBoundsUtc', () => {
  it('2026-05-19 14:00 JST → start = 2026-04-30T15:00Z, end = 2026-05-31T15:00Z', async () => {
    const { jstMonthBoundsUtc } = await importModule()
    // 2026-05-19 05:00 UTC = 2026-05-19 14:00 JST (still May in JST)
    const now = new Date('2026-05-19T05:00:00Z')
    const { start, end } = jstMonthBoundsUtc(now)
    expect(start.toISOString()).toBe('2026-04-30T15:00:00.000Z')
    expect(end.toISOString()).toBe('2026-05-31T15:00:00.000Z')
  })

  it('2026-05-31 23:59:59 JST (= 2026-05-31T14:59:59Z) is still inside May JST', async () => {
    const { jstMonthBoundsUtc } = await importModule()
    const now = new Date('2026-05-31T14:59:59Z')
    const { start, end } = jstMonthBoundsUtc(now)
    expect(now.getTime()).toBeGreaterThanOrEqual(start.getTime())
    expect(now.getTime()).toBeLessThan(end.getTime())
  })

  it('2026-06-01 00:00 JST (= 2026-05-31T15:00Z) is in June JST month', async () => {
    const { jstMonthBoundsUtc } = await importModule()
    const now = new Date('2026-05-31T15:00:00Z')
    const { start, end } = jstMonthBoundsUtc(now)
    // June month should start at 2026-05-31T15:00Z
    expect(start.toISOString()).toBe('2026-05-31T15:00:00.000Z')
    expect(end.toISOString()).toBe('2026-06-30T15:00:00.000Z')
  })
})

describe('getCurrentMonthOcrPages', () => {
  it('returns 0 when no rows match', async () => {
    mockWhere.mockResolvedValueOnce([{ total: 0 }])
    const { getCurrentMonthOcrPages } = await importModule()
    expect(await getCurrentMonthOcrPages('user-1')).toBe(0)
  })

  it('returns sum from SQL', async () => {
    mockWhere.mockResolvedValueOnce([{ total: 42 }])
    const { getCurrentMonthOcrPages } = await importModule()
    expect(await getCurrentMonthOcrPages('user-1')).toBe(42)
  })

  it('handles null/undefined total defensively', async () => {
    mockWhere.mockResolvedValueOnce([])
    const { getCurrentMonthOcrPages } = await importModule()
    expect(await getCurrentMonthOcrPages('user-1')).toBe(0)
  })
})

describe('canRunOcr', () => {
  it('Pro (limit=null) always ok with remaining=null', async () => {
    const { canRunOcr } = await importModule()
    const decision = await canRunOcr('user-1', 'pro', 1000)
    expect(decision).toEqual({ ok: true, remaining: null })
    // SELECT should not be issued for Pro (short circuit)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('Free user current=0 + requested=10 vs limit=30 → ok, remaining=20', async () => {
    mockWhere.mockResolvedValueOnce([{ total: 0 }])
    const { canRunOcr } = await importModule()
    const decision = await canRunOcr('user-1', 'free', 10)
    expect(decision).toEqual({ ok: true, remaining: 20 })
  })

  it('Free user current=25 + requested=5 = 30 (= limit) → ok, remaining=0 (境界等号許容)', async () => {
    mockWhere.mockResolvedValueOnce([{ total: 25 }])
    const { canRunOcr } = await importModule()
    const decision = await canRunOcr('user-1', 'free', 5)
    expect(decision).toEqual({ ok: true, remaining: 0 })
  })

  it('Free user current=25 + requested=6 = 31 > limit=30 → exceeded', async () => {
    mockWhere.mockResolvedValueOnce([{ total: 25 }])
    const { canRunOcr } = await importModule()
    const decision = await canRunOcr('user-1', 'free', 6)
    expect(decision).toEqual({
      ok: false,
      reason: 'exceeded',
      current: 25,
      limit: 30,
      requested: 6,
    })
  })

  it('Standard user current=300 + requested=1 > limit=300 → exceeded', async () => {
    mockWhere.mockResolvedValueOnce([{ total: 300 }])
    const { canRunOcr } = await importModule()
    const decision = await canRunOcr('user-1', 'standard', 1)
    expect(decision).toEqual({
      ok: false,
      reason: 'exceeded',
      current: 300,
      limit: 300,
      requested: 1,
    })
  })
})
