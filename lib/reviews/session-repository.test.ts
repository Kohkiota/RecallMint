import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

// session-repository.ts の infra メソッドの unit test。
//
// tx / db はモックオブジェクトとして渡す (実 DB / 実 API 不使用)。
// owner-scope: 全 owner-scoped query の userId が eq() spy に渡ることを担保する
// (apply-card-mutation.test.ts と同方式)。SQL AST は fragile なので、args-capture
// (chain 形 / returning shape / count-mismatch throw / 描画 SQL の骨格) で契約を固定する。

// ---------------------------------------------------------------------------
// drizzle-orm eq/inArray を spy でラップ (実実装は保持)
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

import type { ReplayCardState } from '@/lib/cards/replay-card'
import { reviewLogs } from '@/lib/db/schema'
import {
  lockCardReplayStates,
  insertAnswerEvents,
  verifyEventCollisions,
  markApplied,
  applyCardFinalStates,
  recomputeStudyDays,
  insertReviewLogs,
  type AnswerEventInsertRow,
  type CollisionCandidate,
  type ReviewLogInsertRow,
} from './session-repository'

const USER_ID = '11111111-1111-4111-a111-111111111111'
const CARD_ID = '44444444-4444-4444-a444-444444444444'
const CARD_ID_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const EVENT_ID = '55555555-5555-4555-a555-555555555555'

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

function renderSql(query: unknown): string {
  return new PgDialect().sqlToQuery(query as SQL).sql
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
  firstReviewedAt: null,
  answered: false,
  lastCorrect: null,
  currentStreak: 0,
}

const RECEIVED_AT = new Date('2026-05-25T10:05:00.000Z')

function makeInsertRow(
  overrides: Partial<AnswerEventInsertRow> = {},
): AnswerEventInsertRow {
  return {
    eventId: EVENT_ID,
    userId: USER_ID,
    cardId: CARD_ID,
    sessionId: null,
    selectedAnswerIds: ['a'],
    isCorrect: true,
    rating: 3,
    answeredAt: new Date('2026-05-25T10:01:00.000Z'),
    elapsedMs: null,
    origin: null,
    applied: false,
    createdAt: RECEIVED_AT,
    ...overrides,
  }
}

function makeCandidate(
  overrides: Partial<CollisionCandidate> = {},
): CollisionCandidate {
  return {
    eventId: EVENT_ID,
    cardId: CARD_ID,
    sessionId: null,
    selectedAnswerIds: ['a'],
    isCorrect: true,
    rating: 3,
    rawAnsweredAt: new Date('2026-05-25T10:01:00.000Z'),
    elapsedMs: null,
    ...overrides,
  }
}

function makeReviewLogRow(
  overrides: Partial<ReviewLogInsertRow> = {},
): ReviewLogInsertRow {
  return {
    eventId: EVENT_ID,
    userId: USER_ID,
    cardId: CARD_ID,
    rating: 3,
    stateBefore: 2,
    dueBefore: new Date('2026-05-25T00:00:00Z'),
    stabilityBefore: 1,
    difficultyBefore: 2,
    elapsedDays: 0,
    lastElapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    review: new Date('2026-05-25T10:01:00.000Z'),
    stateAfter: 2,
    stabilityAfter: 1.5,
    difficultyAfter: 2.1,
    createdAt: RECEIVED_AT,
    ...overrides,
  }
}

/** verifyEventCollisions が読む既存行の既定形 (candidate と一致する内容)。 */
function makeExistingRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    cardId: CARD_ID,
    sessionId: null,
    selectedAnswerIds: ['a'],
    isCorrect: true,
    rating: 3,
    answeredAt: new Date('2026-05-25T10:01:00.000Z'),
    elapsedMs: null,
    createdAt: RECEIVED_AT,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// lockCardReplayStates
// ---------------------------------------------------------------------------

