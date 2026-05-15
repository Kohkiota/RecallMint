import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDb, mockExecute, mockNotifyOps } = vi.hoisted(() => {
  const mockExecute = vi.fn()
  const mockNotifyOps = vi.fn()
  const mockDb = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const tx = { execute: mockExecute }
      // Mimic real drizzle tx: if callback throws, transaction rejects
      // (and the real PG transaction rolls back — net zero increment).
      return await fn(tx)
    }),
  }
  return { mockDb, mockExecute, mockNotifyOps }
})

vi.mock('@/lib/db', () => ({ getDb: () => mockDb }))
vi.mock('@/lib/ops', () => ({ notifyOps: mockNotifyOps }))

import { reserveAiGenSlot, LimitExceededError } from './ai-usage'

beforeEach(() => {
  vi.clearAllMocks()
  // Default env: GEMINI_DAILY_LIMIT = 1000 (vitest.setup already sets this)
  process.env.GEMINI_DAILY_LIMIT = '1000'
  // Default: notifyOps resolves silently (matches lib/ops.ts best-effort impl).
  mockNotifyOps.mockResolvedValue(undefined)
})

describe('reserveAiGenSlot', () => {
  it('OK: 両カウンタ未到達 → 両 UPSERT 実行して resolve、notifyOps 呼ばれない', async () => {
    // global UPSERT → count 500, user UPSERT → count 5 (post-increment)
    mockExecute
      .mockResolvedValueOnce({ rows: [{ count: 500 }] }) // global
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // user

    await expect(reserveAiGenSlot('user_1', 'free')).resolves.toBeUndefined()

    // Both UPSERTs executed
    expect(mockExecute).toHaveBeenCalledTimes(2)
    // 正常 path では Discord 通知発火しない (N-7 invariant)
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  it('global 到達 → LimitExceededError code=GLOBAL_LIMIT + count/limit、notifyOps daily-global で 1 回', async () => {
    // global post-increment count 1001 > limit 1000 → throw, rollback
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1001 }] })

    try {
      await reserveAiGenSlot('user_1', 'free')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LimitExceededError)
      const err = e as LimitExceededError
      expect(err.code).toBe('GLOBAL_LIMIT')
      expect(err.count).toBe(1001)
      expect(err.limit).toBe(1000)
    }
    // Per-user UPSERT never ran (short-circuit on throw)
    expect(mockExecute).toHaveBeenCalledTimes(1)
    // notifyOps fires once with daily-global payload
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI daily limit reached',
      expect.objectContaining({
        kind: 'daily-global',
        userId: 'user_1',
        plan: 'free',
        count: 1001,
        limit: 1000,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        environment: expect.any(String),
        timestamp: expect.any(String),
      }),
    )
  })

  it('user 到達 → LimitExceededError code=USER_LIMIT + count/limit、notifyOps daily-user で 1 回', async () => {
    // global 500 (OK), user post-increment 11 > Free limit 10 → throw
    mockExecute
      .mockResolvedValueOnce({ rows: [{ count: 500 }] })
      .mockResolvedValueOnce({ rows: [{ count: 11 }] })

    try {
      await reserveAiGenSlot('user_1', 'free')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LimitExceededError)
      const err = e as LimitExceededError
      expect(err.code).toBe('USER_LIMIT')
      expect(err.count).toBe(11)
      expect(err.limit).toBe(10)
    }
    // Both UPSERTs ran; transaction rolls back on throw (real PG behavior)
    expect(mockExecute).toHaveBeenCalledTimes(2)
    // notifyOps fires once with daily-user payload
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI daily limit reached',
      expect.objectContaining({
        kind: 'daily-user',
        userId: 'user_1',
        plan: 'free',
        count: 11,
        limit: 10,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        environment: expect.any(String),
        timestamp: expect.any(String),
      }),
    )
  })

  it('両方到達 → global 優先 (GLOBAL_LIMIT)、notifyOps は daily-global で 1 回のみ', async () => {
    // global already over — per-user UPSERT never reached
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1001 }] })

    try {
      await reserveAiGenSlot('user_1', 'free')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as LimitExceededError).code).toBe('GLOBAL_LIMIT')
    }
    expect(mockExecute).toHaveBeenCalledTimes(1)
    // 通知は global trip 分の 1 回のみ
    expect(mockNotifyOps).toHaveBeenCalledOnce()
    expect(mockNotifyOps).toHaveBeenCalledWith(
      'AI daily limit reached',
      expect.objectContaining({ kind: 'daily-global' }),
    )
  })

  it('notifyOps が throw しても LimitExceededError 到達 (best-effort invariant)', async () => {
    // notifyOps が transient で fail しても、main flow (LimitExceededError throw)
    // が巻き込まれてはならない (spec §6 invariant)。lib/ops.ts は内部 try/catch
    // で throw しない設計だが、本 test は実装側 catch ブロックの defensive 防御を
    // verify する。
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1001 }] })
    mockNotifyOps.mockRejectedValueOnce(new Error('Discord 503'))

    await expect(reserveAiGenSlot('user_1', 'free')).rejects.toBeInstanceOf(
      LimitExceededError,
    )

    // notifyOps は呼ばれた (mockRejectedValueOnce が消化された証跡)
    expect(mockNotifyOps).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Fix 2: GEMINI_DAILY_LIMIT parse guard
// Invalid env values must throw at module load (fail fast on misconfiguration).
// Tests use dynamic import + vi.resetModules (already in vitest.setup.ts
// beforeEach) so each test re-evaluates the module with a fresh env.
// ---------------------------------------------------------------------------
describe('GEMINI_DAILY_LIMIT validation at module load', () => {
  const ORIGINAL_ENV = process.env.GEMINI_DAILY_LIMIT

  beforeEach(() => {
    // Reset to a known good baseline before each test mutates it.
    process.env.GEMINI_DAILY_LIMIT = ORIGINAL_ENV
  })

  it('"" (empty) → throw', async () => {
    process.env.GEMINI_DAILY_LIMIT = ''
    await expect(import('./ai-usage')).rejects.toThrow(
      /GEMINI_DAILY_LIMIT must be a positive number/,
    )
  })

  it('"abc" (non-numeric) → throw', async () => {
    process.env.GEMINI_DAILY_LIMIT = 'abc'
    await expect(import('./ai-usage')).rejects.toThrow(
      /GEMINI_DAILY_LIMIT must be a positive number/,
    )
  })

  it('"0" (zero) → throw', async () => {
    process.env.GEMINI_DAILY_LIMIT = '0'
    await expect(import('./ai-usage')).rejects.toThrow(
      /GEMINI_DAILY_LIMIT must be a positive number/,
    )
  })

  it('"-1" (negative) → throw', async () => {
    process.env.GEMINI_DAILY_LIMIT = '-1'
    await expect(import('./ai-usage')).rejects.toThrow(
      /GEMINI_DAILY_LIMIT must be a positive number/,
    )
  })

  it('"1000" (valid) → import succeeds', async () => {
    process.env.GEMINI_DAILY_LIMIT = '1000'
    const mod = await import('./ai-usage')
    expect(mod.reserveAiGenSlot).toBeDefined()
    expect(mod.LimitExceededError).toBeDefined()
  })
})
