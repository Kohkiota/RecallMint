import { describe, it, expect } from 'vitest'
import { formatRelativeJa } from './list'

describe('formatRelativeJa', () => {
  const NOW = new Date('2026-05-19T12:00:00Z')

  it('< 1 min → たった今', () => {
    expect(formatRelativeJa(new Date('2026-05-19T11:59:30Z'), NOW)).toBe('たった今')
  })

  it('5 min ago → 5 分前', () => {
    expect(formatRelativeJa(new Date('2026-05-19T11:55:00Z'), NOW)).toBe('5 分前')
  })

  it('3 hours ago → 3 時間前', () => {
    expect(formatRelativeJa(new Date('2026-05-19T09:00:00Z'), NOW)).toBe('3 時間前')
  })

  it('5 days ago → 5 日前', () => {
    expect(formatRelativeJa(new Date('2026-05-14T12:00:00Z'), NOW)).toBe('5 日前')
  })

  it('2 months ago (60 days) → 2 ヶ月前', () => {
    expect(formatRelativeJa(new Date('2026-03-20T12:00:00Z'), NOW)).toBe('2 ヶ月前')
  })

  it('1 year ago (400 days) → 1 年前', () => {
    expect(formatRelativeJa(new Date('2025-04-15T12:00:00Z'), NOW)).toBe('1 年前')
  })

  it('future date (clock skew) → たった今', () => {
    expect(formatRelativeJa(new Date('2026-05-20T00:00:00Z'), NOW)).toBe('たった今')
  })
})
