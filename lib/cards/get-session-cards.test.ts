// get-session-cards の unit test(Dash-1 Home v1 §8.5 の server fallback 契約)。
//
// dbc は呼出側注入なので、 chain を返す fake db をそのまま渡す(@/lib/db の mock は
// 不要)。 drizzle operator のみ spy して「どの述語で候補行を読むか」を pin する。
// 選定条件そのものの網羅は `lib/cards/domain/session-pool.test.ts`、 client との
// 一致は `session-pool-equivalence.test.ts` が持つ。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DAILY_NEW_DEFAULT } from '@/lib/dashboard/domain/metric-constants'
import type { Card } from '@/lib/db/schema'
import type { TenantDb } from '@/lib/db/tenant-tx'

// -----------------------------------------------------------------------
// Hoisted mocks
// -----------------------------------------------------------------------
const { dbState, limitSpy } = vi.hoisted(() => ({
  dbState: { queue: [] as Record<string, unknown>[][] },
  limitSpy: vi.fn(),
}))

vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    ne: vi.fn((...args: Parameters<typeof real.ne>) => real.ne(...args)),
    lt: vi.fn((...args: Parameters<typeof real.lt>) => real.lt(...args)),
    gte: vi.fn((...args: Parameters<typeof real.gte>) => real.gte(...args)),
    inArray: vi.fn((...args: Parameters<typeof real.inArray>) =>
      real.inArray(...args),
    ),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
    or: vi.fn((...args: Parameters<typeof real.or>) => real.or(...args)),
    asc: vi.fn((...args: Parameters<typeof real.asc>) => real.asc(...args)),
  }
})

// select() は「exam 行 → 復習候補 → 新規候補」の順に 3 回呼ばれる。 queue はその順。
function fakeDb(): TenantDb {
  function chain() {
    const obj: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy']) obj[m] = () => obj
    obj.limit = (n: unknown) => {
      limitSpy(n)
      return obj
    }
    obj.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      const next = dbState.queue.shift() ?? []
      return Promise.resolve(next).then(onFulfilled, onRejected)
    }
    return obj
  }
  return { select: () => chain() } as unknown as TenantDb
}

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------
// JST 2026-08-18 12:00。今日の JST 範囲 = [2026-08-17T15:00Z, 2026-08-18T15:00Z)。
const NOW = new Date('2026-08-18T03:00:00.000Z')
const TODAY_START = new Date('2026-08-17T15:00:00.000Z')
const TODAY_END = new Date('2026-08-18T15:00:00.000Z')
const LATER_TODAY = new Date('2026-08-18T09:00:00.000Z')
const PAST = new Date('2026-08-17T03:00:00.000Z')

const USER = 'user-1'
const EXAM = 'exam-1'

function row(overrides: Partial<Card> & { id: string }): Record<string, unknown> {
  return {
    userId: USER,
    examId: EXAM,
    state: 2,
    due: PAST,
    baseOrder: 1024,
    firstReviewedAt: null,
    ...overrides,
  } as unknown as Record<string, unknown>
}

beforeEach(async () => {
  dbState.queue = []
  limitSpy.mockClear()
  const drizzle = await import('drizzle-orm')
  for (const op of ['eq', 'ne', 'lt', 'gte', 'inArray', 'and', 'or', 'asc'] as const) {
    vi.mocked(drizzle[op]).mockClear()
  }
})

