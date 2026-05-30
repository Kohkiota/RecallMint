import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

// deleteCard server action の test (spec §3.4)。
// tombstone(card) INSERT + card DELETE + cardCount -= 1 を同一 tx で実行。
// card 不在 → idempotent success + NO tombstone + NO cardCount change。
// re-delete → onConflictDoNothing (no dup tombstone)。
// spec §3.6 integrity: 削除後 cardCount === COUNT(cards WHERE exam_id)。
// 最後の 1 枚も削除可 (0 card exam が残る)。

import { getTableName } from 'drizzle-orm'
import { cards } from '@/lib/db/schema'

const { mockGetCurrentUser, mockLoggerError, mockRevalidatePath, store, ctl, captured } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockLoggerError: vi.fn(),
    mockRevalidatePath: vi.fn(),
    store: {
      exams: [] as { id: string; userId: string; cardCount: number }[],
      cards: [] as { id: string; examId: string; userId: string }[],
      tombstones: [] as {
        userId: string
        entityType: string
        entityId: string
      }[],
    },
    ctl: {
      // tombstone onConflictDoNothing シミュレート: true なら tombstone INSERT をスキップ
      tombstoneAlreadyExists: false,
      throwInTx: false,
    },
    captured: {
      // tombstone INSERT の .values() に渡された raw object を保持 (deletedAt 検証用)
      tombstoneValues: null as Record<string, unknown> | null,
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

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
    sql: vi.fn((...args: Parameters<typeof real.sql>) => real.sql(...args)),
  }
})

// DB mock: transaction + 4 ops (select cards / insert tombstone / delete cards / update exams)
vi.mock('@/lib/db', () => {
  function makeTx() {
    const tx: Record<string, unknown> = {}

    // select: cards.examId を返す (card 存在確認用)
    tx.select = (_cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = getTableName(table as never)
          if (name === getTableName(cards)) {
            // store.cards をそのまま返す (test は scope 一致のみ投入)
            return Promise.resolve(
              store.cards.map((c) => ({ examId: c.examId })),
            )
          }
          return Promise.resolve([])
        },
      }),
    })

    // insert: tombstones
    tx.insert = (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          // onConflictDoNothing シミュレート
          captured.tombstoneValues = vals
          if (!ctl.tombstoneAlreadyExists) {
            store.tombstones.push({
              userId: vals.userId as string,
              entityType: vals.entityType as string,
              entityId: vals.entityId as string,
            })
          }
          return Promise.resolve(undefined)
        },
      }),
    })

    // delete: cards
    tx.delete = (table: unknown) => ({
      where: () => {
        const name = getTableName(table as never)
        if (name === getTableName(cards)) {
          // 削除 (store.cards から対象を消す — scope はテスト側で 1 件のみ入れる)
          const before = store.cards.length
          store.cards = [] // owner-scoped delete (test は 1 card only)
          void before
        }
        return Promise.resolve(undefined)
      },
    })

    // update: exams.cardCount -= 1 (GREATEST(..., 0))
    tx.update = (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: () => {
          for (const e of store.exams) {
            e.cardCount = Math.max(e.cardCount - 1, 0)
          }
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
          tombstones: store.tombstones.map((t) => ({ ...t })),
        }
        try {
          const r = await fn(makeTx())
          if (ctl.throwInTx) throw new Error('forced tx boom')
          return r
        } catch (err) {
          store.exams = snapshot.exams
          store.cards = snapshot.cards
          store.tombstones = snapshot.tombstones
          throw err
        }
      },
    }),
  }
})

async function importAction() {
  return await import('./delete-card')
}

