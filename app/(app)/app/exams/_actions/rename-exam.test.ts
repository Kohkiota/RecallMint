import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

// renameExam server action の test (Grid-3 §6.2)。
// auth / zod 境界 / owner-scope WHERE / 「UPDATE は name 列のみ」 /
// 0 行更新 → failure / DB throw → failure + P0RLS alert / revalidatePath を検証。

const {
  mockGetCurrentUser,
  mockRevalidatePath,
  mockReportRlsContextFailure,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockReportRlsContextFailure: vi.fn(async () => {}),
  dbState: {
    updateTables: [] as unknown[],
    setValues: null as Record<string, unknown> | null,
    whereArgs: [] as unknown[][],
    returningRows: [] as Record<string, unknown>[],
    throwOnReturning: false,
  },
}))

// drizzle-orm の eq をスパイ化 (実装は real のまま)。 WHERE から
// eq(exams.userId, user.id) が消える regression を検出するため。
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  return { ...real, eq: spyEq }
})

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/db/report-rls-context-failure', () => ({
  reportRlsContextFailure: mockReportRlsContextFailure,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/db', () => {
  function updateChain(table: unknown) {
    dbState.updateTables.push(table)
    const obj: Record<string, unknown> = {}
    obj.set = (vals: Record<string, unknown>) => {
      dbState.setValues = vals
      return obj
    }
    obj.where = (...args: unknown[]) => {
      dbState.whereArgs.push(args)
      return obj
    }
    obj.returning = () => {
      if (dbState.throwOnReturning) {
        return Promise.reject(new Error('db boom'))
      }
      return Promise.resolve(dbState.returningRows)
    }
    return obj
  }
  return {
    getDb: () => ({ update: updateChain }),
  }
})

// create-exam.test.ts と同じ passthrough (unit test では実 tx を張らない)。
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: async (_userId: string, fn: (tx: unknown) => unknown) => {
    const { getDb } = await import('@/lib/db')
    return fn(getDb())
  },
}))

async function importAction() {
  return await import('./rename-exam')
}

beforeEach(async () => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  mockReportRlsContextFailure.mockClear()
  dbState.updateTables = []
  dbState.setValues = null
  dbState.whereArgs = []
  dbState.returningRows = [{ id: 'exam-uuid' }]
  dbState.throwOnReturning = false
  const { eq } = await import('drizzle-orm')
  vi.mocked(eq).mockClear()
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-uuid',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
})

describe('renameExam', () => {
  it('auth fail → { ok:false, 認証が必要です }, no UPDATE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', '新しい試験名')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('空文字 → { ok:false, 試験名は必須です }, no UPDATE', async () => {
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('試験名は必須です')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('空白のみ → { ok:false, 試験名は必須です }, no UPDATE', async () => {
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', '   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('試験名は必須です')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('201 文字 → { ok:false, 200 文字以内 }, no UPDATE', async () => {
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', 'a'.repeat(201))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('試験名は 200 文字以内で入力してください')
    expect(dbState.updateTables).toHaveLength(0)
  })

  it('ちょうど 200 文字は valid (境界値)', async () => {
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', 'a'.repeat(200))
    expect(r.ok).toBe(true)
    expect(dbState.setValues?.name).toBe('a'.repeat(200))
  })

  it('正常 → exams を UPDATE + { ok: true }、 trim 済 name が渡る', async () => {
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', '  新しい試験名  ')
    expect(r.ok).toBe(true)
    expect(dbState.updateTables.map((t) => getTableName(t as never))).toEqual([
      'exams',
    ])
    expect(dbState.setValues?.name).toBe('新しい試験名')
  })

  it('UPDATE の SET は name 列のみ (updated_at は $onUpdate 任せ)', async () => {
    const { renameExam } = await importAction()
    await renameExam('exam-uuid', '新しい試験名')
    expect(Object.keys(dbState.setValues ?? {})).toEqual(['name'])
  })

  it('owner-scope: WHERE に eq(exams.id, examId) と eq(exams.userId, user.id) が入る', async () => {
    const { renameExam } = await importAction()
    const { eq } = await import('drizzle-orm')
    const { exams } = await import('@/lib/db/schema')
    const r = await renameExam('exam-uuid', '新しい試験名')
    expect(r.ok).toBe(true)
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([exams.id, 'exam-uuid'])
    expect(calls).toContainEqual([exams.userId, 'user-uuid'])
    // WHERE は 1 回だけ (owner 条件を落とした別 UPDATE が同居しない)
    expect(dbState.whereArgs).toHaveLength(1)
  })

  it('0 行更新 (不在 / 他 user の examId) → { ok: false } + 説明 message', async () => {
    dbState.returningRows = []
    const { renameExam } = await importAction()
    const r = await renameExam('other-user-exam-uuid', '新しい試験名')
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toBe(
        '試験が見つかりませんでした。画面を再読み込みしてください。',
      )
  })

  it('DB throw → { ok: false } + P0RLS alert 経路を通る (throw は外に漏れない)', async () => {
    dbState.throwOnReturning = true
    const { renameExam } = await importAction()
    const r = await renameExam('exam-uuid', '新しい試験名')
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toBe(
        '試験名の変更に失敗しました。しばらくしてから再度お試しください。',
      )
    expect(mockReportRlsContextFailure).toHaveBeenCalledWith(expect.anything(), {
      route: 'rename-exam',
      op: 'update',
    })
  })

  it('success / zod error / auth error のいずれでも revalidatePath("/app/upload") (finally)', async () => {
    const { renameExam } = await importAction()

    await renameExam('exam-uuid', '新しい試験名')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')

    mockRevalidatePath.mockClear()
    await renameExam('exam-uuid', '')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')

    mockRevalidatePath.mockClear()
    mockGetCurrentUser.mockResolvedValueOnce(null)
    await renameExam('exam-uuid', '新しい試験名')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
  })
})
