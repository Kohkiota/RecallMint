import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// callGemini の test。 @google/genai SDK と logger は mock。
// 主眼: OCR_DEBUG_LOG env gate / timeout 220s / parseRetryAfterMs helper

const { mockGenerateContent, mockLoggerInfo } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockLoggerInfo: vi.fn(),
}))

// GoogleGenAI は `new` で生成されるため、 mock は constructable な class にする。
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}))

const baseInput = {
  model: 'flash' as const,
  files: [{ mimeType: 'application/pdf', data: 'base64data' }],
  prompt: 'extract',
  responseJsonSchema: { type: 'object' },
}

async function importGemini() {
  return await import('./gemini')
}

// 後方互換のエイリアス
async function importCallGemini() {
  return await importGemini()
}

beforeEach(() => {
  mockGenerateContent.mockReset()
  mockLoggerInfo.mockReset()
  // env gate はデフォルト off。 各 test が必要なら個別に '1' を set する。
  delete process.env.OCR_DEBUG_LOG
})

afterEach(() => {
  // timeout test が fake timers を使うため、 test ごとに real timers へ戻す。
  vi.useRealTimers()
})

describe('callGemini', () => {
  it('text + token usage を返す', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 },
    })
    const { callGemini } = await importCallGemini()
    const r = await callGemini(baseInput)
    expect(r).toEqual({
      text: '{"cards":[]}',
      inputTokens: 100,
      outputTokens: 200,
    })
  })

  it('空 response text は throw', async () => {
    mockGenerateContent.mockResolvedValue({ text: '', usageMetadata: {} })
    const { callGemini } = await importCallGemini()
    await expect(callGemini(baseInput)).rejects.toThrow('empty response')
  })

  it('OCR_DEBUG_LOG 未設定では response を log しない', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      usageMetadata: {},
    })
    const { callGemini } = await importCallGemini()
    await callGemini(baseInput)
    const debugCalls = mockLoggerInfo.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'ocr.gemini.response',
    )
    expect(debugCalls).toHaveLength(0)
  })

  it('OCR_DEBUG_LOG=1 で raw response を log する', async () => {
    process.env.OCR_DEBUG_LOG = '1'
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[1]}',
      usageMetadata: {},
    })
    const { callGemini } = await importCallGemini()
    await callGemini(baseInput)
    expect(mockLoggerInfo).toHaveBeenCalledWith({
      event: 'ocr.gemini.response',
      model: 'flash',
      textPreview: '{"cards":[1]}',
      textLength: 13,
    })
  })

  it('OCR_DEBUG_LOG=1 で長大 response は textPreview を 50000 文字に truncate', async () => {
    process.env.OCR_DEBUG_LOG = '1'
    const longText = 'a'.repeat(60000)
    mockGenerateContent.mockResolvedValue({ text: longText, usageMetadata: {} })
    const { callGemini } = await importCallGemini()
    await callGemini(baseInput)
    const payload = mockLoggerInfo.mock.calls[0][0] as {
      textPreview: string
      textLength: number
    }
    expect(payload.textPreview).toHaveLength(50000)
    expect(payload.textLength).toBe(60000)
  })

  it('OCR_DEBUG_LOG=1 でも text は通常どおり返る (log は副作用のみ)', async () => {
    process.env.OCR_DEBUG_LOG = '1'
    mockGenerateContent.mockResolvedValue({
      text: '{"ok":true}',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    })
    const { callGemini } = await importCallGemini()
    const r = await callGemini(baseInput)
    expect(r.text).toBe('{"ok":true}')
  })

  // OCR は重い多ページ生成処理であり数分かかることがあるため、
  // Vercel Pro function timeout (900s) に収まる範囲で十分なマージンを確保するよう
  // 30s → 220s に拡張した。
  it('220 秒応答が無ければ abort し timeout error を throw する', async () => {
    vi.useFakeTimers()
    // SDK mock は abortSignal を尊重し、 abort 時に reject する。
    mockGenerateContent.mockImplementation(
      (params: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.config.abortSignal.addEventListener('abort', () => {
            reject(new Error('The request was aborted.'))
          })
        }),
    )
    const { callGemini } = await importCallGemini()
    const promise = callGemini(baseInput)
    const assertion = expect(promise).rejects.toThrow(/timeout/i)
    // 220 秒経過 → setTimeout 発火 → controller.abort()
    await vi.advanceTimersByTimeAsync(220_000)
    await assertion
  })

  it('timeout error message は "timeout" という英単語を含む (isTransientError /timeout/i マッチ用)', async () => {
    vi.useFakeTimers()
    mockGenerateContent.mockImplementation(
      (params: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.config.abortSignal.addEventListener('abort', () => {
            reject(new Error('The request was aborted.'))
          })
        }),
    )
    const { callGemini } = await importCallGemini()
    const assertion = expect(callGemini(baseInput)).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(220_000)
    await assertion
  })

  it('timeout error message に 220000 ms の数値が含まれる (定数検証)', async () => {
    vi.useFakeTimers()
    mockGenerateContent.mockImplementation(
      (params: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.config.abortSignal.addEventListener('abort', () => {
            reject(new Error('The request was aborted.'))
          })
        }),
    )
    const { callGemini } = await importCallGemini()
    const assertion = expect(callGemini(baseInput)).rejects.toThrow('220000')
    await vi.advanceTimersByTimeAsync(220_000)
    await assertion
  })

  it('220 秒未満で応答すれば timeout にならず通常どおり返る', async () => {
    vi.useFakeTimers()
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    })
    const { callGemini } = await importCallGemini()
    const r = await callGemini(baseInput)
    expect(r).toEqual({ text: '{"cards":[]}', inputTokens: 10, outputTokens: 20 })
  })

  it('abort 以外の error は timeout に変換せずそのまま throw する', async () => {
    mockGenerateContent.mockRejectedValue(new Error('500 Internal Server Error'))
    const { callGemini } = await importCallGemini()
    await expect(callGemini(baseInput)).rejects.toThrow(/500 Internal/)
  })
})