beforeEach(() => {
  vi.clearAllMocks()
  store.exams = [{ id: 'exam-1', userId: 'user-1', cardCount: 1 }]
  store.cards = [{ id: 'card-1', examId: 'exam-1', userId: 'user-1' }]
  store.tombstones = []
  ctl.tombstoneAlreadyExists = false
  ctl.throwInTx = false
  captured.tombstoneValues = null
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

describe('deleteCard', () => {
  it('auth fail → { ok: false, error: 認証が必要です }, no tombstone, no delete', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('認証が必要です')
    expect(store.tombstones.length).toBe(0)
    expect(store.cards.length).toBe(1)
  })

  it('正常削除: tombstone INSERT + card DELETE + cardCount -= 1 が同一 tx で実行される', async () => {
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(true)
    // tombstone が挿入された
    expect(store.tombstones.length).toBe(1)
    expect(store.tombstones[0]).toMatchObject({
      userId: 'user-1',
      entityType: 'card',
      entityId: 'card-1',
    })
    // card が削除された
    expect(store.cards.length).toBe(0)
    // cardCount が 0 に (1 - 1)
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('{ ok: true } を返す', async () => {
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(true)
  })

  it('card 不在 → idempotent { ok: true }, NO tombstone, NO cardCount change', async () => {
    store.cards = [] // card が存在しない
    store.exams[0]!.cardCount = 0
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-nonexistent')
    expect(r.ok).toBe(true)
    // tombstone は挿入されない
    expect(store.tombstones.length).toBe(0)
    // cardCount は変わらない
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('re-delete (tombstone 重複) → onConflictDoNothing で error なし, { ok: true }', async () => {
    // 既に tombstone が存在する状態をシミュレート (onConflictDoNothing)
    ctl.tombstoneAlreadyExists = true
    store.cards = [] // card は既に削除済
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(true)
    // tombstone は重複なし (onConflictDoNothing)
    expect(store.tombstones.length).toBe(0)
  })

  it('owner-scope: WHERE に eq(cards.userId, user.id) と eq(cards.id, cardId) が含まれる', async () => {
    const { deleteCard } = await importAction()
    const { eq } = await import('drizzle-orm')
    await deleteCard('card-1')
    const calls = vi.mocked(eq).mock.calls
    const signature = calls.map((c) => {
      const col = c[0] as { name?: string; table?: unknown }
      const tableName = col.table ? getTableName(col.table as never) : ''
      return [tableName, col.name, c[1]]
    })
    // cards.id = cardId
    expect(signature).toContainEqual(['cards', 'id', 'card-1'])
    // cards.user_id = user.id (owner scope)
    expect(signature).toContainEqual(['cards', 'user_id', 'user-1'])
  })

  it('spec §3.6 integrity: 削除後 cardCount === COUNT(cards WHERE exam_id)', async () => {
    // 削除前: cardCount=1, cards=1
    expect(store.exams[0]!.cardCount).toBe(1)
    expect(store.cards.length).toBe(1)
    const { deleteCard } = await importAction()
    await deleteCard('card-1')
    const exam = store.exams.find((e) => e.id === 'exam-1')!
    const actualCount = store.cards.filter((c) => c.examId === 'exam-1').length
    expect(exam.cardCount).toBe(actualCount)
    expect(exam.cardCount).toBe(0)
  })

  it('最後の 1 枚を削除しても ok (0 card exam が残る、 guard なし)', async () => {
    expect(store.cards.length).toBe(1)
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(true)
    expect(store.cards.length).toBe(0)
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('GREATEST guard: cardCount が既に 0 でも負にならない', async () => {
    store.exams[0]!.cardCount = 0
    store.cards = [{ id: 'card-1', examId: 'exam-1', userId: 'user-1' }]
    const { deleteCard } = await importAction()
    await deleteCard('card-1')
    // Math.max(0 - 1, 0) = 0
    expect(store.exams[0]!.cardCount).toBe(0)
  })

  it('tx 内 DB throw → { ok: false }, logger.error 呼出, rollback で store 不変', async () => {
    ctl.throwInTx = true
    const { deleteCard } = await importAction()
    const r = await deleteCard('card-1')
    expect(r.ok).toBe(false)
    expect(mockLoggerError).toHaveBeenCalled()
    // rollback: card は残る
    expect(store.cards.length).toBe(1)
    // tombstone も残らない
    expect(store.tombstones.length).toBe(0)
    // cardCount 不変
    expect(store.exams[0]!.cardCount).toBe(1)
  })

  it('revalidatePath("/app/exams") は success 時に呼ばれる (finally)', async () => {
    const { deleteCard } = await importAction()
    await deleteCard('card-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('auth error 時も revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null)
    const { deleteCard } = await importAction()
    await deleteCard('card-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('card 不在時も revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    store.cards = []
    const { deleteCard } = await importAction()
    await deleteCard('card-nonexistent')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('tx throw 時も revalidatePath("/app/exams") を呼ぶ (finally)', async () => {
    ctl.throwInTx = true
    const { deleteCard } = await importAction()
    await deleteCard('card-1')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/app/exams')
  })

  it('tombstone.deletedAt は DB クロック sql`now()` (増分 pull cursor 統一)', async () => {
    // tombstone INSERT の .values() に渡された deletedAt が SQL 式で now() を含むこと
    const { deleteCard } = await importAction()
    await deleteCard('card-1')
    const deletedAt = captured.tombstoneValues?.deletedAt
    expect(deletedAt).toBeInstanceOf(SQL)
    const q = new PgDialect().sqlToQuery(deletedAt as SQL)
    expect(q.sql).toContain('now()')
    expect(q.params).toHaveLength(0)
  })
})
