import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockGenerateContent, mockNotifyOps } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockNotifyOps: vi.fn(),
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      models: {
        generateContent: mockGenerateContent,
      },
    }
  }),
  Type: {
    OBJECT: 'object',
    STRING: 'string',
    ARRAY: 'array',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
    INTEGER: 'integer',
  },
}))

vi.mock('@/lib/ops', () => ({ notifyOps: mockNotifyOps }))

import { generateExampleViaGemini, _resetClientForTests } from './gemini'
import { Type } from '@google/genai'

beforeEach(() => {
  vi.clearAllMocks()
  _resetClientForTests()
  vi.useRealTimers()
  mockNotifyOps.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('generateExampleViaGemini', () => {
  it('正常応答 → { sentence, translation } を返す (呼び出し 1 回)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"sentence":"I ate an apple.","translation":"私はりんごを食べました。"}',
    })

    const res = await generateExampleViaGemini({
      word: 'apple',
      meaning: 'りんご',
      userId: 'test-user-id',
    })

    expect(res.sentence).toBe('I ate an apple.')
    expect(res.translation).toBe('私はりんごを食べました。')
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)

    // Verify SDK call shape: systemInstruction + responseMimeType + responseSchema
    const callArgs = mockGenerateContent.mock.calls[0][0]
    expect(callArgs.config.systemInstruction).toContain('vocabulary example generator')
    expect(callArgs.config.responseMimeType).toBe('application/json')
    expect(callArgs.config.responseSchema.type).toBe(Type.OBJECT)
    expect(callArgs.config.responseSchema.properties.sentence.maxLength).toBe('500')
    expect(callArgs.config.responseSchema.properties.translation.maxLength).toBe('300')
  })

  it('429 → 即 throw、呼び出し 1 回 (リトライ禁止)', async () => {
    const err: Error & { status?: number } = new Error('Too Many Requests')
    err.status = 429
    mockGenerateContent.mockRejectedValue(err)

    await expect(
      generateExampleViaGemini({ word: 'apple', meaning: 'りんご', userId: 'test-user-id' }),
    ).rejects.toThrow(/Too Many Requests/)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    // 429 は notifyOps を呼ばない
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('5xx → 3 回リトライ後 throw、呼び出し 3 回', async () => {
    const err: Error & { status?: number } = new Error('Internal Server Error')
    err.status = 500
    mockGenerateContent.mockRejectedValue(err)

    await expect(
      generateExampleViaGemini({ word: 'apple', meaning: 'りんご', userId: 'test-user-id' }),
    ).rejects.toThrow(/Internal Server Error/)
    expect(mockGenerateContent).toHaveBeenCalledTimes(3)
    // 5xx exhausted → notifyOps 呼び出し 1 回
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI 5xx exhausted',
      expect.objectContaining({
        failure_kind: 'fivexx_exhausted',
        attempts: 3,
        last_status: 500,
      }),
    )
  })

  it('4xx (429 以外) → 1 回で throw、呼び出し 1 回', async () => {
    const err: Error & { status?: number } = new Error('Bad Request')
    err.status = 400
    mockGenerateContent.mockRejectedValue(err)

    await expect(
      generateExampleViaGemini({ word: 'apple', meaning: 'りんご', userId: 'test-user-id' }),
    ).rejects.toThrow(/Bad Request/)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    // 4xx は notifyOps を呼ばない
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('timeout (30s 超) → throw', async () => {
    // Use fake timers to trigger the 30s timeout immediately.
    vi.useFakeTimers()

    // generateContent never resolves in this test
    mockGenerateContent.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    )

    const pending = generateExampleViaGemini({
      word: 'apple',
      meaning: 'りんご',
      userId: 'test-user-id',
    })
    // Attach a no-op catch immediately so Node doesn't report an unhandled
    // rejection when the timeout fires before we reach `expect(pending)`.
    pending.catch(() => {})

    // Advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(30_001)

    await expect(pending).rejects.toThrow(/timeout/)
  })

  // ── New cases (spec §9.1) ──────────────────────────────────────────────────

  it('F3: schema 不整合 (sentence 欠落) → throw + notifyOps(AI output schema violation)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"translation":"x"}',
    })

    await expect(
      generateExampleViaGemini({ word: 'apple', meaning: 'りんご', userId: 'test-user-id' }),
    ).rejects.toThrow(/gemini schema mismatch/)

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI output schema violation',
      expect.objectContaining({
        failure_kind: 'output_schema',
        word: 'apple',
        meaning: 'りんご',
        raw_response_head: expect.any(String),
      }),
    )
  })

  it('F4-a: cap 違反 sentence (501 chars) → throw + notifyOps(AI output cap violation, field: sentence)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ sentence: 'a'.repeat(501), translation: 'x' }),
    })

    await expect(
      generateExampleViaGemini({ word: 'apple', meaning: 'りんご', userId: 'test-user-id' }),
    ).rejects.toThrow(/gemini sentence cap violation/)

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI output cap violation',
      expect.objectContaining({
        failure_kind: 'output_cap',
        field: 'sentence',
        actual_length: 501,
        cap: 500,
      }),
    )
  })

  it('F4-b: cap 違反 translation (301 chars) → throw + notifyOps(AI output cap violation, field: translation)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ sentence: 'x', translation: 'あ'.repeat(301) }),
    })

    await expect(
      generateExampleViaGemini({ word: 'apple', meaning: 'りんご', userId: 'test-user-id' }),
    ).rejects.toThrow(/gemini translation cap violation/)

    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI output cap violation',
      expect.objectContaining({
        failure_kind: 'output_cap',
        field: 'translation',
        actual_length: 301,
        cap: 300,
      }),
    )
  })

  it('F5: 5xx exhausted → mockGenerateContent 3 回 + notifyOps(AI 5xx exhausted, attempts: 3)', async () => {
    const err: Error & { status?: number } = new Error('Service Unavailable')
    err.status = 503
    mockGenerateContent.mockRejectedValue(err)

    await expect(
      generateExampleViaGemini({ word: 'test', meaning: 'テスト', userId: 'test-user-id' }),
    ).rejects.toThrow(/Service Unavailable/)

    expect(mockGenerateContent).toHaveBeenCalledTimes(3)
    expect(mockNotifyOps).toHaveBeenCalledTimes(1)
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI 5xx exhausted',
      expect.objectContaining({
        failure_kind: 'fivexx_exhausted',
        attempts: 3,
        last_status: 503,
        word: 'test',
        meaning: 'テスト',
      }),
    )
  })
})
