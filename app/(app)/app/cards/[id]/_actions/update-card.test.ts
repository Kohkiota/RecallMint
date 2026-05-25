import { describe, it, expect, vi, beforeEach } from 'vitest'

// updateCard server action の test。 実 DB は叩かず getDb を mock。
// correct_answer_ids が options[].is_correct から再生成されること、
// owner-scoped (WHERE cards.userId) であること、 0 行 update の扱いを検証する。

const { mockGetCurrentUser, mockRevalidatePath, dbState } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
  dbState: {
    updateTable: null as unknown,
    setArg: null as Record<string, unknown> | null,
    whereArgs: [] as unknown[][],
    returningRows: [] as Record<string, unknown>[],
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
    obj.returning = () => Promise.resolve(dbState.returningRows)
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

const validInput = {
  title: '問1',
  questionText: '問題文',
  options: [
    { id: 'a', text: 'A', isCorrect: true },
    { id: 'b', text: 'B', isCorrect: false },
    { id: 'c', text: 'C', isCorrect: true },
  ],
  explanationText: '解説',
}

async function importUpdateCard() {
  return await import('./update-card')
}

beforeEach(async () => {
  mockGetCurrentUser.mockReset()
  mockRevalidatePath.mockReset()
  dbState.updateTable = null
  dbState.setArg = null
  dbState.whereArgs = []
  dbState.returningRows = [{ examId: 'exam-1' }]
  const { eq } = await import('drizzle-orm')
  vi.mocked(eq).mockClear()
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

describe('updateCard', () => {
  it('auth fail → { ok: false }, no UPDATE', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { updateCard } = await importUpdateCard()
    const r = await updateCard('card-1', validInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(dbState.updateTable).toBeNull()
  })

  it('invalid input (title empty) → { ok: false } with zod message, no UPDATE', async () => {
    const { updateCard } = await importUpdateCard()
    const r = await updateCard('card-1', { ...validInput, title: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('タイトルは必須です')
    expect(dbState.updateTable).toBeNull()
  })

  it('valid input → UPDATE cards, regenerates correct_answer_ids from is_correct', async () => {
    const { updateCard } = await importUpdateCard()
    const { getTableName } = await import('drizzle-orm')
    const r = await updateCard('card-1', validInput)
    expect(r.ok).toBe(true)
    expect(getTableName(dbState.updateTable as never)).toBe('cards')
    const set = dbState.setArg!
    expect(set.title).toBe('問1')
    expect(set.questionText).toBe('問題文')
    // correct_answer_ids は入力で受け取らず is_correct から再生成
    expect(set.correctAnswerIds).toEqual(['a', 'c'])
    // options は DB の snake_case (is_correct) 形で格納
    expect(set.options).toEqual([
      { id: 'a', text: 'A', is_correct: true },
      { id: 'b', text: 'B', is_correct: false },
      { id: 'c', text: 'C', is_correct: true },
    ])
  })

  it('owner-scoped: WHERE includes eq(cards.id) and eq(cards.userId)', async () => {
    const { updateCard } = await importUpdateCard()
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await updateCard('card-1', validInput)
    const calls = vi.mocked(eq).mock.calls
    expect(calls).toContainEqual([cards.id, 'card-1'])
    expect(calls).toContainEqual([cards.userId, 'user-1'])
  })

  it('0 rows updated (not found / other user) → { ok: false }, no revalidate', async () => {
    dbState.returningRows = []
    const { updateCard } = await importUpdateCard()
    const r = await updateCard('card-1', validInput)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('カードが見つかりません')
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })

  it('success → revalidates exam page only (S-cache-2a: card editor は /app/cards/[id] 上で同 path、 redundant)', async () => {
    // S-cache-2a: card editor は保存成功時 `router.push('/app/exams/[id]')` で
    // 遷移するため /app/cards/[id] は unmount 経路、 同 path への revalidatePath は
    // no-op。 /app/exams/[examId] は router.push 遷移先 (cross-page) のため残置。
    const { updateCard } = await importUpdateCard()
    await updateCard('card-1', validInput)
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/app/cards/card-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams/exam-1')
    // scope creep 検出 (review minor #4)
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1)
  })

  it('option explanation: kept when set, omitted when absent', async () => {
    const { updateCard } = await importUpdateCard()
    await updateCard('card-1', {
      ...validInput,
      options: [
        { id: 'a', text: 'A', isCorrect: true, explanation: '理由' },
        { id: 'b', text: 'B', isCorrect: false },
      ],
    })
    const opts = dbState.setArg!.options as Record<string, unknown>[]
    expect(opts[0]).toEqual({
      id: 'a',
      text: 'A',
      is_correct: true,
      explanation: '理由',
    })
    expect('explanation' in opts[1]).toBe(false)
  })

  it('empty explanationText is normalized to null', async () => {
    const { updateCard } = await importUpdateCard()
    await updateCard('card-1', { ...validInput, explanationText: '' })
    expect(dbState.setArg!.explanationText).toBeNull()
  })
})
