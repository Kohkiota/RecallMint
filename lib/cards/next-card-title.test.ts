import { describe, it, expect } from 'vitest'
import { nextCardTitle } from './next-card-title'

describe('nextCardTitle', () => {
  it('count 0 → "新規カード 1"', () => {
    expect(nextCardTitle(0)).toBe('新規カード 1')
  })

  it('count 1 → "新規カード 2"', () => {
    expect(nextCardTitle(1)).toBe('新規カード 2')
  })

  it('count 4 → "新規カード 5"', () => {
    expect(nextCardTitle(4)).toBe('新規カード 5')
  })

  it('count 100 → "新規カード 101"', () => {
    expect(nextCardTitle(100)).toBe('新規カード 101')
  })

  it('always returns non-empty string', () => {
    const result = nextCardTitle(0)
    expect(result.trim().length).toBeGreaterThan(0)
  })
})
