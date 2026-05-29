import { describe, it, expect } from 'vitest'
import { nextCardSortKey } from './next-card-sort-key'

describe('nextCardSortKey', () => {
  it('empty array → "1"', () => {
    expect(nextCardSortKey([])).toBe('1')
  })

  it('all numeric (no zero-pad) → max + 1', () => {
    expect(nextCardSortKey(['1', '2', '10'])).toBe('11')
    expect(nextCardSortKey(['5'])).toBe('6')
    expect(nextCardSortKey(['0', '1', '2'])).toBe('3')
  })

  it('zero-padded numeric strings → parse and return max + 1', () => {
    expect(nextCardSortKey(['001', '002', '009'])).toBe('10')
    expect(nextCardSortKey(['000', '001'])).toBe('2')
  })

  it('mixed or hierarchical (non-numeric) → fallback to length + 1', () => {
    expect(nextCardSortKey(['03-02', '1'])).toBe('3')
    expect(nextCardSortKey(['a', 'b', 'c'])).toBe('4')
    expect(nextCardSortKey(['1.2', '1.3'])).toBe('3')
  })

  it('null and empty strings are excluded from calculation', () => {
    expect(nextCardSortKey([null, '', '5'])).toBe('6')
    expect(nextCardSortKey([null, null])).toBe('1')
    expect(nextCardSortKey(['', ''])).toBe('1')
    expect(nextCardSortKey([null, '', null, '3', null])).toBe('4')
  })

  it('whitespace-only strings are treated as empty', () => {
    expect(nextCardSortKey(['  ', '\t', '5'])).toBe('6')
    expect(nextCardSortKey(['   '])).toBe('1')
  })

  it('mix of nulls, empties, and numeric → numeric rule applies', () => {
    expect(nextCardSortKey([null, '2', '', '5', '  '])).toBe('6')
  })

  it('all numeric with leading zeros → no zero-pad in result', () => {
    expect(nextCardSortKey(['010', '020', '030'])).toBe('31')
  })
})
