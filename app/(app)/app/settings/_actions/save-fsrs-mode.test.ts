import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks (save-session-limit.test.ts と同じ pattern を踏襲)
// ---------------------------------------------------------------------------
const { mockGetCurrentUser, mockRevalidatePath, insertCalls, mockLoggerError, dbState } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockRevalidatePath: vi.fn(),
    mockLoggerError: vi.fn(),
    dbState: { shouldThrow: false, throwError: null as Error | null },
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

import { saveFsrsMode } from './save-fsrs-mode'

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
describe('saveFsrsMode', () => {
  describe('auth gate', () => {
    it('getCurrentUser が null → ok:false / 認証エラー、 DB 呼び出しなし', async () => {
      mockGetCurrentUser.mockResolvedValue(null)
      const result = await saveFsrsMode(true)
      expect(result).toEqual({ ok: false, error: '認証が必要です' })
      expect(insertCalls).toHaveLength(0)
    })
  })

  describe('正常系: UPSERT (lazy init / 既存行 UPDATE)', () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(fakeUser)
    })

    it('value=true → insert chain が userId / fsrsMode=true で呼ばれる (INSERT lazy init 経路)', async () => {
      const result = await saveFsrsMode(true)
      expect(result).toEqual({ ok: true, data: { fsrsMode: true } })

      expect(insertCalls).toHaveLength(1)
      const call = insertCalls[0]
      expect(call.values).toMatchObject({
        userId: fakeUser.id,
        fsrsMode: true,
      })
    })

    it('value=false → UPDATE (onConflictDoUpdate で fsrsMode=false / updatedAt が明示更新)', async () => {
      // 既存 true 行が存在する状況も同じ UPSERT 文で処理されるため、 入力値が set に反映されればよい
      const result = await saveFsrsMode(false)
      expect(result).toEqual({ ok: true, data: { fsrsMode: false } })

      const call = insertCalls[0]
      expect(call.conflictTarget).toBeDefined()
      expect(call.conflictSet).toMatchObject({ fsrsMode: false })
      // I-1: drizzle $onUpdate は onConflictDoUpdate で発火しないため
      // conflict branch で updatedAt を明示更新する (save-session-limit と同 pattern)
      expect(call.conflictSet.updatedAt).toBeInstanceOf(Date)
    })

    it('UPSERT 後に revalidatePath("/app/settings") が呼ばれる', async () => {
      await saveFsrsMode(true)
      expect(mockRevalidatePath).toHaveBeenCalledWith('/app/settings')
    })
  })

  describe('エラー系: DB throw', () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(fakeUser)
    })

    it('DB が throw した場合 ok:false に変換 + logger.error 出力 + revalidatePath 呼ばれない', async () => {
      const dbError = new Error('Neon connection timeout')
      dbState.shouldThrow = true
      dbState.throwError = dbError

      const result = await saveFsrsMode(true)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/保存に失敗/)
      }
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'save_fsrs_mode.error', err: dbError }),
      )
      expect(mockRevalidatePath).not.toHaveBeenCalled()
    })
  })
})
