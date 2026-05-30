import { describe, it, expect } from 'vitest'
import { maxIso } from './max-iso'

describe('maxIso', () => {
  it('空配列は null を返す', () => {
    expect(maxIso([])).toBeNull()
  })

  it('単一要素はその値を返す', () => {
    expect(maxIso(['2026-05-01T00:00:00.000Z'])).toBe('2026-05-01T00:00:00.000Z')
  })

  it('複数要素(順不同)の最大値を返す', () => {
    expect(
      maxIso([
        '2026-05-02T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
        '2026-05-03T00:00:00.000Z',
      ])
    ).toBe('2026-05-03T00:00:00.000Z')
  })
})
