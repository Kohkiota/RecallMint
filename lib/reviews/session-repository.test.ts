import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

// session-repository.ts の infra メソッドの unit test。
//
// tx / db はモックオブジェクトとして渡す (実 DB / 実 API 不使用)。
// owner-scope: 全 owner-scoped query の userId が eq() spy に渡ることを担保する
// (apply-card-mutation.test.ts と同方式)。SQL AST は fragile なので、args-capture
// (returning shape / count-mismatch throw / distinct SELECT 発行 / conflictSet) で
// 契約を固定する。

// ---------------------------------------------------------------------------
// drizzle-orm eq/and/inArray/sql を spy でラップ (実実装は保持)
// ---------------------------------------------------------------------------

const { mockEq, mockInArray } = vi.hoisted(() => ({
  mockEq: vi.fn(),
  mockInArray: vi.fn(),
}))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => {
      mockEq(...args)
      return real.eq(...args)
    }),
    inArray: vi.fn((...args: Parameters<typeof real.inArray>) => {
      mockInArray(...args)
      return real.inArray(...args)
    }),
  }
})

import { type User } from '@/lib/db/schema'
import type { ReplayCardState } from '@/lib/cards/replay-card'
import {
  loadCardReplayStates,
  insertAnswerEvents,
  insertReviews,
  applyCardFinalStates,
  upsertStudyDays,
  upsertSessionGuarded,
  type AnswerEventInsertRow,
} from './session-repository'

const USER_ID = '11111111-1111-4111-a111-111111111111'
const CARD_ID = '44444444-4444-4444-a444-444444444444'
const CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const FAKE_USER = { id: USER_ID } as unknown as User

/** [tableName, columnName, value] triples from the eq() spy calls. */
function eqSignature() {
  return (
    vi.mocked(mockEq).mock.calls as [
      { name?: string; table?: unknown },
      unknown,
    ][]
  ).map(([col, val]) => {
    const tableName = col.table ? getTableName(col.table as never) : ''
    return [tableName, col.name, val] as [string, string, unknown]
  })
}

