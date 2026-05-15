import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({ getDb: () => mockDb }))

import { computeStreak, getReviewStatsForUser } from './streak'
import { todayInJst } from '@/lib/jst'

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
// SQL string assertion は除外、 mock 戻り値が dashboard まで pipeline 通る
// verification + return shape contract に限定。
// 「同 card 複数 rate でも DISTINCT で 1 カウント」 の DB 実挙動統合検証は
// production smoke で実施。
// --------------------------------------------------------------------------
describe('getReviewStatsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('test 1: 正常系 — mock の todayCardCount + streak が return される', async () => {
    const today = todayInJst()
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ d: today }] })

    const res = await getReviewStatsForUser('user_1')
    expect(res.todayCardCount).toBe(5)
    expect(res.streak).toBe(1)
  })

  it('test 2: 同 card 1 カウント (mock count=1 が dashboard に届く pipeline 検証)', async () => {
    const today = todayInJst()
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ d: today }] })

    const res = await getReviewStatsForUser('user_1')
    expect(res.todayCardCount).toBe(1)
  })

  it('test 3: return shape contract — { todayCardCount, streak } 2 field、 旧 todayWordCount は存在しない', async () => {
    const today = todayInJst()
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ d: today }] })

    const res = await getReviewStatsForUser('user_1')
    expect(res).toHaveProperty('todayCardCount', 3)
    expect(res).toHaveProperty('streak', 1)
    expect(res).not.toHaveProperty('todayWordCount')
  })
})
