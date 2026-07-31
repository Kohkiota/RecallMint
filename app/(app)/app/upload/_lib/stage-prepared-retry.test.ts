import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// lib/ai/ocr.test.ts と同じ mock 方式(callGemini/parseRetryAfterMs を差し替え、
// 429 即停止・transient backoff・onAttempt 計上を実 fake timer で検証する)。
const { mockCallGemini, mockParseRetryAfterMs } = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
  mockParseRetryAfterMs: vi.fn(),
}))

vi.mock('@/lib/ai/clients/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/clients/gemini')>()
  return {
    ...actual,
    callGemini: mockCallGemini,
    parseRetryAfterMs: mockParseRetryAfterMs,
  }
})

async function importRetry() {
  return await import('./stage-prepared-retry')
}

const dummyParts = [{ text: 'source_id=s1' }]
const dummySchema = { type: 'object' }

beforeEach(() => {
  mockCallGemini.mockReset()
  mockParseRetryAfterMs.mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('callImageCropWithRetry', () => {
  it('single success: no retry, calls callGemini once with the given parts/schema, onAttempt fires once', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: '{"cards":[]}',
      inputTokens: 100,
      outputTokens: 10,
      thoughtsTokens: 0,
    })
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    const result = await callImageCropWithRetry(dummyParts, dummySchema, onAttempt)

    expect(result.text).toBe('{"cards":[]}')
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockCallGemini).toHaveBeenCalledWith({
      model: 'flash',
      files: [],
      prompt: '',
      responseJsonSchema: dummySchema,
      parts: dummyParts,
    })
    expect(onAttempt).toHaveBeenCalledTimes(1)
  })

  it('429 rate limit: throws immediately, no retry, onAttempt fires exactly once', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('429 Too Many Requests'))
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    await expect(callImageCropWithRetry(dummyParts, dummySchema, onAttempt)).rejects.toThrow(
      /429/,
    )
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledTimes(1)
  })

  it('transient (503) then success: retries once after backoff, onAttempt fires per attempt (2 total)', async () => {
    vi.useFakeTimers()
    mockCallGemini
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        text: '{"cards":[]}',
        inputTokens: 1,
        outputTokens: 1,
        thoughtsTokens: 0,
      })
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    const p = callImageCropWithRetry(dummyParts, dummySchema, onAttempt, () => 0)
    // 1st retry backoff = BACKOFF_BASE_MS[0] (5000ms) + jitter(0) = 5000ms.
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await p

    expect(result.text).toBe('{"cards":[]}')
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
    expect(onAttempt).toHaveBeenCalledTimes(2)
  })

  it('transient error exhausts all retries (3 attempts total): rethrows the last error', async () => {
    vi.useFakeTimers()
    mockCallGemini.mockRejectedValue(new Error('503 Service Unavailable'))
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    const p = callImageCropWithRetry(dummyParts, dummySchema, onAttempt, () => 0).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(5_000) // 1st retry backoff
    await vi.advanceTimersByTimeAsync(20_000) // 2nd retry backoff
    const err = await p

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/503/)
    expect(mockCallGemini).toHaveBeenCalledTimes(3) // 初回 + 2 retries
    expect(onAttempt).toHaveBeenCalledTimes(3)
  })

  it('non-transient, non-rate-limit error: throws immediately without retry', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('400 Bad Request'))
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    await expect(callImageCropWithRetry(dummyParts, dummySchema, onAttempt)).rejects.toThrow(
      /400/,
    )
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledTimes(1)
  })

  it('onAttempt failure does not abort the call (best-effort counter, swallowed)', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: '{"cards":[]}',
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })
    const onAttempt = vi.fn().mockRejectedValueOnce(new Error('counter db down'))
    const { callImageCropWithRetry } = await importRetry()

    const result = await callImageCropWithRetry(dummyParts, dummySchema, onAttempt)
    expect(result.text).toBe('{"cards":[]}')
  })

  it('onAttempt is optional (undefined) and does not throw', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: '{"cards":[]}',
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })
    const { callImageCropWithRetry } = await importRetry()
    const result = await callImageCropWithRetry(dummyParts, dummySchema)
    expect(result.text).toBe('{"cards":[]}')
  })
})
