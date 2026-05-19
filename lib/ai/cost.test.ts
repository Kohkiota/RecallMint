import { describe, it, expect } from 'vitest'
import { estimateCostYen, modelId } from './cost'

describe('estimateCostYen', () => {
  it('returns 0 for zero tokens', () => {
    expect(estimateCostYen('flash', 0, 0)).toBe(0)
    expect(estimateCostYen('pro', 0, 0)).toBe(0)
  })

  it('Flash: 1M input + 0 output = 0.3 USD * 150 JPY = 45 JPY', () => {
    expect(estimateCostYen('flash', 1_000_000, 0)).toBe(45)
  })

  it('Flash: 0 input + 1M output = 2.5 USD * 150 JPY = 375 JPY', () => {
    expect(estimateCostYen('flash', 0, 1_000_000)).toBe(375)
  })

  it('Pro: 1M input + 1M output = (1.25 + 10) * 150 = 1687.5 → 1688 JPY rounded', () => {
    expect(estimateCostYen('pro', 1_000_000, 1_000_000)).toBe(1688)
  })

  it('small request (10k input + 1k output) Flash = 0.0055 USD * 150 = 0.825 → 1 JPY rounded', () => {
    expect(estimateCostYen('flash', 10_000, 1_000)).toBe(1)
  })

  it('sub-yen request (1k input + 0 output) Flash = 0.0003 USD * 150 = 0.045 → 0 JPY rounded', () => {
    expect(estimateCostYen('flash', 1_000, 0)).toBe(0)
  })
})

describe('modelId', () => {
  it('flash → gemini-2.5-flash', () => {
    expect(modelId('flash')).toBe('gemini-2.5-flash')
  })
  it('pro → gemini-2.5-pro', () => {
    expect(modelId('pro')).toBe('gemini-2.5-pro')
  })
})
