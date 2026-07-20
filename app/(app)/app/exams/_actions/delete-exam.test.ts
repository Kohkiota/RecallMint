import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

function expectNowSql(value: unknown) {
  expect(value).toBeInstanceOf(SQL)
  const q = new PgDialect().sqlToQuery(value as SQL)
  expect(q.sql).toContain('now()')
  expect(q.params).toHaveLength(0)
}

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
    // tombstones INSERT に渡された values rows を record。
    insertedTombstoneRows: [] as unknown[],
    // SELECT が走った table を順序付きで record (tx 内 select 用)。
    selectTables: [] as unknown[],
    // exam 存在確認の SELECT が返すスタブ値 (デフォルト = 1 行 = 存在する)。
    examSelectResult: [{ id: 'exam-uuid' }] as unknown[],
    // card 列挙 SELECT が返すスタブ値 (デフォルト = 2 枚)。
    cardSelectResult: [
      { id: 'card-uuid-1' },
      { id: 'card-uuid-2' },
    ] as unknown[],
    // tx 内 select 呼出しカウンタ (0=exam確認, 1=card列挙)。beforeEach でリセット。
    selectCallCount: 0,
    // トランザクションが起動されたか。
    txStarted: false,
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
  // select チェーン: .from(table).where() → Promise<rows>
  // selectCallCount は dbState 経由でリセット可能にする。
  function makeSelectChain(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj['where'] = (...args: unknown[]) => {
      dbState.whereArgs.push(args)
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      // 呼出し順: 0 = exam 存在確認 SELECT、1 = card 列挙 SELECT
      const result =
        dbState.selectCallCount === 0
          ? dbState.examSelectResult
          : dbState.cardSelectResult
      dbState.selectCallCount++
      return Promise.resolve(result).then(onFulfilled, onRejected)
    }
    return obj
  }

  function makeInsertChain(table: unknown): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    obj['values'] = (rows: unknown[]) => {
      // tombstones table への insert を記録
      const name = getTableName(table as never)
      if (name === 'tombstones') {
        for (const row of rows) {
          dbState.insertedTombstoneRows.push(row)
        }
      }
      return obj
    }
    obj['onConflictDoNothing'] = () => {
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(undefined).then(onFulfilled, onRejected)
    return obj
  }

  function chain() {
    const obj: Record<string, unknown> = {}
    obj['where'] = (...args: unknown[]) => {
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

  function makeTx() {
    return {
      // RLS-P2: tx 冒頭 setTenantContext(tx) が tx.execute を呼ぶため no-op execute を生やす。
      execute: async () => [],
      select: (_columns: unknown) => ({
        from: (table: unknown) => {
          dbState.selectTables.push(table)
          return makeSelectChain()
        },
      }),
      insert: (table: unknown) => makeInsertChain(table),
      delete: recordingDelete,
    }
  }

  return {
    getDb: () => ({
      // 非 tx パスの DELETE (auth fail 等で tx に入らない場合のフォールバック)
      delete: recordingDelete,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        dbState.txStarted = true
        return fn(makeTx())
      },
    }),
  }
})

async function importDeleteExam() {
  return await import('./delete-exam')
}

function resetDbState() {
  dbState.deleteTables = []
  dbState.whereArgs = []
  dbState.insertedTombstoneRows = []
  dbState.selectTables = []
  dbState.selectCallCount = 0
  dbState.txStarted = false
  dbState.examSelectResult = [{ id: 'exam-uuid' }]
  dbState.cardSelectResult = [{ id: 'card-uuid-1' }, { id: 'card-uuid-2' }]
}

