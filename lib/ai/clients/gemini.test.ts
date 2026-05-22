import { describe, it, expect, vi, beforeEach } from 'vitest'

// callGemini の test。 @google/genai SDK と logger は mock。
// 主眼は OCR_DEBUG_LOG env gate: 未設定で no-op、 =1 で raw response を log する。

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

async function importCallGemini() {
  return await import('./gemini')
}

beforeEach(() => {
  mockGenerateContent.mockReset()
  mockLoggerInfo.mockReset()
  // env gate はデフォルト off。 各 test が必要なら個別に '1' を set する。
  delete process.env.OCR_DEBUG_LOG
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
})