describe('getSessionCards', () => {
  it('候補 0 件 → 空配列', async () => {
    dbState.queue = [[], [], []]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, 20, fakeDb(), NOW)
    expect(result).toEqual([])
  })

  it('復習部 (due ASC) → 新規部 (base_order ASC) の順で DB 行を返す', async () => {
    dbState.queue = [
      [{ dailyNewTarget: null }],
      [row({ id: 'r-later', due: LATER_TODAY }), row({ id: 'r-old', due: PAST })],
      [
        row({ id: 'n1', state: 0, baseOrder: 1024 }),
        row({ id: 'n2', state: 0, baseOrder: 2048 }),
      ],
    ]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, 20, fakeDb(), NOW)
    expect(result.map((c) => c.id)).toEqual(['r-old', 'r-later', 'n1', 'n2'])
  })

  it('未到来の Learning は除外し、当日 later-due の Review は含める (§8.5)', async () => {
    dbState.queue = [
      [{ dailyNewTarget: 0 }],
      [
        row({ id: 'l-later', state: 1, due: LATER_TODAY }),
        row({ id: 'r-later', state: 2, due: LATER_TODAY }),
      ],
      [],
    ]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, 20, fakeDb(), NOW)
    expect(result.map((c) => c.id)).toEqual(['r-later'])
  })

  it('user_id で絞る (tenant-isolation guard)', async () => {
    dbState.queue = [[], [], []]
    const { getSessionCards } = await import('./get-session-cards')
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards('user-42', EXAM, 10, fakeDb(), NOW)
    expect(vi.mocked(eq).mock.calls).toContainEqual([cards.userId, 'user-42'])
  })

  it('exam_id で絞る (選択試験スコープ・§8.5)', async () => {
    dbState.queue = [[], [], []]
    const { getSessionCards } = await import('./get-session-cards')
    const { eq } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards(USER, 'exam-42', 10, fakeDb(), NOW)
    expect(vi.mocked(eq).mock.calls).toContainEqual([cards.examId, 'exam-42'])
  })

  it('復習候補は「state≠0 かつ (due < 今日の終わり / first_reviewed_at が今日以降 / state∈{1,3})」で読む', async () => {
    dbState.queue = [[], [], []]
    const { getSessionCards } = await import('./get-session-cards')
    const { ne, lt, gte, inArray } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards(USER, EXAM, 10, fakeDb(), NOW)
    expect(vi.mocked(ne).mock.calls).toContainEqual([cards.state, 0])
    expect(vi.mocked(lt).mock.calls).toContainEqual([cards.due, TODAY_END])
    // first_reviewed_at 側の OR が無いと「今日導入して明日以降へ飛んだカード」を
    // 読み落とし、u が過小 = 新規枠が過大になる。
    expect(vi.mocked(gte).mock.calls).toContainEqual([
      cards.firstReviewedAt,
      TODAY_START,
    ])
    // state∈{1,3} の OR が無いと「今日の終わり以降 due の Learning/Relearning」を
    // 読み落とし、selectSessionPool の nextAvailableAt が過大 (または null) になる
    // = 部分的に間違った値を返す関数になる (fix round 1/5)。
    expect(vi.mocked(inArray).mock.calls).toContainEqual([cards.state, [1, 3]])
  })

  it('nextAvailableAt が client 経路と同じ値になる (今日の終わり以降 due の Learning も読む)', async () => {
    // server fallback 自身は pool しか返さないが、同じ入力で pure module を呼ぶ以上、
    // 戻り値の全項目が正しくなる行集合を読んでおく必要がある。ここでは「読んだ行を
    // 渡せば nextAvailableAt が立つ」ことを、pool が空でも成立する形で確認する。
    const { selectSessionPool } = await import('./domain/session-pool')
    const result = selectSessionPool({
      cards: [
        {
          id: 'l-next-week',
          exam_id: EXAM,
          state: 1,
          due: new Date('2026-08-25T00:00:00.000Z'),
          base_order: 1024,
          first_reviewed_at: null,
        },
      ],
      examId: EXAM,
      dailyNewTarget: 0,
      now: NOW,
    })
    expect(result.pool).toEqual([])
    expect(result.nextAvailableAt?.toISOString()).toBe('2026-08-25T00:00:00.000Z')
  })

  it('新規候補は base_order ASC, id ASC で K 件だけ読む', async () => {
    dbState.queue = [[{ dailyNewTarget: 3 }], [], []]
    const { getSessionCards } = await import('./get-session-cards')
    const { asc } = await import('drizzle-orm')
    const { cards } = await import('@/lib/db/schema')
    await getSessionCards(USER, EXAM, 10, fakeDb(), NOW)
    expect(vi.mocked(asc).mock.calls).toContainEqual([cards.baseOrder])
    expect(vi.mocked(asc).mock.calls).toContainEqual([cards.id])
    // limit(1) は exam 行の読み出し。新規候補側は K 件。
    expect(limitSpy.mock.calls.map((c) => c[0])).toEqual([1, 3])
  })

  it('daily_new_target が null なら DAILY_NEW_DEFAULT 件を読む', async () => {
    dbState.queue = [[{ dailyNewTarget: null }], [], []]
    const { getSessionCards } = await import('./get-session-cards')
    await getSessionCards(USER, EXAM, 10, fakeDb(), NOW)
    expect(limitSpy.mock.calls.map((c) => c[0])).toEqual([1, DAILY_NEW_DEFAULT])
  })

  it('exams 行が無い (他 owner / 削除済) → 既定 K を使う', async () => {
    dbState.queue = [[], [], [row({ id: 'n1', state: 0 })]]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, 10, fakeDb(), NOW)
    expect(limitSpy.mock.calls.map((c) => c[0])).toEqual([1, DAILY_NEW_DEFAULT])
    expect(result.map((c) => c.id)).toEqual(['n1'])
  })

  it('daily_new_target = 0 → 新規は 1 件も出さない', async () => {
    dbState.queue = [
      [{ dailyNewTarget: 0 }],
      [],
      // SQL の LIMIT 0 が効かなくても選定側で 0 件に落ちることを pin する。
      [row({ id: 'n1', state: 0 })],
    ]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, 10, fakeDb(), NOW)
    expect(result).toEqual([])
  })

  it('limit でプールの先頭 N 件に cap する', async () => {
    dbState.queue = [
      [{ dailyNewTarget: null }],
      [row({ id: 'a', due: PAST }), row({ id: 'b', due: LATER_TODAY })],
      [row({ id: 'n1', state: 0 })],
    ]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, 2, fakeDb(), NOW)
    expect(result.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('limit=null → cap せず全件返す (上限なし)', async () => {
    dbState.queue = [
      [{ dailyNewTarget: null }],
      [row({ id: 'a', due: PAST }), row({ id: 'b', due: LATER_TODAY })],
      [row({ id: 'n1', state: 0 })],
    ]
    const { getSessionCards } = await import('./get-session-cards')
    const result = await getSessionCards(USER, EXAM, null, fakeDb(), NOW)
    expect(result.map((c) => c.id)).toEqual(['a', 'b', 'n1'])
  })
})