const INITIAL_STATE: ReplayCardState = {
  due: new Date('2026-05-25T00:00:00Z'),
  stability: 1,
  difficulty: 2,
  elapsedDays: 0,
  scheduledDays: 0,
  reps: 0,
  lapses: 0,
  state: 0,
  learningSteps: 0,
  lastReview: null,
  answered: false,
  lastCorrect: null,
  currentStreak: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// loadCardReplayStates
// ---------------------------------------------------------------------------

describe('loadCardReplayStates', () => {
  it('owner-scoped SELECT: eq(cards.userId, userId) + inArray(cards.id, cardIds)', async () => {
    const captured: { cols?: unknown; where?: unknown } = {}
    const returnedRows = [{ id: CARD_ID }]
    const tx = {
      select: (cols: unknown) => {
        captured.cols = cols
        return {
          from: (_table: unknown) => ({
            where: (cond: unknown) => {
              captured.where = cond
              return Promise.resolve(returnedRows)
            },
          }),
        }
      },
    } as never

    const rows = await loadCardReplayStates(tx, USER_ID, [CARD_ID, CARD_ID_2])

    // returns raw rows verbatim (Set 化・cardStateMap 化しない)
    expect(rows).toBe(returnedRows)

    // owner WHERE: userId passed to eq
    const eqCalls = eqSignature()
    expect(eqCalls).toContainEqual(['cards', 'user_id', USER_ID])
    // inArray on cards.id with the card id list
    expect(mockInArray).toHaveBeenCalledTimes(1)
    const [inCol, inVals] = vi.mocked(mockInArray).mock.calls[0]!
    expect((inCol as { name: string }).name).toBe('id')
    expect(inVals).toEqual([CARD_ID, CARD_ID_2])
  })

  it('selects the full ReplayCardState column set incl. options', async () => {
    let captured: Record<string, unknown> | undefined
    const tx = {
      select: (cols: Record<string, unknown>) => {
        captured = cols
        return {
          from: () => ({ where: () => Promise.resolve([]) }),
        }
      },
    } as never
    await loadCardReplayStates(tx, USER_ID, [CARD_ID])
    expect(Object.keys(captured!).sort()).toEqual(
      [
        'answered',
        'currentStreak',
        'difficulty',
        'due',
        'elapsedDays',
        'id',
        'lapses',
        'lastCorrect',
        'lastReview',
        'learningSteps',
        'options',
        'reps',
        'scheduledDays',
        'stability',
        'state',
      ].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// insertAnswerEvents
// ---------------------------------------------------------------------------

describe('insertAnswerEvents', () => {
  function makeTx(returned: { eventId: string }[]) {
    const captured: {
      values?: unknown
      conflictTarget?: unknown
      returningCols?: unknown
    } = {}
    const tx = {
      insert: (_table: unknown) => ({
        values: (vals: unknown) => {
          captured.values = vals
          return {
            onConflictDoNothing: (conf: { target: unknown }) => {
              captured.conflictTarget = conf.target
              return {
                returning: (cols: unknown) => {
                  captured.returningCols = cols
                  return Promise.resolve(returned)
                },
              }
            },
          }
        },
      }),
    } as never
    return { tx, captured }
  }

  const rows: AnswerEventInsertRow[] = [
    {
      eventId: 'e1',
      sessionId: 's1',
      cardId: CARD_ID,
      userId: USER_ID,
      selectedAnswerIds: ['a'],
      isCorrect: true,
      answeredAt: new Date('2026-05-25T10:01:00Z'),
      elapsedMs: null,
    },
    {
      eventId: 'e2',
      sessionId: 's1',
      cardId: CARD_ID,
      userId: USER_ID,
      selectedAnswerIds: ['b'],
      isCorrect: false,
      answeredAt: new Date('2026-05-25T10:02:00Z'),
      elapsedMs: 500,
    },
  ]

  it('returns a Set of inserted event_ids (duplicate excluded by returning)', async () => {
    // returning omits e2 (conflict) → Set only has e1
    const { tx } = makeTx([{ eventId: 'e1' }])
    const inserted = await insertAnswerEvents(tx, rows)
    expect(inserted).toBeInstanceOf(Set)
    expect([...inserted]).toEqual(['e1'])
  })

  it('passes rows to values + onConflictDoNothing target=eventId + returning({eventId})', async () => {
    const { tx, captured } = makeTx([{ eventId: 'e1' }, { eventId: 'e2' }])
    await insertAnswerEvents(tx, rows)
    expect(captured.values).toBe(rows)
    // conflict target is the eventId column
    expect((captured.conflictTarget as { name: string }).name).toBe('event_id')
    // returning shape = { eventId }
    expect(Object.keys(captured.returningCols as object)).toEqual(['eventId'])
  })
})

// ---------------------------------------------------------------------------
// insertReviews
// ---------------------------------------------------------------------------

describe('insertReviews', () => {
  it('bulk INSERTs the given rows into reviews', async () => {
    let captured: unknown
    const tx = {
      insert: (_table: unknown) => ({
        values: (vals: unknown) => {
          captured = vals
          return Promise.resolve()
        },
      }),
    } as never
    const reviewRows = [
      { userId: USER_ID, cardId: CARD_ID, rating: 3 as const, reviewedAt: new Date() },
    ]
    await insertReviews(tx, reviewRows)
    expect(captured).toBe(reviewRows)
  })
})

// ---------------------------------------------------------------------------
// applyCardFinalStates
// ---------------------------------------------------------------------------

describe('applyCardFinalStates', () => {
  function makeTx(returnedIds: string[]) {
    const captured: { fromSql?: unknown; where?: unknown } = {}
    const tx = {
      update: (_table: unknown) => ({
        set: (_vals: unknown) => ({
          from: (fromSql: unknown) => {
            captured.fromSql = fromSql
            return {
              where: (cond: unknown) => {
                captured.where = cond
                return {
                  returning: (_cols: unknown) =>
                    Promise.resolve(returnedIds.map((id) => ({ id }))),
                }
              },
            }
          },
        }),
      }),
    } as never
    return { tx, captured }
  }

  it('no-op when finalStates is empty (no update issued)', async () => {
    let updateCalled = false
    const tx = {
      update: () => {
        updateCalled = true
        return { set: () => ({ from: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }) }
      },
    } as never
    await applyCardFinalStates(tx, USER_ID, new Map())
    expect(updateCalled).toBe(false)
  })

  it('owner-scoped UPDATE: eq(cards.userId, userId) in WHERE', async () => {
    const finalStates = new Map([[CARD_ID, INITIAL_STATE]])
    const { tx } = makeTx([CARD_ID])
    await applyCardFinalStates(tx, USER_ID, finalStates)
    expect(eqSignature()).toContainEqual(['cards', 'user_id', USER_ID])
  })

  it('throws count-mismatch when RETURNING rows < finalStates.size', async () => {
    const finalStates = new Map([
      [CARD_ID, INITIAL_STATE],
      [CARD_ID_2, INITIAL_STATE],
    ])
    // returning only 1 of 2 → mismatch
    const { tx } = makeTx([CARD_ID])
    await expect(
      applyCardFinalStates(tx, USER_ID, finalStates),
    ).rejects.toMatchObject({
      message: 'bulk update card count mismatch',
      expected: 2,
      updated: 1,
      missingCardIds: [CARD_ID_2],
    })
  })

  it('succeeds when RETURNING count === finalStates.size', async () => {
    const finalStates = new Map([
      [CARD_ID, INITIAL_STATE],
      [CARD_ID_2, INITIAL_STATE],
    ])
    const { tx } = makeTx([CARD_ID, CARD_ID_2])
    await expect(
      applyCardFinalStates(tx, USER_ID, finalStates),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// upsertStudyDays
// ---------------------------------------------------------------------------

describe('upsertStudyDays', () => {
  function makeTx(distinctRows: Array<{ day: string; distinct_count: number }>) {
    const captured: {
      executeCalls: unknown[]
      upsertCalls: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }>
    } = { executeCalls: [], upsertCalls: [] }
    const tx = {
      execute: (query: unknown) => {
        captured.executeCalls.push(query)
        return Promise.resolve(distinctRows)
      },
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          onConflictDoUpdate: (conf: { set: Record<string, unknown> }) => {
            captured.upsertCalls.push({ values: vals, set: conf.set })
            return Promise.resolve()
          },
        }),
      }),
    } as never
    return { tx, captured }
  }

  it('issues one distinct-count SELECT then a per-day UPSERT', async () => {
    const dayMap = new Map([
      ['2026-05-25', { total: 3, correct: 2 }],
      ['2026-05-26', { total: 1, correct: 0 }],
    ])
    const { tx, captured } = makeTx([
      { day: '2026-05-25', distinct_count: 2 },
      { day: '2026-05-26', distinct_count: 1 },
    ])
    await upsertStudyDays(tx, USER_ID, dayMap)

    // one distinct SELECT execute
    expect(captured.executeCalls.length).toBe(1)
    // per-day UPSERT (2 days)
    expect(captured.upsertCalls.length).toBe(2)
    expect(captured.upsertCalls[0]!.values).toMatchObject({
      userId: USER_ID,
      day: '2026-05-25',
      reviewCount: 3,
      correctCount: 2,
      distinctCardCount: 2,
    })
    // set has reviewCount/correctCount/distinctCardCount keys
    expect(Object.keys(captured.upsertCalls[0]!.set).sort()).toEqual(
      ['correctCount', 'distinctCardCount', 'reviewCount'].sort(),
    )
  })

  it('falls back to distinctCardCount=0 when the day is absent from the SELECT result', async () => {
    const dayMap = new Map([['2026-05-25', { total: 1, correct: 1 }]])
    const { tx, captured } = makeTx([]) // no distinct rows
    await upsertStudyDays(tx, USER_ID, dayMap)
    expect(captured.upsertCalls[0]!.values.distinctCardCount).toBe(0)
    expect(captured.upsertCalls[0]!.set.distinctCardCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// upsertSessionGuarded (参照事実 D の R 形)
// ---------------------------------------------------------------------------

describe('upsertSessionGuarded', () => {
  function makeDb() {
    const captured: {
      values?: Record<string, unknown>
      conflictSet?: Record<string, unknown>
      conflictTarget?: unknown
      setWhere?: unknown
    } = {}
    const db = {
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          captured.values = vals
          return {
            onConflictDoUpdate: (conf: {
              target: unknown
              set: Record<string, unknown>
              setWhere?: unknown
            }) => {
              captured.conflictTarget = conf.target
              captured.conflictSet = conf.set
              captured.setWhere = conf.setWhere
              return Promise.resolve()
            },
          }
        },
      }),
    } as never
    return { db, captured }
  }

  const session = {
    session_id: '22222222-2222-4222-a222-222222222222',
    exam_id: '33333333-3333-4333-a333-333333333333',
    mode: 'smart' as const,
    card_ids: [CARD_ID],
    started_at: '2026-05-25T10:00:00.000Z',
    completed_at: '2026-05-25T10:05:00.000Z',
    status: 'completed' as const,
  }

  it('R form: conflictSet = {completedAt, status} only, target = sessionId, applied:true', async () => {
    const { db, captured } = makeDb()
    const result = await upsertSessionGuarded(db, FAKE_USER, session)

    expect(result).toEqual({ applied: true })
    // conflict target on session_id PK
    expect((captured.conflictTarget as { name: string }).name).toBe('session_id')
    // conflictSet is ONLY completedAt + status (card_ids insert-only / I-1)
    expect(Object.keys(captured.conflictSet!).sort()).toEqual(
      ['completedAt', 'status'].sort(),
    )
    expect(captured.conflictSet!.status).toBe('completed')
    // insert values carry full row incl. card_ids
    expect(captured.values).toMatchObject({
      sessionId: session.session_id,
      userId: USER_ID,
      mode: 'smart',
      cardIds: [CARD_ID],
      status: 'completed',
    })
  })

  it('setWhere = eq(studySessions.userId, user.id) (tenant guard only, no transition predicate)', async () => {
    const { db } = makeDb()
    await upsertSessionGuarded(db, FAKE_USER, session)
    // exactly one eq call in the R form: the setWhere tenant guard
    const eqCalls = eqSignature()
    expect(eqCalls).toContainEqual(['study_sessions', 'user_id', USER_ID])
    // R form has no status transition predicate — only the tenant eq
    expect(eqCalls.length).toBe(1)
  })

  it('null completed_at when session omits completed_at', async () => {
    const { db, captured } = makeDb()
    await upsertSessionGuarded(db, FAKE_USER, {
      ...session,
      completed_at: undefined,
    })
    expect(captured.values!.completedAt).toBeNull()
    expect(captured.conflictSet!.completedAt).toBeNull()
  })
})
