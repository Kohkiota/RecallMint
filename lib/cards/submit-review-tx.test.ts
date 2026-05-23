// submit-review-tx の unit test。
// drizzle tx は spy mock で insert/update/select/execute の call を記録する。
// 実 DB は一切叩かない。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'
import type { RatingInt } from '@/lib/fsrs'

// -----------------------------------------------------------------------
// Shared state / mocks (vi.hoisted で tx call history を保持)
// -----------------------------------------------------------------------
const { txState } = vi.hoisted(() => ({
  txState: {
    selectRows: [] as Record<string, unknown>[],
    updateCalls: [] as Array<{ table: string; set: Record<string, unknown> }>,
    insertCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
    conflictCalls: [] as Array<{
      target: unknown
      set: Record<string, unknown>
    }>,
    executeResult: { rows: [{ c: 1 }] } as { rows: { c: number }[] },
  },
}))

// -----------------------------------------------------------------------
// fs-fsrs rate() mock — 決定論的な next card を返す
// -----------------------------------------------------------------------
vi.mock('@/lib/fsrs', async (importActual) => {
  const real = await importActual<typeof import('@/lib/fsrs')>()
  return {
    ...real,
    rate: vi.fn((_card: unknown, _rating: RatingInt, now: Date = new Date()) => ({
      card: {
        due: new Date(now.getTime() + 86400000), // +1 day
        stability: 2.5,
        difficulty: 5.0,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 1, // Learning
        last_review: now,
      },
    })),
  }
})

// -----------------------------------------------------------------------
// drizzle-orm sql mock — sql`` テンプレートの stub
// -----------------------------------------------------------------------
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => ({
        __sql: strings.join('?'),
      }),
      real.sql,
    ),
  }
})

