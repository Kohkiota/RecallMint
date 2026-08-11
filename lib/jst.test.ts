import { describe, it, expect, vi, afterEach } from 'vitest'
import { todayInJst, jstDayRange } from './jst'

describe('todayInJst', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Boundary — 14:59:59Z still "yesterday" in JST', () => {
    const result = todayInJst(new Date('2026-04-22T14:59:59Z'))
    expect(result).toBe('2026-04-22')
  })

  it('Boundary — 15:00:00Z is "tomorrow" in JST', () => {
    const result = todayInJst(new Date('2026-04-22T15:00:00Z'))
    expect(result).toBe('2026-04-23')
  })

  it('Zero-padding month and day', () => {
    // 2026-01-05T03:00:00Z is 2026-01-05T12:00:00+09:00 in JST
    const result = todayInJst(new Date('2026-01-05T03:00:00Z'))
    expect(result).toBe('2026-01-05')
  })

  it('Default arg returns YYYY-MM-DD format', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T00:00:00Z'))
    const result = todayInJst()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    vi.useRealTimers()
  })
})

describe('jstDayRange', () => {
  it('returns [JST 0:00, 翌 0:00) as UTC instants', () => {
    const { startAt, endAt } = jstDayRange('2026-04-22')
    expect(startAt.toISOString()).toBe('2026-04-21T15:00:00.000Z')
    expect(endAt.toISOString()).toBe('2026-04-22T15:00:00.000Z')
  })

  it('leap day 2/29 — endAt lands on 3/1 JST midnight', () => {
    const { startAt, endAt } = jstDayRange('2024-02-29')
    expect(startAt.toISOString()).toBe('2024-02-28T15:00:00.000Z')
    expect(endAt.toISOString()).toBe('2024-02-29T15:00:00.000Z')
  })

  it('boundary — startAt is in range, startAt - 1ms is not (previous day)', () => {
    const { startAt } = jstDayRange('2026-04-22')
    expect(todayInJst(startAt)).toBe('2026-04-22')
    expect(todayInJst(new Date(startAt.getTime() - 1))).toBe('2026-04-21')
  })

  it('boundary — endAt - 1ms is in range, endAt is not (next day)', () => {
    const { endAt } = jstDayRange('2026-04-22')
    expect(todayInJst(new Date(endAt.getTime() - 1))).toBe('2026-04-22')
    expect(todayInJst(endAt)).toBe('2026-04-23')
  })

  it('round-trip property — todayInJst(t) === day for t in [startAt, endAt), pinned across several days', () => {
    const days = ['2026-01-01', '2026-04-22', '2024-02-29', '2026-12-31']
    for (const day of days) {
      const { startAt, endAt } = jstDayRange(day)
      expect(todayInJst(startAt)).toBe(day)
      expect(todayInJst(new Date(endAt.getTime() - 1))).toBe(day)
      expect(todayInJst(new Date(startAt.getTime() - 1))).not.toBe(day)
      expect(todayInJst(endAt)).not.toBe(day)
    }
  })
})
