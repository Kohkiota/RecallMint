import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockCallGemini, mockParseRetryAfterMs } = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
  mockParseRetryAfterMs: vi.fn(),
}))

vi.mock('./clients/gemini', () => ({
  callGemini: mockCallGemini,
  parseRetryAfterMs: mockParseRetryAfterMs,
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
  // デフォルト: Retry-After なし (null を返す)
  mockParseRetryAfterMs.mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runOcrPipeline', () => {
  it('Flash success path: 1 card extracted, model chain = [flash], cost > 0', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: validResponseText,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      thoughtsTokens: 0,
    })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.cards).toHaveLength(1)
    expect(result.modelChain).toEqual(['flash'])
    expect(result.flashError).toBeUndefined()
    expect(result.tokenUsage).toEqual([
      { model: 'flash', inputTokens: 1_000_000, outputTokens: 100_000, thoughtsTokens: 0 },
    ])
    // Flash(lite) 1M input * $0.25 + 100k output * $1.5 = $0.40 * 150 = ¥60
    // (②-2: gemini-3.1-flash-lite 単価。S1.9.2: integer 丸め廃止、 小数 4 桁保持)
    expect(result.costYen).toBe(60)
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })

  it('thoughtsTokens を tokenUsage に透過し costYen の output 課金に加算', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: validResponseText,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      thoughtsTokens: 200_000,
    })
    const { runOcrPipeline } = await importOcr()
    const result = await runOcrPipeline([sampleFile])
    expect(result.tokenUsage).toEqual([
      { model: 'flash', inputTokens: 1_000_000, outputTokens: 100_000, thoughtsTokens: 200_000 },
    ])
    // Flash(lite): 1M in * $0.25 + (100k out + 200k thoughts) * $1.5
    //   = $0.25 + 300k/1M*$1.5 = $0.25 + $0.45 = $0.70 * 150 = ¥105
    expect(result.costYen).toBe(105)
  })

  // Pro fallback 撤去: Flash 0 cards → 即 throw (Pro へ移らない)
  it('Flash returns 0 cards → 即 throw (Pro fallback なし)', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: emptyCardsResponseText,
      inputTokens: 1000,
      outputTokens: 100,
    })
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
    // Flash 1 call のみ、 Pro は呼ばれない
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockCallGemini).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: 'pro' }),
    )
  })

  // Pro fallback 撤去: Flash JSON parse fail → 即 throw (Pro へ移らない)
  it('Flash JSON parse fail → 即 throw (Pro fallback なし)', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: malformedJsonText,
      inputTokens: 1000,
      outputTokens: 50,
    })
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockCallGemini).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: 'pro' }),
    )
  })

  // Pro fallback 撤去: Flash HTTP fail (retry 尽きる) → 即 throw
  it('Flash HTTP fail (retry 尽きる: 503 × 3) → 即 throw (Pro fallback なし)', async () => {
    vi.useFakeTimers()
    mockCallGemini.mockRejectedValue(new Error('503 Service Unavailable'))
    const { runOcrPipeline } = await importOcr()
    // rng=()=>0 で jitter=0。 retry 前 backoff は 5000ms + 20000ms
    // catch で先に rejection を捕捉してから assertion することで
    // unhandled rejection warning を防ぐ。
    const resultPromise = runOcrPipeline([sampleFile], { rng: () => 0 }).catch(
      (e) => e,
    )
    await vi.advanceTimersByTimeAsync(5000)   // 1st retry backoff
    await vi.advanceTimersByTimeAsync(20000)  // 2nd retry backoff
    const err = await resultPromise
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/OCR pipeline failed/)
    // callWithRetry は最大 3 attempts (初回 + 2 retry) で諦める。 Pro は呼ばれない。
    expect(mockCallGemini).toHaveBeenCalledTimes(3)
    expect(mockCallGemini).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: 'pro' }),
    )
  })

  it('transient 503 from Flash → backoff retry → success on 2nd attempt', async () => {
    vi.useFakeTimers()
    mockCallGemini
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
    const { runOcrPipeline } = await importOcr()
    // rng=()=>0 で jitter=0、 1 回目 retry 前の static backoff は 5000ms
    const resultPromise = runOcrPipeline([sampleFile], { rng: () => 0 })
    // 5000ms 経過させて retry を解放する
    await vi.advanceTimersByTimeAsync(5000)
    const result = await resultPromise
    expect(result.cards).toHaveLength(1)
    expect(result.modelChain).toEqual(['flash'])
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
  })

  // S2.0.5: 429 (rate limit) は CLAUDE.md AI ルール 5「即時停止・リトライ禁止」。
  it('429 from Flash → 即時停止 (retry なし / Pro fallback なし / 1 call のみ)', async () => {
    // mockRejectedValue で全 call が 429 を返す状況でも、 1 回呼んで即 throw する。
    mockCallGemini.mockRejectedValue(new Error('429 Too Many Requests'))
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(/rate limited/i)
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })

  it('rate limit error (429 数字なし) from Flash → 即時停止 (1 call のみ)', async () => {
    mockCallGemini.mockRejectedValue(
      new Error('Rate limit exceeded for this project'),
    )
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })

  it('RESOURCE_EXHAUSTED from Flash → 即時停止 (1 call のみ)', async () => {
    mockCallGemini.mockRejectedValue(
      new Error('[RESOURCE_EXHAUSTED] quota exceeded'),
    )
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
  })

  // Pro fallback 撤去: non-transient error (invalid API key 等) → 即 throw (Pro へ移らない)
  it('non-transient error (e.g. invalid API key) from Flash → no retry → 即 throw (Pro fallback なし)', async () => {
    mockCallGemini.mockRejectedValueOnce(
      new Error('400 Bad Request: invalid argument'),
    )
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
    // Flash 1 attempt (no retry on non-transient)、 Pro は呼ばれない → 合計 1 call
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockCallGemini).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: 'pro' }),
    )
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

  // Pro fallback 撤去: Flash 503 retry → Flash 2nd success (Pro へ移らない)
  it('onAttempt callback fires for each retry (Flash 503 → retry → success = 2 calls)', async () => {
    vi.useFakeTimers()
    mockCallGemini
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
    const onAttempt = vi.fn()
    const { runOcrPipeline } = await importOcr()
    const resultPromise = runOcrPipeline([sampleFile], { onAttempt, rng: () => 0 })
    await vi.advanceTimersByTimeAsync(5000)
    await resultPromise
    // Flash 1st (503 → retry), Flash 2nd (success) → 2 calls
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onAttempt.mock.calls.map((c) => c[0])).toEqual(['flash', 'flash'])
  })

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

  // Pro fallback 撤去: zod validation fail → 即 throw (Pro へ移らない)
  it('zod validation rejects malformed card (missing required field) → 即 throw (Pro fallback なし)', async () => {
    const malformedCard = { title: '問1' } // question_text / options 等 missing
    mockCallGemini.mockResolvedValueOnce({
      text: JSON.stringify({ cards: [malformedCard] }),
      inputTokens: 1000,
      outputTokens: 100,
    })
    const { runOcrPipeline } = await importOcr()
    await expect(runOcrPipeline([sampleFile])).rejects.toThrow(
      /OCR pipeline failed/,
    )
    // Flash 1 call のみ、 Pro は呼ばれない
    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    expect(mockCallGemini).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: 'pro' }),
    )
  })

  // callGemini が 'pro' model で一度も呼ばれないことを確認 (Flash only 保証)
  it('callGemini never called with model=pro across all call paths (Flash only guarantee)', async () => {
    // Happy path で Pro が混入しないことを確認
    mockCallGemini.mockResolvedValueOnce({
      text: validResponseText,
      inputTokens: 1000,
      outputTokens: 100,
    })
    const { runOcrPipeline } = await importOcr()
    await runOcrPipeline([sampleFile])
    const calledWithPro = mockCallGemini.mock.calls.some(
      (args) => args[0]?.model === 'pro',
    )
    expect(calledWithPro).toBe(false)
  })

  // ----------------------------------------------------------------
  // backoff 延長 / network error retry / Retry-After 優先
  // ----------------------------------------------------------------

  describe('callWithRetry backoff (5s/20s + jitter)', () => {
    it('1st retry 前 backoff: rng=()=>0 のとき 5000ms 待機 (jitter 0)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      // 4999ms では resolve しないことを確認 (まだ待機中)
      await vi.advanceTimersByTimeAsync(4999)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      // 5000ms 到達で retry が走る
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('1st retry 前 backoff: rng=()=>1 のとき 7000ms 待機 (jitter 2000ms)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 1 })
      // 6999ms では resolve しない
      await vi.advanceTimersByTimeAsync(6999)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      // 7000ms 到達で retry が走る
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('2nd retry 前 backoff: rng=()=>0 のとき 20000ms 待機', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      // 1st retry 前 backoff (5000ms) 消化
      await vi.advanceTimersByTimeAsync(5000)
      // 2nd retry 前 19999ms では 3 回目 call はまだ走らない
      await vi.advanceTimersByTimeAsync(19999)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
      // 20000ms 到達で 3 回目 call が走る
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(3)
    })

    it('2nd retry 前 backoff: rng=()=>1 のとき 25000ms 待機 (jitter 5000ms)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 1 })
      // 1st retry 前 backoff (rng=1 → 5000+2000=7000ms)
      await vi.advanceTimersByTimeAsync(7000)
      // 2nd retry 前 24999ms では 3 回目 call はまだ走らない
      await vi.advanceTimersByTimeAsync(24999)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
      // 25000ms 到達で 3 回目 call が走る
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(3)
    })
  })

  describe('isTransientError network errors', () => {
    it('"fetch failed" message → transient (retry される)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await p
      expect(result.cards).toHaveLength(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('"ECONNRESET" message → transient (retry される)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('read ECONNRESET'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await p
      expect(result.cards).toHaveLength(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('"ECONNREFUSED" message → transient (retry される)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await p
      expect(result.cards).toHaveLength(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('"ENOTFOUND" message → transient (retry される)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await p
      expect(result.cards).toHaveLength(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('"EAI_AGAIN" message → transient (retry される)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await p
      expect(result.cards).toHaveLength(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('"socket hang up" message → transient (retry される)', async () => {
      vi.useFakeTimers()
      mockCallGemini
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await p
      expect(result.cards).toHaveLength(1)
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('400 Bad Request → non-transient (retry されない)', async () => {
      mockCallGemini.mockRejectedValueOnce(new Error('400 Bad Request'))
      const { runOcrPipeline } = await importOcr()
      await expect(runOcrPipeline([sampleFile])).rejects.toThrow(/OCR pipeline failed/)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
    })
  })

  describe('Retry-After priority', () => {
    it('parseRetryAfterMs が 8000ms を返すとき static backoff より優先して 8000ms 待機', async () => {
      vi.useFakeTimers()
      const retryAfterErr = new Error('503 Service Unavailable')
      mockParseRetryAfterMs.mockImplementation((err: unknown) =>
        err === retryAfterErr ? 8000 : null,
      )
      mockCallGemini
        .mockRejectedValueOnce(retryAfterErr)
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      // rng=()=>0 の static backoff は 5000ms だが、 Retry-After=8000 が優先される
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      // 7999ms ではまだ retry が走らない
      await vi.advanceTimersByTimeAsync(7999)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      // 8000ms 到達で retry が走る
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('parseRetryAfterMs が null を返すとき static backoff (5000ms) で待機', async () => {
      vi.useFakeTimers()
      mockParseRetryAfterMs.mockReturnValue(null)
      mockCallGemini
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      // 4999ms ではまだ retry が走らない
      await vi.advanceTimersByTimeAsync(4999)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    it('Retry-After が 3000ms のとき static backoff (5000ms) より短くても優先される', async () => {
      vi.useFakeTimers()
      const retryAfterErr = new Error('503 Service Unavailable')
      mockParseRetryAfterMs.mockImplementation((err: unknown) =>
        err === retryAfterErr ? 3000 : null,
      )
      mockCallGemini
        .mockRejectedValueOnce(retryAfterErr)
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      // 2999ms ではまだ retry が走らない
      await vi.advanceTimersByTimeAsync(2999)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      // 3000ms で retry が走る (static 5000ms は使われない)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })

    // Retry-After clamp: サーバーが巨大な値 (例: 86400s = 1 日) を返しても
    // RETRY_AFTER_CAP_MS (60_000ms) に clamp される。
    it('parseRetryAfterMs が 200_000ms (> cap) を返すとき 60_000ms に clamp される', async () => {
      vi.useFakeTimers()
      const retryAfterErr = new Error('503 Service Unavailable')
      mockParseRetryAfterMs.mockImplementation((err: unknown) =>
        err === retryAfterErr ? 200_000 : null,
      )
      mockCallGemini
        .mockRejectedValueOnce(retryAfterErr)
        .mockResolvedValueOnce({
          text: validResponseText,
          inputTokens: 1000,
          outputTokens: 100,
        })
      const { runOcrPipeline } = await importOcr()
      // rng=()=>0 の static backoff は 5000ms だが、 Retry-After=200_000 が来ても cap に clamp される
      const p = runOcrPipeline([sampleFile], { rng: () => 0 })
      // 59_999ms ではまだ retry が走らない (cap=60_000 未到達)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(mockCallGemini).toHaveBeenCalledTimes(1)
      // 60_000ms 到達で retry が走る (200_000ms ではなく clamp 値で待機)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(mockCallGemini).toHaveBeenCalledTimes(2)
    })
  })

  // ----------------------------------------------------------------
  // Task 4: overall 720s deadline / OcrDeadlineError
  // ----------------------------------------------------------------

  describe('overall 720s deadline (OcrDeadlineError)', () => {
    it('OcrDeadlineError is a subclass of Error (instanceof check)', async () => {
      const { OcrDeadlineError } = await importOcr()
      const err = new OcrDeadlineError()
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(OcrDeadlineError)
    })

    it('pipeline stuck beyond 720s → OcrDeadlineError is thrown', async () => {
      vi.useFakeTimers()
      // callGemini never resolves (simulates hung pipeline > 720s)
      mockCallGemini.mockReturnValue(new Promise(() => {}))
      const { runOcrPipeline, OcrDeadlineError } = await importOcr()
      const p = runOcrPipeline([sampleFile], { rng: () => 0 }).catch((e) => e)
      // 719_999ms — deadline not yet reached
      await vi.advanceTimersByTimeAsync(719_999)
      // 720_000ms — deadline fires
      await vi.advanceTimersByTimeAsync(1)
      const err = await p
      expect(err).toBeInstanceOf(OcrDeadlineError)
    })

    it('pipeline that completes before 720s does NOT throw OcrDeadlineError', async () => {
      vi.useFakeTimers()
      mockCallGemini.mockResolvedValueOnce({
        text: validResponseText,
        inputTokens: 1000,
        outputTokens: 100,
      })
      const { runOcrPipeline, OcrDeadlineError } = await importOcr()
      const result = await runOcrPipeline([sampleFile])
      expect(result.cards).toHaveLength(1)
      // No pending timers should remain after normal completion
      // (deadline timer must have been cleared)
      const pendingCount = vi.getTimerCount()
      expect(pendingCount).toBe(0)
      // Result is not an OcrDeadlineError
      expect(result).not.toBeInstanceOf(OcrDeadlineError)
    })

    it('deadline timer is cleared even when pipeline throws before 720s', async () => {
      vi.useFakeTimers()
      mockCallGemini.mockRejectedValueOnce(new Error('400 Bad Request'))
      const { runOcrPipeline } = await importOcr()
      await expect(runOcrPipeline([sampleFile])).rejects.toThrow(/OCR pipeline failed/)
      // No pending timers remain (deadline clearTimeout was called)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('OCR_OVERALL_DEADLINE_MS is exported and equals 720_000', async () => {
      const { OCR_OVERALL_DEADLINE_MS } = await importOcr()
      expect(OCR_OVERALL_DEADLINE_MS).toBe(720_000)
    })
  })
})
