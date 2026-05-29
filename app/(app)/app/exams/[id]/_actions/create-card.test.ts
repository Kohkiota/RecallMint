import { describe, it, expect, vi, beforeEach } from 'vitest'

// createCard server action の test (`/app/exams/[id]` 末尾「+ カードを追加」用)。
// placeholder card を owner-scoped で INSERT し、 同一 tx で exams.card_count += 1。
// spec §3.6 integrity: insert 後の card_count が実 card 件数と一致することを検証。
//
// DB は in-memory store として mock し、 tx 内の select(exam owner 確認 / 既存 card
// 取得) / insert(cards) / update(exams.cardCount) を実体験に近い形で再現する。
// transaction が throw(rollback) した場合は store を変更しない (atomic 性の擬似)。

import { getTableName } from 'drizzle-orm'
import { exams } from '@/lib/db/schema'

const { mockGetCurrentUser, mockLoggerError, mockRevalidatePath, store, ctl } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockLoggerError: vi.fn(),
  mockRevalidatePath: vi.fn(),
  store: {
    // exam 行: { id, userId, cardCount }
    exams: [] as { id: string; userId: string; cardCount: number }[],
    // card 行: { id, examId, userId, ...placeholder }
    cards: [] as Record<string, unknown>[],
  },
  ctl: {
    insertedValues: null as Record<string, unknown> | null,
    nextCardId: 'card-new-1',
    throwInTx: false,
  },
}))

vi.mock('@/lib/auth/ensure-user', () => ({
  getCurrentUser: mockGetCurrentUser,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  },
}))

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}))

// tx は drizzle 風の chain を返す。 where に渡る condition から examId / userId は
// 評価できないため、 action が「同一 examId/userId scope」 で呼ぶ前提で store 全体に
// 対し scope 判定を action 経由パラメータで行うのではなく、 select/update の対象を
// 単純に「store 内 examId+userId 一致行」とする実装にする。 そのため tx helper には
// 呼出時の examId/userId を渡せないので、 condition を解釈する代わりに store を直接
// 参照する設計とし、 scope は action が常に userId=authed・examId=arg で WHERE を
// 組むことを別途 owner-scope test (eq spy) で担保する。
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
  }
})

vi.mock('@/lib/db', () => {
  // tx 内で使う select/insert/update の chain。 capturedScope に examId/userId を
  // 保持し (eq spy 経由ではなく) action が WHERE に渡した値を読み取る代わりに、
  // ここでは store を直接対象とする。 simplify のため scope は store 全行 (test では
  // 1 exam しか入れない or 不在 test) を対象に動く。
  function makeTx() {
    const tx: Record<string, unknown> = {}

    tx.select = (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never)
          if (name === getTableName(exams)) {
            // exam owner 確認: store.exams をそのまま返す (test は scope 一致のみ投入)
            return Promise.resolve(
              store.exams.map((e) => ({ id: e.id, userId: e.userId })),
            )
          }
          // cards: sortKey のみ select
          void cols
          return Promise.resolve(
            store.cards.map((c) => ({ sortKey: c.sortKey })),
          )
        },
      }),
    })

    tx.insert = () => ({
      values: (vals: Record<string, unknown>) => {
        ctl.insertedValues = vals
        return {
          returning: () => {
            const id = ctl.nextCardId
            store.cards.push({ id, ...vals })
            return Promise.resolve([{ id }])
          },
        }
      },
    })

    tx.update = () => ({
      set: () => ({
        where: () => {
          // cardCount += 1 (store.exams 全行に対し)
          for (const e of store.exams) e.cardCount += 1
          return Promise.resolve(undefined)
        },
      }),
    })

    return tx
  }

  return {
    getDb: () => ({
      transaction: async (
        fn: (tx: Record<string, unknown>) => Promise<unknown>,
      ) => {
        // rollback 擬似: tx 失敗時は store を snapshot から復元
        const snapshot = {
          exams: store.exams.map((e) => ({ ...e })),
          cards: store.cards.map((c) => ({ ...c })),
        }
        try {
          const r = await fn(makeTx())
          if (ctl.throwInTx) throw new Error('forced tx boom')
          return r
        } catch (err) {
          store.exams = snapshot.exams
          store.cards = snapshot.cards
          throw err
        }
      },
    }),
  }
})

async function importAction() {
  return await import('./create-card')
}

beforeEach(() => {
  vi.clearAllMocks()
  store.exams = [{ id: 'exam-1', userId: 'user-1', cardCount: 0 }]
  store.cards = []
  ctl.insertedValues = null
  ctl.nextCardId = 'card-new-1'
  ctl.throwInTx = false
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-1',
    clerkId: 'clerk-1',
    email: 't@example.com',
    plan: 'free',
    billingInterval: null,
    deletedAt: null,
    stripeCustomerId: null,
  })
  mockRevalidatePath.mockReset()
})