// -----------------------------------------------------------------------
// tx mock factory — submitReviewTx に渡すドライバー mock
// -----------------------------------------------------------------------
function makeTx() {
  return {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => Promise.resolve(txState.selectRows),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        txState.updateCalls.push({
          table: getTableName(table as Parameters<typeof getTableName>[0]),
          set: vals,
        })
        return {
          where: (_cond: unknown) => Promise.resolve(),
        }
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const tableName = getTableName(table as Parameters<typeof getTableName>[0])
        txState.insertCalls.push({ table: tableName, values: vals })
        return {
          onConflictDoUpdate: (conf: {
            target: unknown
            set: Record<string, unknown>
          }) => {
            txState.conflictCalls.push({
              target: conf.target,
              set: conf.set,
            })
            return Promise.resolve()
          },
        }
      },
    }),
    execute: (_query: unknown) =>
      Promise.resolve(txState.executeResult),
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
function makeCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'card-1',
    userId: 'user-1',
    due: new Date('2026-05-23T00:00:00Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    answered: false,
    lastCorrect: null,
    currentStreak: 3,
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------
import { submitReviewTx } from './submit-review-tx'

beforeEach(() => {
  txState.selectRows = [makeCard()]
  txState.updateCalls = []
  txState.insertCalls = []
  txState.conflictCalls = []
  txState.executeResult = { rows: [{ c: 1 }] }
})

describe('submitReviewTx', () => {
  // ------- 正常系: correct (rating >= 2) -------
  it('correct=true (rating=3): cards UPDATE / reviews INSERT / study_days UPSERT が発火する', async () => {
    const tx = makeTx()
    const now = new Date('2026-05-23T10:00:00Z')
    const result = await submitReviewTx(tx as never, {
      userId: 'user-1',
      cardId: 'card-1',
      rating: 3 as RatingInt,
      now,
    })

    expect(result).toEqual({ correct: true })
    // cards UPDATE
    expect(txState.updateCalls).toHaveLength(1)
    expect(txState.updateCalls[0].table).toBe('cards')
    expect(txState.updateCalls[0].set).toMatchObject({
      answered: true,
      lastCorrect: true,
    })
    // streak: correct=true → currentStreak (3+1=4)
    expect(txState.updateCalls[0].set.currentStreak).toBe(4)
    // reviews INSERT
    const reviewInsert = txState.insertCalls.find((c) => c.table === 'reviews')
    expect(reviewInsert).toBeDefined()
    expect(reviewInsert!.values).toMatchObject({
      userId: 'user-1',
      cardId: 'card-1',
      rating: 3,
      reviewedAt: now,
    })
    // study_days UPSERT
    const studyInsert = txState.insertCalls.find((c) => c.table === 'study_days')
    expect(studyInsert).toBeDefined()
    // conflict set: correct_count +1
    expect(txState.conflictCalls).toHaveLength(1)
    const conflictSet = txState.conflictCalls[0].set
    expect(conflictSet).toBeDefined()
    // target は [userId, day] の配列
    expect(Array.isArray(txState.conflictCalls[0].target)).toBe(true)
  })

  // ------- 正常系: incorrect (rating=1 / Again) -------
  it('incorrect (rating=1): currentStreak=0、correct_count は +0', async () => {
    const tx = makeTx()
    const now = new Date('2026-05-23T10:00:00Z')
    const result = await submitReviewTx(tx as never, {
      userId: 'user-1',
      cardId: 'card-1',
      rating: 1 as RatingInt,
      now,
    })

    expect(result).toEqual({ correct: false })
    // streak reset
    expect(txState.updateCalls[0].set.currentStreak).toBe(0)
    expect(txState.updateCalls[0].set.lastCorrect).toBe(false)
    // study_days insert values: correctCount = 0
    const studyInsert = txState.insertCalls.find((c) => c.table === 'study_days')
    expect(studyInsert).toBeDefined()
    expect(studyInsert!.values).toMatchObject({ correctCount: 0 })
  })

  // ------- distinct_card_count 再集計 -------
  it('distinct_card_count は execute() 結果で上書きされる', async () => {
    txState.executeResult = { rows: [{ c: 5 }] }
    const tx = makeTx()
    const now = new Date('2026-05-23T10:00:00Z')
    await submitReviewTx(tx as never, {
      userId: 'user-1',
      cardId: 'card-1',
      rating: 3 as RatingInt,
      now,
    })
    // study_days values と conflict set の distinctCardCount が 5
    const studyInsert = txState.insertCalls.find((c) => c.table === 'study_days')
    expect(studyInsert!.values).toMatchObject({ distinctCardCount: 5 })
    expect(txState.conflictCalls[0].set).toMatchObject({ distinctCardCount: 5 })
  })

  // ------- cards 不在 → throw -------
  it('card 不在 (0 行) → throw Error("card not found")', async () => {
    txState.selectRows = []
    const tx = makeTx()
    await expect(
      submitReviewTx(tx as never, {
        userId: 'user-1',
        cardId: 'card-x',
        rating: 3 as RatingInt,
        now: new Date(),
      }),
    ).rejects.toThrow('card not found')
  })

  // ------- rating 別 (1/2/3/4) で correct フラグが正しい -------
  it.each([
    [1 as RatingInt, false],
    [2 as RatingInt, true],
    [3 as RatingInt, true],
    [4 as RatingInt, true],
  ])('rating=%i → correct=%s', async (rating, expected) => {
    txState.selectRows = [makeCard()]
    txState.updateCalls = []
    txState.insertCalls = []
    txState.conflictCalls = []
    const tx = makeTx()
    const result = await submitReviewTx(tx as never, {
      userId: 'user-1',
      cardId: 'card-1',
      rating,
      now: new Date(),
    })
    expect(result.correct).toBe(expected)
  })

  // ------- now が reviews.reviewedAt / todayInJst に伝播 -------
  it('now が reviews.reviewedAt に使われる', async () => {
    const tx = makeTx()
    const now = new Date('2026-05-23T05:00:00Z') // JST 2026-05-23 14:00
    await submitReviewTx(tx as never, {
      userId: 'user-1',
      cardId: 'card-1',
      rating: 3 as RatingInt,
      now,
    })
    const reviewInsert = txState.insertCalls.find((c) => c.table === 'reviews')
    expect(reviewInsert!.values.reviewedAt).toBe(now)
    // study_days: day = '2026-05-23'
    const studyInsert = txState.insertCalls.find((c) => c.table === 'study_days')
    expect(studyInsert!.values.day).toBe('2026-05-23')
  })
})
