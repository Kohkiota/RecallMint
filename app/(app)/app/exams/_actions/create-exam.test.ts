import { describe, it, expect, vi, beforeEach } from 'vitest'

// createExam server action のテスト。
// zod validation (空白のみ / 201文字超) / DB insert + examId 返却 /
// owner-scope (userId = 認証 user.id 固定) / revalidatePath('/app/upload') を検証。

const { mockGetCurrentUser, mockRevalidatePath, dbState } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    insertTable: null as unknown,
    insertValues: null as Record<string, unknown> | null,
    returningRows: [] as Record<string, unknown>[],
    throwOnReturning: false,
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/db', () => {
  function insertChain() {
    const obj: Record<string, unknown> = {}
    obj.values = (vals: Record<string, unknown>) => {
      dbState.insertValues = vals
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
    getDb: () => ({
      insert: (table: unknown) => {
        dbState.insertTable = table
        return insertChain()
      },
    }),
  }
})

// RLS-P2 §B: createExam は exams INSERT を withTenantTx(getDb(), user.id, tx => ...) で
// 包む。 unit test では DB に触れないよう withTenantTx を passthrough 化し、 fn には
// getDb() の戻り (= insert を持つ db mock) をそのまま渡す (tx 冒頭の setTenantContext は
// 経由しない = insert 捕捉の assertion 不変)。 実 tenant context 挙動は Task 9 実 PG で担保。
vi.mock('@/lib/db/tenant-tx', () => ({
  withTenantTx: (db: unknown, _userId: string, fn: (tx: unknown) => unknown) =>
    fn(db),
}))

async function importAction() {
  return await import('./create-exam')
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  dbState.insertTable = null
  dbState.insertValues = null
  dbState.returningRows = [{ id: 'exam-new-1' }]
  dbState.throwOnReturning = false
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-1',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
})

describe('createExam', () => {
  it('auth fail → { ok: false, error: 認証が必要です }, no INSERT', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { createExam } = await importAction()
    const r = await createExam('有効な試験名')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(dbState.insertTable).toBeNull()
  })

  it('空白のみ名前 → { ok: false, error: 試験名は必須です }, no INSERT', async () => {
    const { createExam } = await importAction()
    const r = await createExam('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('試験名は必須です')
    expect(dbState.insertTable).toBeNull()
  })

  it('空文字 → { ok: false, error: 試験名は必須です }, no INSERT', async () => {
    const { createExam } = await importAction()
    const r = await createExam('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('試験名は必須です')
    expect(dbState.insertTable).toBeNull()
  })

  it('201 文字 → { ok: false, error: 試験名は 200 文字以内で入力してください }', async () => {
    const { createExam } = await importAction()
    const r = await createExam('a'.repeat(201))
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toBe('試験名は 200 文字以内で入力してください')
    expect(dbState.insertTable).toBeNull()
  })

  it('有効な名前 → exams に INSERT + { ok: true, data: { examId } }', async () => {
    const { createExam } = await importAction()
    const { getTableName } = await import('drizzle-orm')
    const r = await createExam('基本情報試験')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual({ examId: 'exam-new-1' })
    }
    expect(getTableName(dbState.insertTable as never)).toBe('exams')
  })

  it('trim 適用: 前後スペース付き名前でも INSERT される (trimmed 値)', async () => {
    const { createExam } = await importAction()
    const r = await createExam('  基本情報試験  ')
    expect(r.ok).toBe(true)
    expect(dbState.insertValues?.name).toBe('基本情報試験')
  })

  it('ちょうど 200 文字は valid (境界値)', async () => {
    const { createExam } = await importAction()
    const r = await createExam('a'.repeat(200))
    expect(r.ok).toBe(true)
  })

  it('owner-scope: INSERT の userId は常に認証 user.id (client 入力非依存)', async () => {
    const { createExam } = await importAction()
    await createExam('試験名')
    expect(dbState.insertValues?.userId).toBe('user-1')
  })

  it('success 時に revalidatePath("/app/upload") を呼ぶ (finally)', async () => {
    const { createExam } = await importAction()
    await createExam('試験名')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
  })

  it('zod error 時も revalidatePath("/app/upload") を呼ぶ (finally)', async () => {
    const { createExam } = await importAction()
    await createExam('')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
  })

  it('auth error 時も revalidatePath("/app/upload") を呼ぶ (finally)', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { createExam } = await importAction()
    await createExam('試験名')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
  })
})
