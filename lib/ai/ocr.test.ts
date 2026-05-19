import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCallGemini } = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
}))

vi.mock('./clients/gemini', () => ({
  callGemini: mockCallGemini,
}))

// dynamic import to ensure the mock above is wired before module evaluation.
async function importOcr() {
  return await import('./ocr')
}

const sampleCard = {
  title: '問1',
  question_text: 'リード文',
  options: [
    { id: 'a', text: '選択肢A', is_correct: true },
    { id: 'b', text: '選択肢B', is_correct: false },
  ],
  correct_answer_ids: ['a'],
  images: [],
}

const validResponseText = JSON.stringify({ cards: [sampleCard] })
const emptyCardsResponseText = JSON.stringify({ cards: [] })
const malformedJsonText = '{ not json'

const sampleFile = { mimeType: 'application/pdf', data: 'BASE64DATA' }

beforeEach(() => {
  mockCallGemini.mockReset()
})

describe('runOcrPipeline', () => {
  it('Flash success path: 1 card extracted, model chain = [flash], cost > 0', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: validResponseText,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.cards).toHaveLength(1)
    expect(result.modelChain).toEqual(['flash'])
    expect(result.flashError).toBeUndefined()
    expect(result.tokenUsage).toEqual([
      { model: 'flash', inputTokens: 1_000_000, outputTokens: 100_000 },
    ])
    // Flash 1M input * $0.3 + 100k output * $2.5 = $0.55 * 150 = ¥83 (round)
    expect(result.costYen).toBe(83)
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })

  it('Flash returns 0 cards → Pro fallback succeeds', async () => {
    mockCallGemini
      .mockResolvedValueOnce({
        text: emptyCardsResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 2000,
        outputTokens: 500,
      })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.cards).toHaveLength(1)
    expect(result.modelChain).toEqual(['flash', 'pro'])
    expect(result.flashError).toMatch(/Flash returned 0 cards/)
    expect(result.tokenUsage).toEqual([
      { model: 'flash', inputTokens: 1000, outputTokens: 100 },
      { model: 'pro', inputTokens: 2000, outputTokens: 500 },
    ])
    // cost = Flash + Pro 合算
    expect(result.costYen).toBeGreaterThan(0)
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
  })

  it('Flash JSON parse fail → Pro fallback succeeds', async () => {
    mockCallGemini
      .mockResolvedValueOnce({
        text: malformedJsonText,
        inputTokens: 1000,
        outputTokens: 50,
      })
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 2000,
        outputTokens: 500,
      })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.cards).toHaveLength(1)
    expect(result.modelChain).toEqual(['flash', 'pro'])
    expect(result.flashError).toMatch(/JSON parse failed/)
  })

  it('Flash and Pro both fail (Pro returns 0 cards) → throws', async () => {
    mockCallGemini
      .mockResolvedValueOnce({
        text: emptyCardsResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
      .mockResolvedValueOnce({
        text: emptyCardsResponseText,
        inputTokens: 2000,
        outputTokens: 200,
      })
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
  })

  it('transient 429 from Flash → exponential backoff retry → success on 2nd attempt', async () => {
    mockCallGemini
      .mockRejectedValueOnce(new Error('429 Rate limit exceeded'))
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.cards).toHaveLength(1)
    expect(result.modelChain).toEqual(['flash'])
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
  }, 10000)

  it('non-transient error (e.g. invalid API key) from Flash → no retry → Pro fallback', async () => {
    mockCallGemini
      .mockRejectedValueOnce(new Error('400 Bad Request: invalid argument'))
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 2000,
        outputTokens: 500,
      })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.modelChain).toEqual(['flash', 'pro'])
    expect(result.flashError).toMatch(/400 Bad Request/)
    // Flash 1 attempt (no retry on non-transient), Pro 1 attempt → total 2 calls
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
  })

  it('onAttempt callback fires once per Gemini call (success path: 1 Flash call)', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: validResponseText,
      inputTokens: 1000,
      outputTokens: 100,
    })
    const onAttempt = vi.fn()
    const { runOcrPipeline } = await importOcr()
    await runOcrPipeline([sampleFile], { onAttempt })
    expect(onAttempt).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledWith('flash')
  })

  it('onAttempt callback fires for each retry + fallback (Flash 429 retry + Pro fallback = 3 calls)', async () => {
    mockCallGemini
      .mockRejectedValueOnce(new Error('429 Rate limit exceeded'))
      .mockResolvedValueOnce({
        text: emptyCardsResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 2000,
        outputTokens: 500,
      })
    const onAttempt = vi.fn()
    const { runOcrPipeline } = await importOcr()
    await runOcrPipeline([sampleFile], { onAttempt })
    // Flash 1st (429 → retry), Flash 2nd (success but 0 cards → Pro fallback), Pro 1st (success)
    // ai_usage = 3 calls 計上
    expect(onAttempt).toHaveBeenCalledTimes(3)
    expect(onAttempt.mock.calls.map((c) => c[0])).toEqual(['flash', 'flash', 'pro'])
  }, 10000)

  it('onAttempt failure does not interrupt OCR pipeline (best-effort counter)', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: validResponseText,
      inputTokens: 1000,
      outputTokens: 100,
    })
    const onAttempt = vi.fn().mockRejectedValueOnce(new Error('DB write failed'))
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile], { onAttempt })
    expect(result.cards).toHaveLength(1)
    expect(onAttempt).toHaveBeenCalledTimes(1)
  })

  it('zod validation rejects malformed card (missing required field)', async () => {
    const malformedCard = { title: '問1' } // question_text / options 等 missing
    mockCallGemini
      .mockResolvedValueOnce({
        text: JSON.stringify({ cards: [malformedCard] }),
        inputTokens: 1000,
        outputTokens: 100,
      })
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 2000,
        outputTokens: 500,
      })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    // zod fail → Pro fallback
    expect(result.modelChain).toEqual(['flash', 'pro'])
    expect(result.flashError).toMatch(/response shape invalid/)
  })
})
