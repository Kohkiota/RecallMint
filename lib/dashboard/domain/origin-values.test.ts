import { describe, expect, it } from 'vitest'
import { normalizeOriginValue, ORIGIN_VALUES } from './origin-values'

describe('ORIGIN_VALUES', () => {
  it('design doc §11.1 の 8 値と一致する(順不同で比較)', () => {
    expect([...ORIGIN_VALUES].sort()).toEqual(
      [
        'home_today',
        'home_quick_mistakes',
        'home_quick_unanswered',
        'home_quick_weak',
        'home_quick_10min',
        'home_weak_tags',
        'smart',
        'custom',
      ].sort(),
    )
  })
})

describe('normalizeOriginValue', () => {
  it('既知値はそのまま返す', () => {
    expect(normalizeOriginValue('home_today')).toBe('home_today')
    expect(normalizeOriginValue('custom')).toBe('custom')
  })

  it('未知値は null', () => {
    expect(normalizeOriginValue('legacy_unknown')).toBeNull()
    expect(normalizeOriginValue('')).toBeNull()
  })

  it('null / undefined は null', () => {
    expect(normalizeOriginValue(null)).toBeNull()
    expect(normalizeOriginValue(undefined)).toBeNull()
  })
})
