import { describe, it, expect } from 'vitest'
import { PRICE_TABLE, estimateUsdPerImage } from './pricing'

describe('PRICE_TABLE', () => {
  it('公式標準単価 ($/1M tokens) を pin する (出典 https://ai.google.dev/gemini-api/docs/pricing・2026-07-28 取得)', () => {
    expect(PRICE_TABLE).toEqual({
      'gemini-2.5-flash': { input: 0.3, output: 2.5 },
      'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
      'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
      'gemini-3.6-flash': { input: 1.5, output: 7.5 },
      'gemini-3.5-flash': { input: 1.5, output: 9.0 },
    })
  })
})

describe('estimateUsdPerImage', () => {
  it('既知モデル: 具体的な token 数の組で厳密な USD を算出する (candidates+thoughts が output 課金)', () => {
    const usage = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50 }
    // gemini-2.5-flash: input 0.30 / output 2.50 ($/1M tokens)
    const expected = (1000 * 0.3) / 1_000_000 + ((200 + 50) * 2.5) / 1_000_000
    expect(estimateUsdPerImage(usage, 'gemini-2.5-flash')).toBeCloseTo(expected, 12)
  })

  it('thoughtsTokenCount が output コストに反映される (増やすと結果が変わる = candidates のみでなく含む証明)', () => {
    const base = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 0 }
    const withThoughts = { ...base, thoughtsTokenCount: 500 }
    const usdBase = estimateUsdPerImage(base, 'gemini-2.5-flash')
    const usdWithThoughts = estimateUsdPerImage(withThoughts, 'gemini-2.5-flash')
    expect(usdBase).not.toBeNull()
    expect(usdWithThoughts).not.toBeNull()
    expect((usdWithThoughts as number) - (usdBase as number)).toBeCloseTo((500 * 2.5) / 1_000_000, 12)
  })

  it('未知モデル → null (N/A)', () => {
    const usage = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50 }
    expect(estimateUsdPerImage(usage, 'gemini-9.9-unknown')).toBeNull()
  })

  it.each([
    ['promptTokenCount 欠測', { candidatesTokenCount: 200, thoughtsTokenCount: 50 }],
    ['candidatesTokenCount 欠測', { promptTokenCount: 1000, thoughtsTokenCount: 50 }],
  ])('%s → null (0 に潰さない・欠測を安価に見せかけない。この2つは成功呼び出しで常に存在し、欠測=usage 未報告=真に算出不能)', (_label, usage) => {
    expect(estimateUsdPerImage(usage, 'gemini-2.5-flash')).toBeNull()
  })

  it('thoughtsTokenCount のみ欠測 → null にせず 0 として算出する (optional field: thinking を行わなかった場合は省略される。欠測 = 0 課金であり算出不能ではない)', () => {
    const usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }
    const result = estimateUsdPerImage(usage, 'gemini-2.5-flash')
    expect(result).not.toBeNull()
    expect(typeof result).toBe('number')
    const expected = (1000 * 0.3) / 1_000_000 + (200 * 2.5) / 1_000_000
    expect(result).toBeCloseTo(expected, 12)
  })

  it('lite モデル実運用ケース: thinking をしないため thoughtsTokenCount が省略されても N/A にならず厳密な USD を算出する', () => {
    const usage = { promptTokenCount: 3697, candidatesTokenCount: 461 }
    // gemini-3.1-flash-lite: input 0.25 / output 1.50 ($/1M tokens)、thoughts 省略=0
    const expected = (3697 * 0.25) / 1_000_000 + (461 * 1.5) / 1_000_000
    const result = estimateUsdPerImage(usage, 'gemini-3.1-flash-lite')
    expect(result).not.toBeNull()
    expect(result).toBeCloseTo(expected, 12)
  })

  it('token count が正当な 0(欠測ではない実測値)でも算出される (=== undefined のみ null 化。0 は falsy だが欠測ではない)', () => {
    const usage = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 0 }
    const result = estimateUsdPerImage(usage, 'gemini-2.5-flash')
    expect(result).not.toBeNull()
    expect(typeof result).toBe('number')
    // thoughtsTokenCount=0 は output コストに 0 を寄与するだけで欠測扱いされない
    const expected = (1000 * 0.3) / 1_000_000 + (200 * 2.5) / 1_000_000
    expect(result).toBeCloseTo(expected, 12)
  })
})
