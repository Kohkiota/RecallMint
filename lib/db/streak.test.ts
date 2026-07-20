import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({ getDb: () => mockDb }))

import { computeStreak } from '@/lib/streak-core'
// RLS-P2: getReviewStatsForUser は dbc を必須引数で受け取る。mock された getDb()
// (= mockDb) を dbc として渡し、dbc.execute() を mockDb.execute に通す。
import { getDb } from '@/lib/db'
import { getReviewStatsForUser } from './streak'

describe('computeStreak', () => {
  it('空 → 0', () => {
    expect(computeStreak([], '2026-04-22')).toBe(0)
  })

  it('今日のみ → 1', () => {
    expect(computeStreak(['2026-04-22'], '2026-04-22')).toBe(1)
  })

  it('連続 3 日 (today, -1, -2) → 3', () => {
    expect(
      computeStreak(['2026-04-22', '2026-04-21', '2026-04-20'], '2026-04-22'),
    ).toBe(3)
  })

  it('ギャップ (today + day-2, no day-1) → 1 (today のみで止まる)', () => {
    expect(computeStreak(['2026-04-22', '2026-04-20'], '2026-04-22')).toBe(1)
  })

  it('today 欠損、yesterday あり → 2 (yesterday から遡る)', () => {
    expect(
      computeStreak(['2026-04-21', '2026-04-20'], '2026-04-22'),
    ).toBe(2)
  })

  it('期限切れ (latest が day-2 以前) → 0', () => {
    expect(computeStreak(['2026-04-20'], '2026-04-22')).toBe(0)
  })
})

// --------------------------------------------------------------------------
// getReviewStatsForUser DB mock test
// study_days 経由の実装 (T3): SQL に AT TIME ZONE は含まない。
// mock 戻り値が dashboard まで pipeline 通る verification + return shape contract。
// --------------------------------------------------------------------------
describe('getReviewStatsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('test 1: 正常系 — study_days の distinct_card_count と streak が return される', async () => {
    // Fixed now: 2026-04-22 UTC 12:00 = JST 2026-04-22 21:00 → today = '2026-04-22'
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    // First execute: todayCardCount (SELECT distinct_card_count FROM study_days WHERE day = today)
    // Second execute: streak dates (SELECT day FROM study_days WHERE ... review_count > 0)
    // postgres-js: execute() は RowList<T[]> (Array-like) を返す。 旧 Neon の
    // { rows: [...] } ラッピングは廃止。
    mockDb.execute
      .mockResolvedValueOnce([{ c: 5 }])
      .mockResolvedValueOnce([{ d: '2026-04-22' }])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.todayCardCount).toBe(5)
    expect(res.streak).toBe(1)
  })

  it('test 2: study_days 行不在 → todayCardCount = 0', async () => {
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    // No row for today in study_days
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.todayCardCount).toBe(0)
    expect(res.streak).toBe(0)
  })

  it('test 3: study_days 行あり → distinct_card_count を読む', async () => {
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    mockDb.execute
      .mockResolvedValueOnce([{ c: 7 }])
      .mockResolvedValueOnce([{ d: '2026-04-22' }])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.todayCardCount).toBe(7)
  })

  it('test 4: streak 0 — study_days に review_count > 0 の行なし', async () => {
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    mockDb.execute
      .mockResolvedValueOnce([{ c: 0 }])
      .mockResolvedValueOnce([])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.streak).toBe(0)
  })

  it('test 5: 連続日カウント — 3 日連続', async () => {
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    mockDb.execute
      .mockResolvedValueOnce([{ c: 3 }])
      .mockResolvedValueOnce([
        { d: '2026-04-22' },
        { d: '2026-04-21' },
        { d: '2026-04-20' },
      ])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.streak).toBe(3)
  })

  it('test 6: today missing — 昨日基点で streak 計算', async () => {
    // today = '2026-04-22', but study_days has only yesterday and day before
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    mockDb.execute
      .mockResolvedValueOnce([]) // no row for today
      .mockResolvedValueOnce([{ d: '2026-04-21' }, { d: '2026-04-20' }])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.todayCardCount).toBe(0)
    expect(res.streak).toBe(2) // yesterday + day before = 2
  })

  it('test 7: now 引数注入で時刻固定 — JST 変換確認 (UTC 14:59 = JST 23:59 同日、 翌日 00:00 境界手前)', async () => {
    // UTC 2026-04-22T14:59:00Z = JST 2026-04-22T23:59:00+09:00 → today still '2026-04-22'
    const fixedNow = new Date('2026-04-22T14:59:00Z')
    mockDb.execute
      .mockResolvedValueOnce([{ c: 2 }])
      .mockResolvedValueOnce([{ d: '2026-04-22' }])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.todayCardCount).toBe(2)
  })

  it('test 8: now 引数注入 — UTC 15:00 = JST 翌日 00:00 (境界)', async () => {
    // UTC 2026-04-22T15:00:00Z = JST 2026-04-23T00:00:00+09:00 → today = '2026-04-23'
    const fixedNow = new Date('2026-04-22T15:00:00Z')
    // today for this call is '2026-04-23'
    mockDb.execute
      .mockResolvedValueOnce([]) // no study_days row for 2026-04-23
      .mockResolvedValueOnce([{ d: '2026-04-22' }]) // yesterday has data

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res.todayCardCount).toBe(0)
    // yesterday ('2026-04-22') present relative to today ('2026-04-23') → streak 1
    expect(res.streak).toBe(1)
  })

  it('test 9: return shape contract — { todayCardCount, streak } 2 field', async () => {
    const fixedNow = new Date('2026-04-22T12:00:00Z')
    mockDb.execute
      .mockResolvedValueOnce([{ c: 3 }])
      .mockResolvedValueOnce([{ d: '2026-04-22' }])

    const res = await getReviewStatsForUser('user_1', getDb(), fixedNow)
    expect(res).toHaveProperty('todayCardCount', 3)
    expect(res).toHaveProperty('streak', 1)
    expect(res).not.toHaveProperty('todayWordCount')
  })

  it('test 10: now 省略 (undefined) でも動く — 内部で new Date() を使う', async () => {
    mockDb.execute
      .mockResolvedValueOnce([{ c: 1 }])
      .mockResolvedValueOnce([])

    // Should not throw when now is omitted
    const res = await getReviewStatsForUser('user_1', getDb())
    expect(res).toHaveProperty('todayCardCount')
    expect(res).toHaveProperty('streak')
  })
})