describe('createCard', () => {
  it('auth fail → { ok: false, error: 認証が必要です }, no card insert', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { createCard } = await importAction()
    const r = await createCard('exam-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(store.cards.length).toBe(0)
    expect(ctl.insertedValues).toBeNull()
  })

  it('placeholder card を INSERT + { ok: true, data: { cardId } }', async () => {
    const { createCard } = await importAction()
    const r = await createCard('exam-1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ cardId: 'card-new-1' })
    expect(store.cards.length).toBe(1)
  })

  it('INSERT 値は edit zod を満たす placeholder (title/questionText 非空、 option 1 件、 correctAnswerIds=[])', async () => {
    const { createCard } = await importAction()
    await createCard('exam-1')
    const v = ctl.insertedValues!
    expect(typeof v.title).toBe('string')
    expect((v.title as string).length).toBeGreaterThan(0)
    expect((v.questionText as string).trim().length).toBeGreaterThan(0)
    expect(Array.isArray(v.options)).toBe(true)
    expect((v.options as unknown[]).length).toBeGreaterThanOrEqual(1)
    const opt0 = (v.options as { text: string }[])[0]
    expect(opt0.text.length).toBeGreaterThan(0)
    expect(v.correctAnswerIds).toEqual([])
  })

  it('owner-scope: insert の userId/examId は authed user + arg、 sourceDocumentId は null', async () => {
    const { createCard } = await importAction()
    await createCard('exam-1')
    const v = ctl.insertedValues!
    expect(v.userId).toBe('user-1')
    expect(v.examId).toBe('exam-1')
    expect(v.sourceDocumentId).toBeNull()
  })

  it('sortKey は末尾連番 (既存 ["1","2"] → 新規 "3")', async () => {
    store.cards = [
      { id: 'c1', examId: 'exam-1', userId: 'user-1', sortKey: '1' },
      { id: 'c2', examId: 'exam-1', userId: 'user-1', sortKey: '2' },
    ]
    store.exams[0]!.cardCount = 2
    const { createCard } = await importAction()
    await createCard('exam-1')
    expect(ctl.insertedValues!.sortKey).toBe('3')
  })

  it('同一 tx で card_count += 1 され、 insert 後 card_count === 実 card 件数 (spec §3.6 integrity)', async () => {
    const { createCard } = await importAction()
    const r = await createCard('exam-1')
    expect(r.ok).toBe(true)
    const exam = store.exams.find((e) => e.id === 'exam-1')!
    const actualCount = store.cards.filter((c) => c.examId === 'exam-1').length
    expect(exam.cardCount).toBe(1)
    expect(exam.cardCount).toBe(actualCount)
  })

  it('exam 不在 → { ok: false, error: 試験が見つかりません }, no insert, no cardCount change', async () => {
    store.exams = [] // owner 確認 0 rows
    const { createCard } = await importAction()
    const r = await createCard('exam-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('試験が見つかりません')
    expect(store.cards.length).toBe(0)
  })

  it('他 user の exam → { ok: false }, no insert (owner 確認 0 rows 扱い)', async () => {
    // owner 確認 select が 0 rows を返す状況を、 store.exams を空にして再現
    store.exams = []
    const { createCard } = await importAction()
    const r = await createCard('exam-1')
    expect(r.ok).toBe(false)
    expect(store.cards.length).toBe(0)
  })

  it('owner-scope: insert/select/update の WHERE に eq(_, examId) と eq(_, user.id) が含まれる', async () => {
    const { createCard } = await importAction()
    const { eq } = await import('drizzle-orm')
    await createCard('exam-1')
    const calls = vi.mocked(eq).mock.calls
    // column 同一性は table 名 + column 名で判定する。 schema module が action 側と
    // test 側で別 graph に load される場合、 column object は参照不一致になる
    // (deep 比較も Drizzle column の table 循環参照で不成立) ため、 観測可能な
    // table 名 / column 名 / 値で WHERE scope を担保する。
    const signature = calls.map((c) => {
      const col = c[0] as { name?: string; table?: unknown }
      const tableName = col.table ? getTableName(col.table as never) : ''
      return [tableName, col.name, c[1]]
    })
    expect(signature).toContainEqual(['exams', 'id', 'exam-1'])
    expect(signature).toContainEqual(['exams', 'user_id', 'user-1'])
    expect(signature).toContainEqual(['cards', 'exam_id', 'exam-1'])
    expect(signature).toContainEqual(['cards', 'user_id', 'user-1'])
  })

  it('tx 内 DB throw → { ok: false }, logger.error 呼出, rollback で card_count 不変', async () => {
    ctl.throwInTx = true
    const { createCard } = await importAction()
    const r = await createCard('exam-1')
    expect(r.ok).toBe(false)
    expect(mockLoggerError).toHaveBeenCalled()
    // rollback: cards 0 件、 cardCount 0
    expect(store.cards.length).toBe(0)
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('success 時に revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    const { createCard } = await importAction()
    await createCard('exam-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('auth error 時も revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { createCard } = await importAction()
    await createCard('exam-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('exam 不在 エラー 時も revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    store.exams = []
    const { createCard } = await importAction()
    await createCard('exam-x')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('tx throw 時も revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    ctl.throwInTx = true
    const { createCard } = await importAction()
    await createCard('exam-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })
})
