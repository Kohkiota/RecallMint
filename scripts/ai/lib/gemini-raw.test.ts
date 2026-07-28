import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_TIMEOUT_MS } from './gemini-raw'

// callGeminiRaw の test。 @google/genai SDK のみ mock (本番 gemini.test.ts と
// 同じ class-double パターン)。 主眼: usage の undefined 保持(0 に潰さない) /
// finishReason 抽出 / 空 text throw / timeout (timer 解放 + abort 後の late
// resolution を採用しない + SDK が完全にハングしても timeoutMs で必ず reject する)。

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}))

// GoogleGenAI は `new` で生成されるため、 mock は constructable な class にする。
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent }
  },
}))

const baseInput = {
  modelId: 'gemini-2.5-flash-preview',
  files: [{ mimeType: 'application/pdf', data: 'base64data' }],
  prompt: 'extract',
  responseJsonSchema: { type: 'object' },
}

async function importGeminiRaw() {
  return await import('./gemini-raw')
}

beforeEach(() => {
  mockGenerateContent.mockReset()
})

afterEach(() => {
  // timeout test が fake timers を使うため、 test ごとに real timers へ戻す。
  vi.useRealTimers()
})

describe('callGeminiRaw', () => {
  it('usageMetadata の全4フィールド(thoughtsTokenCount 込み)をそのまま返す', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 200,
        thoughtsTokenCount: 50,
        totalTokenCount: 350,
      },
    })
    const { callGeminiRaw } = await importGeminiRaw()
    const r = await callGeminiRaw(baseInput)
    expect(r.usage).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 50,
      totalTokenCount: 350,
    })
  })

  it('usageMetadata が無い場合、 usage の4フィールドは undefined のまま (0 に潰さない)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      candidates: [{ finishReason: 'STOP' }],
    })
    const { callGeminiRaw } = await importGeminiRaw()
    const r = await callGeminiRaw(baseInput)
    expect(r.usage).toEqual({
      promptTokenCount: undefined,
      candidatesTokenCount: undefined,
      thoughtsTokenCount: undefined,
      totalTokenCount: undefined,
    })
    // undefined であって 0 ではないことを明示的に確認 (toEqual は {a: undefined} と
    // {} を区別しないため、 個別に in チェックする)。
    expect(r.usage.promptTokenCount).not.toBe(0)
    expect(Number.isNaN(r.usage.promptTokenCount)).toBe(false)
    expect(r.usage.promptTokenCount).toBeUndefined()
  })

  it('finishReason は res.candidates[0] から返る', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: {},
    })
    const { callGeminiRaw } = await importGeminiRaw()
    const r = await callGeminiRaw(baseInput)
    expect(r.finishReason).toBe('MAX_TOKENS')
  })

  it('candidates が無い場合、 finishReason は undefined', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      usageMetadata: {},
    })
    const { callGeminiRaw } = await importGeminiRaw()
    const r = await callGeminiRaw(baseInput)
    expect(r.finishReason).toBeUndefined()
  })

  it('空 response text は throw する (retry なし)', async () => {
    mockGenerateContent.mockResolvedValue({ text: '', usageMetadata: {} })
    const { callGeminiRaw } = await importGeminiRaw()
    await expect(callGeminiRaw(baseInput)).rejects.toThrow(/empty/)
    // single call のみ (retry しない)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
  })

  it('timeout: abort で reject し、 timer は解放され、 abort 後の遅延成功は採用されない', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    let resolveLate: ((v: unknown) => void) | undefined
    // 敵対的 fixture: SDK が abortSignal を無視し、 reject せず後から resolve する
    // ケースを模す (late resolution を成功として採用しないことを検証するため)。
    mockGenerateContent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve
        }),
    )
    const { callGeminiRaw } = await importGeminiRaw()
    const promise = callGeminiRaw(baseInput)
    const assertion = expect(promise).rejects.toThrow(/timeout/i)
    // デフォルト timeout 経過 → setTimeout 発火 → controller.abort()
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
    // abort 発火後に、 SDK が (abortSignal を無視して) 遅れて成功 resolve したとする。
    resolveLate?.({ text: '{"cards":[]}', usageMetadata: {} })
    await assertion
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('SDK が abortSignal を無視し resolve/reject を一切呼ばず永久にハングしても timeoutMs で reject する', async () => {
    vi.useFakeTimers()
    // 敵対的 fixture: このモックは abortSignal を購読すらせず、 resolve/reject を
    // 一切呼ばない (SDK が完全にハングし続けるケースを模す)。 旧実装 (単純 await、
    // Promise.race 無し) だとこの mock では callGeminiRaw が永久に pending のままに
    // なり、 timeoutMs を過ぎても reject しなかった (review Important-1 で指摘)。
    mockGenerateContent.mockImplementation(() => new Promise(() => {}))
    const { callGeminiRaw } = await importGeminiRaw()
    const promise = callGeminiRaw(baseInput)
    const assertion = expect(promise).rejects.toThrow(/timeout/i)
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
    await assertion
  })

  it('timeoutMs を明示指定すればその時間で abort する', async () => {
    vi.useFakeTimers()
    mockGenerateContent.mockImplementation(
      (params: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.config.abortSignal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    )
    const { callGeminiRaw } = await importGeminiRaw()
    const promise = callGeminiRaw({ ...baseInput, timeoutMs: 5_000 })
    const assertion = expect(promise).rejects.toThrow(/timeout/i)
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('timeout 前に応答すれば timeout にならず通常どおり返る', async () => {
    vi.useFakeTimers()
    mockGenerateContent.mockResolvedValue({
      text: '{"cards":[]}',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    })
    const { callGeminiRaw } = await importGeminiRaw()
    const r = await callGeminiRaw(baseInput)
    expect(r.text).toBe('{"cards":[]}')
  })
})
