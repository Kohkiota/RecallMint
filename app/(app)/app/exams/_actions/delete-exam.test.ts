import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const {
  mockGetCurrentUser,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    // DELETE が走った table を順序付きで record。
    deleteTables: [] as unknown[],
    // .where() に渡された引数を record。
    whereArgs: [] as unknown[][],
  },
}))

// drizzle-orm の eq をスパイ化: 実装は real のまま呼び出し引数だけ記録する。
// これにより WHERE clause に eq(exams.userId, user.id) が含まれているかを
// アサートでき、そのガード predicate を削除するリグレッションを検出できる。
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  const spyEq = vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args))
  return {
    ...real,
    eq: spyEq,
  }
})

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/db', () => {
  function chain(_returnValue?: unknown) {
    const obj: Record<string, unknown> = {}
    obj['where'] = (...args: unknown[]) => {
      // .where() の引数を record しておく (テナント分離ガード検証用)
      dbState.whereArgs.push(args)
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(undefined).then(onFulfilled, onRejected)
    return obj
  }
  function recordingDelete(table: unknown) {
    dbState.deleteTables.push(table)
    return chain()
  }
  return {
    getDb: () => ({
      delete: recordingDelete,
    }),
  }
})

async function importDeleteExam() {
  return await import('./delete-exam')
}

beforeEach(async () => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  dbState.deleteTables = []
  dbState.whereArgs = []
  // eq スパイのコール履歴をリセット
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

function deletedTableNames(): string[] {
  return dbState.deleteTables.map((t) => getTableName(t as never))
}

describe('deleteExam', () => {
  it('auth fail → { ok: false }, no DELETE, revalidatePath still called', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('exam-uuid')
    expect(r.ok).toBe(false)
    // S-cache-2a: revalidatePath('/app/exams') は撤去 (server action 後の Next.js
    // 自動 revalidate + router.refresh() 同居で redundant)。
    // /app/upload (active exam dropdown 用 cross-page revalidate) のみ finally で呼ばれる。
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/app/exams')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
    expect(dbState.deleteTables).toHaveLength(0)
  })

  it('authenticated → owner-scoped DELETE on exams, returns { ok: true }', async () => {
    const { deleteExam } = await importDeleteExam()
    const { eq } = await import('drizzle-orm')
    const { exams } = await import('@/lib/db/schema')
    const r = await deleteExam('exam-uuid')
    expect(r.ok).toBe(true)
    // exams テーブルに対して DELETE が 1 回のみ走る
    expect(deletedTableNames()).toEqual(['exams'])

    // テナント分離ガード: eq() が exams.id 比較と exams.userId 比較の
    // 両方で呼ばれていることを検証する。
    // eq(exams.userId, user.id) が WHERE から削除されたリグレッションを検出する。
    const eqMock = vi.mocked(eq)
    const calls = eqMock.mock.calls
    // eq(exams.id, examId) が含まれる
    expect(calls).toContainEqual([exams.id, 'exam-uuid'])
    // eq(exams.userId, user.id) が含まれる — tenant-isolation guard
    expect(calls).toContainEqual([exams.userId, 'user-uuid'])
  })

  it('not-found / other-user examId → silent ok (idempotent, double-click safe)', async () => {
    // DB の DELETE は行が存在しなくても例外を投げない (WHERE が 0 行にマッチするだけ)
    // → { ok: true } で返すべき
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('nonexistent-exam-uuid')
    expect(r.ok).toBe(true)
    // DELETE が走る (0 行マッチでも DB 側の話、アプリは成功扱い)
    expect(deletedTableNames()).toEqual(['exams'])
  })

  it('revalidatePath is called for /app/upload only (S-cache-2a)', async () => {
    // S-cache-2a: '/app/exams' は delete-exam-button.tsx の `router.refresh()` で
    // 単独に同 path を更新するため、 server action 側の revalidatePath は redundant。
    // '/app/upload' は upload page の active exam dropdown を更新する cross-page
    // revalidate のため残置。
    const { deleteExam } = await importDeleteExam()
    await deleteExam('exam-uuid')
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/app/exams')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/upload')
    // scope creep 検出 (review minor #4)
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1)
  })

  it('does NOT touch cards or source_documents directly (CASCADE handles them)', async () => {
    const { deleteExam } = await importDeleteExam()
    await deleteExam('exam-uuid')
    expect(deletedTableNames()).not.toContain('cards')
    expect(deletedTableNames()).not.toContain('source_documents')
  })
})