// parseRetryAfterMs: @google/genai SDK の ApiError は status と message のみを持ち、
// Retry-After header は SDK 内部の retry ループで消費されてユーザーコードに露出しない。
// そのため、取得経路は存在せず常に null を返す。 将来 SDK が header を公開した際の
// 拡張ポイントとして interface を保持する。
describe('parseRetryAfterMs', () => {
  it('null / undefined error → null', async () => {
    const { parseRetryAfterMs } = await importGemini()
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs(undefined)).toBeNull()
  })

  it('通常の Error (Retry-After 情報なし) → null', async () => {
    const { parseRetryAfterMs } = await importGemini()
    expect(parseRetryAfterMs(new Error('something failed'))).toBeNull()
  })

  it('status のみの ApiError-like object → null', async () => {
    const { parseRetryAfterMs } = await importGemini()
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429 })
    expect(parseRetryAfterMs(err)).toBeNull()
  })

  it('headers に retry-after (秒) を持つ error-like object → ms に変換して返す', async () => {
    const { parseRetryAfterMs } = await importGemini()
    // APIError (GeminiNextGenAPIClientError subclass) は headers: Headers を持つが、
    // 現行 SDK では generateContent から throw される ApiError には headers がない。
    // 将来の拡張や手動 mock に備えて、 headers.get('retry-after') 経路を検証する。
    const headers = new Headers({ 'retry-after': '30' })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(parseRetryAfterMs(err)).toBe(30_000)
  })

  it('headers に retry-after-ms を持つ error-like object → ms として返す', async () => {
    const { parseRetryAfterMs } = await importGemini()
    const headers = new Headers({ 'retry-after-ms': '5000' })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(parseRetryAfterMs(err)).toBe(5_000)
  })

  it('headers に HTTP date 形式の retry-after を持つ error → ms に変換して返す (将来日時)', async () => {
    const { parseRetryAfterMs } = await importGemini()
    // 5 秒後の HTTP date を生成
    const futureDate = new Date(Date.now() + 5_000).toUTCString()
    const headers = new Headers({ 'retry-after': futureDate })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    const result = parseRetryAfterMs(err)
    // 正確な ms は実行タイミングに依存するため、 0 < result <= 6000 で範囲チェック
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(0)
    expect(result!).toBeLessThanOrEqual(6_000)
  })

  it('headers に過去日時の retry-after を持つ error → null (負値は無効)', async () => {
    const { parseRetryAfterMs } = await importGemini()
    const pastDate = new Date(Date.now() - 5_000).toUTCString()
    const headers = new Headers({ 'retry-after': pastDate })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(parseRetryAfterMs(err)).toBeNull()
  })

  it('headers の retry-after が NaN 文字列 → null', async () => {
    const { parseRetryAfterMs } = await importGemini()
    const headers = new Headers({ 'retry-after': 'not-a-number-and-not-a-date' })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(parseRetryAfterMs(err)).toBeNull()
  })

  it('retry-after-ms が負値 → null', async () => {
    const { parseRetryAfterMs } = await importGemini()
    const headers = new Headers({ 'retry-after-ms': '-1000' })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(parseRetryAfterMs(err)).toBeNull()
  })

  it('retry-after (秒) が負値 → null', async () => {
    const { parseRetryAfterMs } = await importGemini()
    const headers = new Headers({ 'retry-after': '-5' })
    const err = Object.assign(new Error('429'), { status: 429, headers })
    expect(parseRetryAfterMs(err)).toBeNull()
  })
})
