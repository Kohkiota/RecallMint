import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockGetCurrentUser, mockRevalidatePath, insertCalls, mockLoggerError, dbState } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockRevalidatePath: vi.fn(),
    mockLoggerError: vi.fn(),
    // Mutable state shared between the hoisted mock factory and tests
    dbState: { shouldThrow: false, throwError: null as Error | null },
    // Record insert().values().onConflictDoUpdate() chain calls
    insertCalls: [] as Array<{
      tableName: string
      values: Record<string, unknown>
      conflictTarget: unknown
      conflictSet: Record<string, unknown>
    }>,
  }))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mockLoggerError, info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    insert: (table: { _?: { name?: string }; tableName?: string }) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: (conf: { target: unknown; set: Record<string, unknown> }) => {
          if (dbState.shouldThrow) {
            return Promise.reject(dbState.throwError ?? new Error('DB error'))
          }
          insertCalls.push({
            tableName:
              (table as { _?: { name?: string } })._?.name ??
              (table as { tableName?: string }).tableName ??
              'unknown',
            values: vals,
            conflictTarget: conf.target,
            conflictSet: conf.set,
          })
          return Promise.resolve()
        },
      }),
    }),
  }),
}))

import { saveSessionLimit } from './save-session-limit'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const fakeUser = {
  id: '00000000-0000-0000-0000-000000000001',
  clerkId: 'user_test_1',
  email: 'test@example.com',
  stripeCustomerId: null,
  plan: 'free' as const,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAt: null,
  billingInterval: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  insertCalls.length = 0
  dbState.shouldThrow = false
  dbState.throwError = null
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('saveSessionLimit', () => {
  describe('auth gate', () => {
    it('getCurrentUser が null → ok:false / 認証エラー、DB 呼び出しなし', async () => {
      mockGetCurrentUser.mockResolvedValue(null)
      const result = await saveSessionLimit(20)
      expect(result).toEqual({ ok: false, error: '認証が必要です' })
      expect(insertCalls).toHaveLength(0)
    })
  })

  describe('validation', () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(fakeUser)
    })

    it('value=0 → ok:false / 範囲外エラー', async () => {
      const result = await saveSessionLimit(0)
      expect(result).toEqual({ ok: false, error: '1〜200 で指定してください' })
      expect(insertCalls).toHaveLength(0)
    })

    it('value=201 → ok:false / 範囲外エラー', async () => {
      const result = await saveSessionLimit(201)
      expect(result).toEqual({ ok: false, error: '1〜200 で指定してください' })
      expect(insertCalls).toHaveLength(0)
    })

    it('value=-1 → ok:false / 範囲外エラー', async () => {
      const result = await saveSessionLimit(-1)
      expect(result).toEqual({ ok: false, error: '1〜200 で指定してください' })
      expect(insertCalls).toHaveLength(0)
    })

    it('value=1.5 (小数) → ok:false / 整数以外エラー', async () => {
      const result = await saveSessionLimit(1.5)
      expect(result).toEqual({ ok: false, error: '1〜200 で指定してください' })
      expect(insertCalls).toHaveLength(0)
    })

    it('value=1 (境界下限) → ok:true', async () => {
      const result = await saveSessionLimit(1)
      expect(result).toEqual({ ok: true })
    })

    it('value=200 (境界上限) → ok:true', async () => {
      const result = await saveSessionLimit(200)
      expect(result).toEqual({ ok: true })
    })
  })

  describe('正常系: UPSERT', () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(fakeUser)
    })

    it('value=20 → insert chain が userId / sessionLimit で呼ばれる', async () => {
      const result = await saveSessionLimit(20)
      expect(result).toEqual({ ok: true })

      expect(insertCalls).toHaveLength(1)
      const call = insertCalls[0]
      expect(call.values).toMatchObject({
        userId: fakeUser.id,
        sessionLimit: 20,
      })
    })

    it('onConflictDoUpdate に target (userSettings.userId) と set.sessionLimit / set.updatedAt が含まれる', async () => {
      await saveSessionLimit(50)

      const call = insertCalls[0]
      // target は userSettings.userId column object
      expect(call.conflictTarget).toBeDefined()
      // set には sessionLimit: 50 が含まれる
      expect(call.conflictSet).toMatchObject({ sessionLimit: 50 })
      // I-1: updatedAt は conflict branch で明示的に更新される
      expect(call.conflictSet.updatedAt).toBeInstanceOf(Date)
    })

    it('UPSERT 後 revalidatePath は呼ばれない (S-cache-2a: 同 path、 fsrs-mode-form の router.refresh で吸収)', async () => {
      await saveSessionLimit(30)
      expect(mockRevalidatePath).not.toHaveBeenCalled()
    })
  })

  describe('エラー系: DB throw', () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(fakeUser)
    })

    it('DB が throw した場合 ok:false に変換 + logger.error 出力', async () => {
      const dbError = new Error('Neon connection timeout')
      dbState.shouldThrow = true
      dbState.throwError = dbError

      const result = await saveSessionLimit(20)
      expect(result).toEqual({ ok: false, error: '保存に失敗しました。しばらくしてからお試しください' })
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'save_session_limit.error', err: dbError }),
      )
      // revalidatePath は呼ばれない
      expect(mockRevalidatePath).not.toHaveBeenCalled()
    })
  })
})
