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

// `deadlineAt` は必須引数(S-5b: optional を撤去 — 未指定にしてよい呼出元が
// 旧経路の撤去で存在しなくなったため)。 打ち切りを見ない test は「残余が十分」な
// 値を渡す(打ち切り境界そのものの検証は下の deadlineAt 系 2 本が担う)。
function ampleDeadline(): Date {
  return new Date(Date.now() + 60 * 60 * 1000)
}

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

    const result = await callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt)

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

    await expect(callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt),
    ).rejects.toThrow(
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

    const p = callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt, () => 0)
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

    const p = callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt, () => 0).catch(
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

    await expect(callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt),
    ).rejects.toThrow(
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

    const result = await callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt)
    expect(result.text).toBe('{"cards":[]}')
  })

  // ②-4a 単一 invocation S-2(canonical review I-1): retry ループが呼出側の
  // time budget を食い破らないための打ち切り。1 attempt は最悪
  // GEMINI_TIMEOUT_MS(220s)掛かるため、それを賄えない残余では次の attempt に
  // 入らない。
  it('deadlineAt: 残余 < GEMINI_TIMEOUT_MS なら次の attempt を始めずに直前の error を投げる', async () => {
    mockCallGemini.mockRejectedValue(new Error('503 Service Unavailable'))
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    // 初回 attempt は走る(呼出側 pre-call gate の担当)。backoff 後の 2 回目は
    // 残余(10s)< 220s で打ち切られる。
    const err = await callImageCropWithRetry(
      dummyParts,
      dummySchema,
      new Date(Date.now() + 10_000),
      onAttempt,
      () => 0,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/503/)
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledTimes(1)
  })

  it('deadlineAt: 残余が十分なら従来どおり retry する(打ち切りは残余基準のみ)', async () => {
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

    const p = callImageCropWithRetry(
      dummyParts,
      dummySchema,
      new Date(Date.now() + 600_000),
      onAttempt,
      () => 0,
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await p

    expect(result.text).toBe('{"cards":[]}')
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
  })

  it('残余が潤沢なら打ち切りは効かず 3 attempts(初回 + 2 retries)まで走る', async () => {
    vi.useFakeTimers()
    mockCallGemini.mockRejectedValue(new Error('503 Service Unavailable'))
    const onAttempt = vi.fn()
    const { callImageCropWithRetry } = await importRetry()

    const p = callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline(), onAttempt, () => 0).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(20_000)
    await p

    expect(mockCallGemini).toHaveBeenCalledTimes(3)
    expect(onAttempt).toHaveBeenCalledTimes(3)
  })

  it('onAttempt is optional (undefined) and does not throw', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: '{"cards":[]}',
      inputTokens: 1,
      outputTokens: 1,
      thoughtsTokens: 0,
    })
    const { callImageCropWithRetry } = await importRetry()
    const result = await callImageCropWithRetry(dummyParts, dummySchema, ampleDeadline())
    expect(result.text).toBe('{"cards":[]}')
  })
})
