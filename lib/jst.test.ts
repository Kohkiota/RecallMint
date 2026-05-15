import { describe, it, expect, vi, afterEach } from 'vitest'
import { todayInJst } from './jst'

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