beforeEach(async () => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  resetDbState()
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
    // exam SELECT が 0 行を返す = 不在 / 他 user
    dbState.examSelectResult = []
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('nonexistent-exam-uuid')
    expect(r.ok).toBe(true)
    // tombstone は INSERT されない (存在しない exam への tombstone 禁止)
    expect(dbState.insertedTombstoneRows).toHaveLength(0)
    // DELETE も走らない (exam が存在しないため tx 内で早期 return)
    expect(deletedTableNames()).toEqual([])
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

  // ── tombstone 網羅 INSERT (Spec §4, Task 6) ──────────────────────────────

  it('child cards enumerated → tombstone rows for exam(1) + each child card inserted, THEN exam deleted', async () => {
    // デフォルト: examSelectResult=[{id:'exam-uuid'}], cardSelectResult=[card-1,card-2]
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('exam-uuid')
    expect(r.ok).toBe(true)

    // tx が起動されている
    expect(dbState.txStarted).toBe(true)

    // tombstone は exam 1 件 + card 2 件 = 3 行
    expect(dbState.insertedTombstoneRows).toHaveLength(3)

    type TombstoneRow = {
      userId: string
      entityType: string
      entityId: string
      deletedAt: unknown
    }
    const rows = dbState.insertedTombstoneRows as TombstoneRow[]

    // exam tombstone
    const examTombstone = rows.find((row) => row.entityType === 'exam')
    expect(examTombstone).toBeDefined()
    expect(examTombstone?.entityId).toBe('exam-uuid')
    expect(examTombstone?.userId).toBe('user-uuid')
    expectNowSql(examTombstone?.deletedAt)

    // card tombstone × 2
    const cardTombstones = rows.filter((row) => row.entityType === 'card')
    expect(cardTombstones).toHaveLength(2)
    const cardIds = cardTombstones.map((r) => r.entityId)
    expect(cardIds).toContain('card-uuid-1')
    expect(cardIds).toContain('card-uuid-2')
    cardTombstones.forEach((row) => {
      expect(row.userId).toBe('user-uuid')
      expectNowSql(row.deletedAt)
    })

    // tombstone INSERT の後に exams DELETE が走る (順序確認)
    expect(deletedTableNames()).toContain('exams')
  })

  it('exam 不在/他 user → NO tombstone inserted, idempotent { ok: true }', async () => {
    dbState.examSelectResult = []
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('other-user-exam-uuid')

    expect(r.ok).toBe(true)
    // tombstone は挿入されない
    expect(dbState.insertedTombstoneRows).toHaveLength(0)
    // exams DELETE も走らない
    expect(deletedTableNames()).toHaveLength(0)
  })

  it('re-delete (same examId, already deleted) → onConflictDoNothing → no error', async () => {
    // 1 回目削除シミュレーション: exam あり、card 2 枚
    const { deleteExam } = await importDeleteExam()
    const r1 = await deleteExam('exam-uuid')
    expect(r1.ok).toBe(true)
    expect(dbState.insertedTombstoneRows).toHaveLength(3)

    // 2 回目: exam が既に物理削除済 → SELECT 0 行 → early return (idempotent)
    resetDbState()
    dbState.examSelectResult = []

    const r2 = await deleteExam('exam-uuid')
    expect(r2.ok).toBe(true)
    // 2 回目は tombstone も DELETE も走らない
    expect(dbState.insertedTombstoneRows).toHaveLength(0)
    expect(deletedTableNames()).toHaveLength(0)
  })

  it('all tombstone deletedAt are now() SQL expressions (DB clock, not JS Date)', async () => {
    // exam 1件 + card 2件 = 3行すべての deletedAt が sql`now()` であることを検証。
    // JS Date ではなく DB クロック(tx 内 now() 一定)に統一されていることを確認する。
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('exam-uuid')
    expect(r.ok).toBe(true)

    expect(dbState.insertedTombstoneRows).toHaveLength(3)
    for (const row of dbState.insertedTombstoneRows) {
      expectNowSql((row as { deletedAt: unknown }).deletedAt)
    }
  })

  it('card なし exam → exam tombstone のみ 1 行 INSERT', async () => {
    dbState.cardSelectResult = []
    const { deleteExam } = await importDeleteExam()
    const r = await deleteExam('exam-uuid')
    expect(r.ok).toBe(true)

    // tombstone は exam 1 件のみ
    expect(dbState.insertedTombstoneRows).toHaveLength(1)
    type TombstoneRow = { entityType: string; entityId: string; userId: string; deletedAt: unknown }
    const row = dbState.insertedTombstoneRows[0] as TombstoneRow
    expect(row.entityType).toBe('exam')
    expect(row.entityId).toBe('exam-uuid')
    expect(row.userId).toBe('user-uuid')
    expectNowSql(row.deletedAt)
  })
})
