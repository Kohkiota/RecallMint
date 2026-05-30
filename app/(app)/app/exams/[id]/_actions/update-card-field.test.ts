import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

// updateCardField server action の test (`/app/exams/[id]` inline 編集用)。
// field 単位の更新と、 options の correct_answer_ids 自動再生成 / owner-scoped /
// zod 検証 / DB throw → ActionResult 変換を検証する。 旧 /app/cards/[id] page
// 廃止 (cache-fix roadmap ④-3) に伴い revalidatePath は呼ばなくなったため、
// success path の revalidate verify case は撤去済。

const { mockGetCurrentUser, mockRevalidatePath, mockLoggerError, dbState } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockRevalidatePath: vi.fn(),
    mockLoggerError: vi.fn(),
    dbState: {
      updateTable: null as unknown,
      setArg: null as Record<string, unknown> | null,
      whereArgs: [] as unknown[][],
      returningRows: [] as Record<string, unknown>[],
      throwOnReturning: false,
    },
  }))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
  }
})

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  },
}))

vi.mock('@/lib/db', () => {
  function updateChain() {
    const obj: Record<string, unknown> = {}
    obj.set = (arg: Record<string, unknown>) => {
      dbState.setArg = arg
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
    getDb: () => ({
      update: (table: unknown) => {
        dbState.updateTable = table
        return updateChain()
      },
    }),
  }
})

async function importAction() {
  return await import('./update-card-field')
}

beforeEach(() => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  mockLoggerError.mockReset()
  dbState.updateTable = null
  dbState.setArg = null
  dbState.whereArgs = []
  dbState.returningRows = [{ examId: 'exam-1' }]
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

describe('updateCardField', () => {
  it('auth fail → { ok: false, error: 認証が必要です }, no UPDATE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'title', '問1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(dbState.updateTable).toBeNull()
  })

  it('title: 正常更新 (trim 適用、 1 列だけ set)', async () => {
    const { updateCardField } = await importAction()
    const { getTableName } = await import('drizzle-orm')
    const r = await updateCardField('card-1', 'title', '  問1  ')
    expect(r.ok).toBe(true)
    expect(getTableName(dbState.updateTable as never)).toBe('cards')
    expect(dbState.setArg).toEqual(expect.objectContaining({ title: '問1' }))
  })

  it('title: 空文字で zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'title', '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('タイトルは必須です')
    expect(dbState.updateTable).toBeNull()
  })

  it('title: 201 文字で zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'title', 'a'.repeat(201))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('タイトルは 200 文字以内で入力してください')
    expect(dbState.updateTable).toBeNull()
  })

  it('sort_key: 正常文字列', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'sort_key', 'Q-01')
    expect(r.ok).toBe(true)
    expect(dbState.setArg).toEqual(expect.objectContaining({ sortKey: 'Q-01' }))
  })

  it('sort_key: null OK', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'sort_key', null)
    expect(r.ok).toBe(true)
    expect(dbState.setArg).toEqual(expect.objectContaining({ sortKey: null }))
  })

  it('sort_key: 空文字は null に正規化', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'sort_key', '')
    expect(r.ok).toBe(true)
    expect(dbState.setArg).toEqual(expect.objectContaining({ sortKey: null }))
  })

  it('sort_key: 101 文字で zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'sort_key', 'a'.repeat(101))
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toBe('ソートキーは 100 文字以内で入力してください')
    expect(dbState.updateTable).toBeNull()
  })

  it('question_text: 正常更新', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'question_text', '問題本文')
    expect(r.ok).toBe(true)
    expect(dbState.setArg).toEqual(expect.objectContaining({ questionText: '問題本文' }))
  })

  it('question_text: 空白のみで zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'question_text', '   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('問題文は必須です')
    expect(dbState.updateTable).toBeNull()
  })

  it('explanation_text: 正常 / null / 空文字は null', async () => {
    const { updateCardField } = await importAction()

    await updateCardField('card-1', 'explanation_text', 'これは解説')
    expect(dbState.setArg).toEqual(expect.objectContaining({ explanationText: 'これは解説' }))

    dbState.setArg = null
    await updateCardField('card-1', 'explanation_text', null)
    expect(dbState.setArg).toEqual(expect.objectContaining({ explanationText: null }))

    dbState.setArg = null
    await updateCardField('card-1', 'explanation_text', '')
    expect(dbState.setArg).toEqual(expect.objectContaining({ explanationText: null }))
  })

  it('memo: 正常 / null / 空文字は null', async () => {
    const { updateCardField } = await importAction()

    await updateCardField('card-1', 'memo', '個人メモ')
    expect(dbState.setArg).toEqual(expect.objectContaining({ memo: '個人メモ' }))

    dbState.setArg = null
    await updateCardField('card-1', 'memo', null)
    expect(dbState.setArg).toEqual(expect.objectContaining({ memo: null }))

    dbState.setArg = null
    await updateCardField('card-1', 'memo', '')
    expect(dbState.setArg).toEqual(expect.objectContaining({ memo: null }))
  })

  it('memo: 10001 文字で zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'memo', 'a'.repeat(10001))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('メモは 10000 文字以内で入力してください')
    expect(dbState.updateTable).toBeNull()
  })

  it('options: 正常 → snake_case 変換 + correct_answer_ids 再生成 (2 列同時 set)', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'options', [
      { id: 'a', text: 'A', isCorrect: true, explanation: '理由' },
      { id: 'b', text: 'B', isCorrect: false },
    ])
    expect(r.ok).toBe(true)
    expect(dbState.setArg).toEqual(expect.objectContaining({
      options: [
        { id: 'a', text: 'A', is_correct: true, explanation: '理由' },
        { id: 'b', text: 'B', is_correct: false },
      ],
      correctAnswerIds: ['a'],
    }))
  })

  it('options: 0 件で zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'options', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('選択肢は最低 1 個必要です')
    expect(dbState.updateTable).toBeNull()
  })

  it('options: id 重複で zod error', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'options', [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'a', text: 'B', isCorrect: false },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('選択肢の id が重複しています')
    expect(dbState.updateTable).toBeNull()
  })

  it('owner-scoped: WHERE includes eq(cards.id) and eq(cards.userId)', async () => {
    const { updateCardField } = await importAction()
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await updateCardField('card-1', 'title', '問1')
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([cards.id, 'card-1'])
    expect(calls).toContainEqual([cards.userId, 'user-1'])
  })

  it('0 rows updated (他 user / 不在) → { ok: false }, no revalidate', async () => {
    dbState.returningRows = []
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'title', '問1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('カードが見つかりません')
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('DB throw → { ok: false, error: 保存に失敗しました... }, logger.error 呼び出し', async () => {
    dbState.throwOnReturning = true
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'title', '問1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/保存に失敗しました/)
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('unknown field → { ok: false } で error 返却 (defensive)', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField(
      'card-1',
      'no_such_field' as unknown as 'title',
      'x',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/フィールド/)
    expect(dbState.updateTable).toBeNull()
  })

  it('updated_at に now() SQL 式が渡される (DB クロック統一)', async () => {
    const { updateCardField } = await importAction()
    const r = await updateCardField('card-1', 'title', '問1')
    expect(r.ok).toBe(true)
    const updatedAt = dbState.setArg?.updatedAt
    expect(updatedAt).toBeInstanceOf(SQL)
    const rendered = new PgDialect().sqlToQuery(updatedAt as SQL).sql
    expect(rendered).toContain('now()')
  })
})