describe('lockCardReplayStates', () => {
  function makeTx(rows: unknown[]) {
    const captured: {
      cols?: Record<string, unknown>
      orderBy?: unknown
      lock?: string
    } = {}
    const tx = {
      select: (cols: Record<string, unknown>) => {
        captured.cols = cols
        return {
          from: () => ({
            where: () => ({
              orderBy: (col: unknown) => {
                captured.orderBy = col
                return {
                  for: (lock: string) => {
                    captured.lock = lock
                    return Promise.resolve(rows)
                  },
                }
              },
            }),
          }),
        }
      },
    } as never
    return { tx, captured }
  }

  it('owner-scoped + ID 昇順 + FOR UPDATE (同一 card の並走 flush を直列化)', async () => {
    const returnedRows = [{ id: CARD_ID }]
    const { tx, captured } = makeTx(returnedRows)

    const rows = await lockCardReplayStates(tx, USER_ID, [CARD_ID, CARD_ID_2])

    expect(rows).toBe(returnedRows)
    expect(eqSignature()).toContainEqual(['cards', 'user_id', USER_ID])
    const [inCol, inVals] = vi.mocked(mockInArray).mock.calls[0]!
    expect((inCol as { name: string }).name).toBe('id')
    expect(inVals).toEqual([CARD_ID, CARD_ID_2])
    // ORDER BY cards.id (ロック取得順の固定 = deadlock 防止)
    expect((captured.orderBy as { name: string }).name).toBe('id')
    expect(captured.lock).toBe('update')
  })

  it('ReplayCardState の全列 + options を select する', async () => {
    const { tx, captured } = makeTx([])
    await lockCardReplayStates(tx, USER_ID, [CARD_ID])
    expect(Object.keys(captured.cols!).sort()).toEqual(
      [
        'answered',
        'currentStreak',
        'difficulty',
        'due',
        'elapsedDays',
        // Dash-1 Task 3: 明示列 SELECT なので落とすと initial が常に null になり
        // 先着固定が壊れる (spec §8.3) — 列集合の drift をここで pin する。
        'firstReviewedAt',
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
      insert: () => ({
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

  const rows = [
    makeInsertRow({ eventId: 'e1' }),
    makeInsertRow({ eventId: 'e2', isCorrect: false, rating: 1, elapsedMs: 500 }),
  ]

  it('RETURNING で新規 event_id だけを Set にして返す (既存は除外)', async () => {
    const { tx } = makeTx([{ eventId: 'e1' }])
    const inserted = await insertAnswerEvents(tx, rows)
    expect(inserted).toBeInstanceOf(Set)
    expect([...inserted]).toEqual(['e1'])
  })

  it('values + onConflictDoNothing target=event_id + returning({eventId})', async () => {
    const { tx, captured } = makeTx([{ eventId: 'e1' }, { eventId: 'e2' }])
    await insertAnswerEvents(tx, rows)
    expect(captured.values).toBe(rows)
    expect((captured.conflictTarget as { name: string }).name).toBe('event_id')
    expect(Object.keys(captured.returningCols as object)).toEqual(['eventId'])
  })

  it('applied=false / created_at を明示 set した行をそのまま渡す (DB default に頼らない)', async () => {
    const { tx, captured } = makeTx([])
    await insertAnswerEvents(tx, rows)
    const passed = captured.values as AnswerEventInsertRow[]
    expect(passed.every((r) => r.applied === false)).toBe(true)
    expect(passed.every((r) => r.createdAt === RECEIVED_AT)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyEventCollisions — 2 段検証
// ---------------------------------------------------------------------------

describe('verifyEventCollisions', () => {
  function makeTx(rows: unknown[]) {
    let selectCalls = 0
    const tx = {
      select: () => {
        selectCalls++
        return { from: () => ({ where: () => Promise.resolve(rows) }) }
      },
    } as never
    return { tx, getSelectCalls: () => selectCalls }
  }

  it('候補が空なら SELECT を発行せず空配列', async () => {
    const { tx, getSelectCalls } = makeTx([])
    expect(await verifyEventCollisions(tx, USER_ID, [])).toEqual([])
    expect(getSelectCalls()).toBe(0)
  })

  it('own-scope SELECT に不在 = 不可視衝突 (他 user の行) → failed[]', async () => {
    const { tx } = makeTx([])
    const failed = await verifyEventCollisions(tx, USER_ID, [makeCandidate()])
    expect(failed).toEqual([EVENT_ID])
    // owner-scope 述語を query 側にも明示している (RLS 非迂回)
    expect(eqSignature()).toContainEqual(['answer_events', 'user_id', USER_ID])
  })

  it('自分の既存行と内容一致 (正当な再送) → failed に載せない', async () => {
    const { tx } = makeTx([makeExistingRow()])
    expect(await verifyEventCollisions(tx, USER_ID, [makeCandidate()])).toEqual([])
  })

  it('初回に clamp された event の再送も一致判定になる (比較基準 = min(raw, 既存 created_at))', async () => {
    // 初回: raw が created_at より未来 → answered_at は created_at に clamp されて保存済。
    const existing = makeExistingRow({
      answeredAt: RECEIVED_AT,
      createdAt: RECEIVED_AT,
    })
    const resent = makeCandidate({
      rawAnsweredAt: new Date('2026-05-25T23:00:00.000Z'), // 同じ raw を再送
    })
    const { tx } = makeTx([existing])
    expect(await verifyEventCollisions(tx, USER_ID, [resent])).toEqual([])
  })

  it('answered_at の ISO 表現差は epoch 比較で吸収する', async () => {
    const { tx } = makeTx([makeExistingRow()])
    const resent = makeCandidate({
      rawAnsweredAt: new Date('2026-05-25T10:01:00Z'), // ミリ秒表記なし
    })
    expect(await verifyEventCollisions(tx, USER_ID, [resent])).toEqual([])
  })

  it.each([
    ['card_id', { cardId: CARD_ID_2 }],
    ['is_correct', { isCorrect: false }],
    ['rating', { rating: 4 as const }],
    ['answered_at', { rawAnsweredAt: new Date('2026-05-25T09:00:00.000Z') }],
    ['selected_answer_ids (要素)', { selectedAnswerIds: ['b'] }],
    ['selected_answer_ids (長さ)', { selectedAnswerIds: ['a', 'b'] }],
    ['session_id (NULL → 値)', { sessionId: 'ssssssss-ssss-4sss-asss-ssssssssssss' }],
    ['elapsed_ms (NULL → 値)', { elapsedMs: 42 }],
  ])('内容不一致 (%s) → failed[]', async (_label, overrides) => {
    const { tx } = makeTx([makeExistingRow()])
    const failed = await verifyEventCollisions(tx, USER_ID, [
      makeCandidate(overrides as Partial<CollisionCandidate>),
    ])
    expect(failed).toEqual([EVENT_ID])
  })

  it('selected_answer_ids は配列順まで見る', async () => {
    const { tx } = makeTx([makeExistingRow({ selectedAnswerIds: ['a', 'b'] })])
    const failed = await verifyEventCollisions(tx, USER_ID, [
      makeCandidate({ selectedAnswerIds: ['b', 'a'] }),
    ])
    expect(failed).toEqual([EVENT_ID])
  })

  it('複数候補のうち不一致だけを返す', async () => {
    const other = '66666666-6666-4666-a666-666666666666'
    const { tx } = makeTx([
      makeExistingRow(),
      makeExistingRow({ eventId: other, isCorrect: false }),
    ])
    const failed = await verifyEventCollisions(tx, USER_ID, [
      makeCandidate(),
      makeCandidate({ eventId: other, isCorrect: true }),
    ])
    expect(failed).toEqual([other])
  })
})

// ---------------------------------------------------------------------------
// markApplied
// ---------------------------------------------------------------------------

describe('markApplied', () => {
  function makeTx() {
    const captured: { set?: Record<string, unknown> } = {}
    let updateCalls = 0
    const tx = {
      update: () => {
        updateCalls++
        return {
          set: (vals: Record<string, unknown>) => {
            captured.set = vals
            return { where: () => Promise.resolve() }
          },
        }
      },
    } as never
    return { tx, captured, getUpdateCalls: () => updateCalls }
  }

  it('空配列なら UPDATE を発行しない', async () => {
    const { tx, getUpdateCalls } = makeTx()
    await markApplied(tx, USER_ID, [])
    expect(getUpdateCalls()).toBe(0)
  })

  it('applied=true を owner-scope + event_id IN で 1 文更新する', async () => {
    const { tx, captured, getUpdateCalls } = makeTx()
    await markApplied(tx, USER_ID, ['e1', 'e2'])
    expect(getUpdateCalls()).toBe(1)
    expect(captured.set).toEqual({ applied: true })
    expect(eqSignature()).toContainEqual(['answer_events', 'user_id', USER_ID])
    const [inCol, inVals] = vi.mocked(mockInArray).mock.calls[0]!
    expect((inCol as { name: string }).name).toBe('event_id')
    expect(inVals).toEqual(['e1', 'e2'])
  })
})

// ---------------------------------------------------------------------------
// insertReviewLogs — spec §5 手順 7.5 (R0 Task 3)
// ---------------------------------------------------------------------------

describe('insertReviewLogs', () => {
  function makeTx() {
    const captured: { table?: unknown; values?: unknown } = {}
    let insertCalls = 0
    const tx = {
      insert: (table: unknown) => {
        insertCalls++
        captured.table = table
        return {
          values: (vals: unknown) => {
            captured.values = vals
            return Promise.resolve(undefined)
          },
        }
      },
    } as never
    return { tx, captured, getInsertCalls: () => insertCalls }
  }

  it('rows が空なら INSERT statement を発行しない (早期 return)', async () => {
    const { tx, getInsertCalls } = makeTx()
    await insertReviewLogs(tx, [])
    expect(getInsertCalls()).toBe(0)
  })

  it('複数 rows を単一 bulk INSERT に渡す (行ごとの N+1 をせず、全列を素通しする)', async () => {
    const rows = [
      makeReviewLogRow({ eventId: 'e1' }),
      makeReviewLogRow({ eventId: 'e2', cardId: CARD_ID_2 }),
    ]
    const { tx, captured, getInsertCalls } = makeTx()
    await insertReviewLogs(tx, rows)

    expect(getInsertCalls()).toBe(1)
    expect(getTableName(captured.table as never)).toBe(getTableName(reviewLogs))
    // plain INSERT (onConflictDoNothing を挟まず .values() を直接 await) — 素通しなので
    // 17 列いずれも欠落・変形しない (参照同一で全列担保)。
    expect(captured.values).toBe(rows)
  })
})

// ---------------------------------------------------------------------------
// applyCardFinalStates
// ---------------------------------------------------------------------------

describe('applyCardFinalStates', () => {
  function makeTx(returnedIds: string[]) {
    const captured: { fromSql?: unknown } = {}
    const tx = {
      update: () => ({
        set: () => ({
          from: (fromSql: unknown) => {
            captured.fromSql = fromSql
            return {
              where: () => ({
                returning: () => Promise.resolve(returnedIds.map((id) => ({ id }))),
              }),
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
        return {
          set: () => ({
            from: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
          }),
        }
      },
    } as never
    await applyCardFinalStates(tx, USER_ID, new Map())
    expect(updateCalled).toBe(false)
  })

  it('owner-scoped UPDATE: eq(cards.userId, userId) in WHERE', async () => {
    const { tx } = makeTx([CARD_ID])
    await applyCardFinalStates(tx, USER_ID, new Map([[CARD_ID, INITIAL_STATE]]))
    expect(eqSignature()).toContainEqual(['cards', 'user_id', USER_ID])
  })

  it('stability / difficulty は double precision で cast する (real 丸め回避)', async () => {
    const { tx, captured } = makeTx([CARD_ID])
    await applyCardFinalStates(tx, USER_ID, new Map([[CARD_ID, INITIAL_STATE]]))
    const rendered = renderSql(captured.fromSql)
    expect(rendered).toContain('::double precision')
    expect(rendered).not.toContain('::real')
  })

  it('throws count-mismatch when RETURNING rows < finalStates.size', async () => {
    const finalStates = new Map([
      [CARD_ID, INITIAL_STATE],
      [CARD_ID_2, INITIAL_STATE],
    ])
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
// recomputeStudyDays
// ---------------------------------------------------------------------------

describe('recomputeStudyDays', () => {
  // lockedDays を渡すと FOR UPDATE がその day 行だけを返す (行数 postcondition の変異用)。
  // 既定は直前の INSERT ... ON CONFLICT DO NOTHING が全 day を確保した実 DB の形。
  function makeTx(lockedDays?: string[]) {
    const captured: {
      insertValues?: Array<{ userId: string; day: string }>
      conflictTarget?: unknown
      lockOrderBy?: unknown
      lockMode?: string
      executeCalls: unknown[]
    } = { executeCalls: [] }
    let insertCalls = 0
    let selectCalls = 0
    const tx = {
      insert: () => {
        insertCalls++
        return {
          values: (vals: Array<{ userId: string; day: string }>) => {
            captured.insertValues = vals
            return {
              onConflictDoNothing: (conf: { target: unknown }) => {
                captured.conflictTarget = conf.target
                return Promise.resolve()
              },
            }
          },
        }
      },
      select: () => {
        selectCalls++
        return {
          from: () => ({
            where: () => ({
              orderBy: (col: unknown) => {
                captured.lockOrderBy = col
                return {
                  for: (lock: string) => {
                    captured.lockMode = lock
                    const days =
                      lockedDays ?? (captured.insertValues ?? []).map((v) => v.day)
                    return Promise.resolve(days.map((day) => ({ day })))
                  },
                }
              },
            }),
          }),
        }
      },
      execute: (query: unknown) => {
        captured.executeCalls.push(query)
        return Promise.resolve([])
      },
    } as never
    return {
      tx,
      captured,
      getInsertCalls: () => insertCalls,
      getSelectCalls: () => selectCalls,
    }
  }

  it('days が空なら何も発行しない', async () => {
    const { tx, captured, getInsertCalls, getSelectCalls } = makeTx()
    await recomputeStudyDays(tx, USER_ID, [])
    expect(getInsertCalls()).toBe(0)
    expect(getSelectCalls()).toBe(0)
    expect(captured.executeCalls).toHaveLength(0)
  })

  it('day 昇順に行を確保してから FOR UPDATE でロックする (cross-card lost update 対策)', async () => {
    const { tx, captured } = makeTx()
    await recomputeStudyDays(tx, USER_ID, ['2026-05-26', '2026-05-25'])

    // 1) 行確保は昇順 + ON CONFLICT DO NOTHING (複合 PK target)
    expect(captured.insertValues).toEqual([
      { userId: USER_ID, day: '2026-05-25' },
      { userId: USER_ID, day: '2026-05-26' },
    ])
    expect(
      (captured.conflictTarget as Array<{ name: string }>).map((c) => c.name),
    ).toEqual(['user_id', 'day'])
    // 2) 同じ昇順で FOR UPDATE
    expect((captured.lockOrderBy as { name: string }).name).toBe('day')
    expect(captured.lockMode).toBe('update')
    expect(eqSignature()).toContainEqual(['study_days', 'user_id', USER_ID])
  })

  it('再集計は VALUES CTE + 絶対値 UPDATE の 1 文 (day ごとの N+1 をしない)', async () => {
    const { tx, captured } = makeTx()
    await recomputeStudyDays(tx, USER_ID, ['2026-05-25', '2026-05-26'])

    expect(captured.executeCalls).toHaveLength(1)
    const rendered = renderSql(captured.executeCalls[0]).replace(/\s+/g, ' ')
    // 対象 day のみを VALUES で列挙する (min〜max の連続 range にしない)
    expect(rendered).toContain('WITH days(day, start_at, end_at) AS (VALUES')
    // 絶対値 set (加算意味論の廃止)
    expect(rendered).toContain('SET review_count = agg.review_count')
    expect(rendered).not.toContain('review_count +')
    // correct_count は is_correct 由来 (rating>=2 ではない)
    expect(rendered).toContain('FILTER (WHERE ae.is_correct)')
    // applied=true の event だけを母集合にする
    expect(rendered).toContain('ae.applied')
    // JST 境界は bind した timestamptz で比較する (SQL 側の AT TIME ZONE を使わない)
    expect(rendered).not.toContain('AT TIME ZONE')
  })

  it('JST day 境界を [00:00+09:00, 翌 00:00+09:00) の UTC instant で bind する', async () => {
    const { tx, captured } = makeTx()
    await recomputeStudyDays(tx, USER_ID, ['2026-05-25'])
    const params = new PgDialect().sqlToQuery(captured.executeCalls[0] as SQL).params
    expect(params).toContain('2026-05-24T15:00:00.000Z')
    expect(params).toContain('2026-05-25T15:00:00.000Z')
  })

  // 行数 postcondition (applyCardFinalStates の count-mismatch throw と同型)。
  // ロックが要求 day に届かないまま再集計 UPDATE を撃つと、その day は 1 行も
  // マッチせず集計が黙って古いままになる (silent undercount)。
  it('FOR UPDATE が要求 day 数に満たなければ throw して再集計を撃たない', async () => {
    const { tx, captured } = makeTx(['2026-05-25'])
    await expect(
      recomputeStudyDays(tx, USER_ID, ['2026-05-25', '2026-05-26']),
    ).rejects.toMatchObject({
      message: 'study_days lock row count mismatch',
      expected: 2,
      locked: 1,
      missingDays: ['2026-05-26'],
    })
    expect(captured.executeCalls).toHaveLength(0)
  })

  // 重複 day は throw でなく distinct 化で吸収する (再集計は絶対値ゆえ冪等)。
  // postcondition は「ロック網羅性」だけを主張し、呼び側の重複と混同しない。
  it('days の重複は distinct 化され 1 day 分だけ確保・ロック・再集計する', async () => {
    const { tx, captured } = makeTx()
    await recomputeStudyDays(tx, USER_ID, ['2026-05-25', '2026-05-25'])
    expect(captured.insertValues).toEqual([{ userId: USER_ID, day: '2026-05-25' }])
    expect(captured.executeCalls).toHaveLength(1)
  })
})
