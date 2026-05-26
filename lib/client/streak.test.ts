// client streak helper test (S-perf-3 / dashboard 高速化)。
// computeStreak は server lib/db/streak.ts と同一仕様 (pure port)、
// getStreakStatsFromDexie は fake-indexeddb 上の Dexie study_days を直接 seed して
// dashboard 表示用 { todayCardCount, streak } を算出することを verify。

import { describe, it, expect, beforeEach } from 'vitest'
import { getClientDb, type ClientStudyDay } from '@/lib/client-db'
import { computeStreak, getStreakStatsFromDexie } from './streak'

function fakeStudyDay(overrides?: Partial<ClientStudyDay>): ClientStudyDay {
  return {
    user_id: 'user-1',
    day: '2026-04-22',
    review_count: 5,
    correct_count: 3,
    distinct_card_count: 4,
    ...overrides,
  }
}

describe('computeStreak (client port — server と同仕様)', () => {
  it('空 → 0', () => {
    expect(computeStreak([], '2026-04-22')).toBe(0)
  })
  it('今日のみ → 1', () => {
    expect(computeStreak(['2026-04-22'], '2026-04-22')).toBe(1)
  })
  it('連続 3 日 → 3', () => {
    expect(
      computeStreak(['2026-04-22', '2026-04-21', '2026-04-20'], '2026-04-22'),
    ).toBe(3)
  })
  it('ギャップ (today + day-2、 day-1 欠落) → 1', () => {
    expect(computeStreak(['2026-04-22', '2026-04-20'], '2026-04-22')).toBe(1)
  })
  it('today 欠損、 yesterday あり → 2 (yesterday 起点で遡る)', () => {
    expect(computeStreak(['2026-04-21', '2026-04-20'], '2026-04-22')).toBe(2)
  })
  it('期限切れ (latest が day-2 以前) → 0', () => {
    expect(computeStreak(['2026-04-20'], '2026-04-22')).toBe(0)
  })
})

describe('getStreakStatsFromDexie', () => {
  beforeEach(async () => {
    await getClientDb().study_days.clear()
  })

  it('Dexie 空 → { todayCardCount: 0, streak: 0 }', async () => {
    const now = new Date('2026-04-22T12:00:00Z') // JST 2026-04-22 21:00
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res).toEqual({ todayCardCount: 0, streak: 0 })
  })

  it('今日 1 行のみ → todayCardCount = distinct_card_count, streak = 1', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-22',
        review_count: 5,
        distinct_card_count: 7,
      }),
    ])
    const now = new Date('2026-04-22T12:00:00Z')
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res.todayCardCount).toBe(7)
    expect(res.streak).toBe(1)
  })

  it('連続 3 日 (today, -1, -2) → streak = 3', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-22', distinct_card_count: 4 }),
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-21' }),
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-20' }),
    ])
    const now = new Date('2026-04-22T12:00:00Z')
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res.todayCardCount).toBe(4)
    expect(res.streak).toBe(3)
  })

  it('review_count = 0 の day は streak 計算から除外', async () => {
    await getClientDb().study_days.bulkPut([
      // 今日 distinct_card_count はあるが review_count = 0 (= cards 完了せず touch のみ等想定)
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-22',
        review_count: 0,
        distinct_card_count: 0,
      }),
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-21',
        review_count: 3,
      }),
    ])
    const now = new Date('2026-04-22T12:00:00Z')
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res.todayCardCount).toBe(0)
    // today は review_count=0 で除外 → yesterday 起点で streak = 1
    expect(res.streak).toBe(1)
  })

  it('他 user の study_days は混入しない (tenant 分離)', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({
        user_id: 'other-user',
        day: '2026-04-22',
        distinct_card_count: 99,
      }),
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-04-22',
        distinct_card_count: 4,
      }),
    ])
    const now = new Date('2026-04-22T12:00:00Z')
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res.todayCardCount).toBe(4)
    expect(res.streak).toBe(1)
  })

  it('JST 境界: UTC 14:59 (JST 同日 23:59) は today = 当該日', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-22', distinct_card_count: 2 }),
    ])
    const now = new Date('2026-04-22T14:59:00Z') // JST 2026-04-22 23:59
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res.todayCardCount).toBe(2)
    expect(res.streak).toBe(1)
  })

  it('JST 境界: UTC 15:00 (JST 翌日 00:00) は today = 翌日', async () => {
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({ user_id: 'user-1', day: '2026-04-22', distinct_card_count: 2 }),
    ])
    const now = new Date('2026-04-22T15:00:00Z') // JST 2026-04-23 00:00
    const res = await getStreakStatsFromDexie('user-1', now)
    // today = '2026-04-23' → 行なし → todayCardCount = 0
    expect(res.todayCardCount).toBe(0)
    // yesterday = '2026-04-22' (review_count > 0) → streak = 1 (yesterday 起点)
    expect(res.streak).toBe(1)
  })

  it('61 日 window 外の day は無視 (61 日より昔の連続は streak に乗らない)', async () => {
    // today - 65 日に行があっても、 今日/昨日 起点で連続していなければ無関係
    await getClientDb().study_days.bulkPut([
      fakeStudyDay({
        user_id: 'user-1',
        day: '2026-02-16', // 2026-04-22 - 65 日 = 2026-02-16
        review_count: 3,
      }),
    ])
    const now = new Date('2026-04-22T12:00:00Z')
    const res = await getStreakStatsFromDexie('user-1', now)
    expect(res.streak).toBe(0)
  })
})
