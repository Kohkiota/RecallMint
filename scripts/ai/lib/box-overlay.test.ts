import { describe, it, expect } from 'vitest'
import { boxToPercent } from './box-overlay'

describe('boxToPercent', () => {
  it('有効な box → 正確な CSS% ([y_min,x_min,y_max,x_max]=[100,200,600,700])', () => {
    expect(boxToPercent([100, 200, 600, 700])).toEqual({
      valid: true,
      left: 20,
      top: 10,
      width: 50,
      height: 50,
    })
  })

  it('配列でない入力 → invalid + reason', () => {
    const result = boxToPercent('not-an-array')
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('要素数が4でない → invalid + reason', () => {
    const result = boxToPercent([100, 200, 600])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('NaN 要素 → invalid + reason', () => {
    const result = boxToPercent([100, Number.NaN, 600, 700])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('非有限(Infinity)要素 → invalid + reason', () => {
    const result = boxToPercent([100, 200, 600, Number.POSITIVE_INFINITY])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('範囲外(>1000)要素 → invalid + reason (clamp しない)', () => {
    const result = boxToPercent([100, 200, 600, 1500])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('範囲外(<0)要素 → invalid + reason (clamp しない)', () => {
    const result = boxToPercent([-10, 200, 600, 700])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('x_min >= x_max (ゼロ/負の面積) → invalid + reason (reorder しない)', () => {
    const result = boxToPercent([100, 700, 600, 700])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })

  it('y_min >= y_max (ゼロ/負の面積) → invalid + reason (reorder しない)', () => {
    const result = boxToPercent([600, 200, 100, 700])
    expect(result.valid).toBe(false)
    expect((result as { valid: false; reason: string }).reason).toBeTruthy()
  })
})
