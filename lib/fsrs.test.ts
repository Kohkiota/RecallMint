import { describe, it, expect, vi } from 'vitest'
import { Rating } from 'ts-fsrs'
import { newCard, rate, scheduler } from './fsrs'

describe('fsrs', () => {
  it('newCard returns state 0 (New)', () => {
    const card = newCard()
    expect(card.state).toBe(0)
    expect(card.reps).toBe(0)
    expect(card.lapses).toBe(0)
  })

  it('Again(1) due < Easy(4) due', () => {
    const card1 = newCard()
    const card2 = newCard()

    const resultAgain = rate(card1, 1)
    const resultEasy = rate(card2, 4)

    const againDue = resultAgain.card.due.getTime()
    const easyDue = resultEasy.card.due.getTime()

    expect(againDue).toBeLessThan(easyDue)
  })

  it('rate(0) throws invalid rating error', () => {
    const card = newCard()
    expect(() => rate(card, 0 as unknown as 1)).toThrow(/invalid rating/)
  })

  it('rate(5) throws invalid rating error', () => {
    const card = newCard()
    expect(() => rate(card, 5 as unknown as 1)).toThrow(/invalid rating/)
  })

  // RATING_MAP の各対応を scheduler.next の実引数で pin する。中間 rating
  // (Hard↔Good) の入替は相対順テストでは検出できないことを変異実測で確認済
  // (docs/audit/2026-07-17-test-quality-audit.md G1)。now 伝播の検証を兼ねる。
  it.each([
    [1, Rating.Again],
    [2, Rating.Hard],
    [3, Rating.Good],
    [4, Rating.Easy],
  ] as const)('rate(card, %i) は Rating enum %i を scheduler.next に渡す', (ratingInt, expected) => {
    const card = newCard()
    const fixedNow = new Date('2026-06-01T00:00:00Z')
    const spy = vi.spyOn(scheduler, 'next')
    rate(card, ratingInt, fixedNow)
    expect(spy).toHaveBeenCalledWith(card, fixedNow, expected)
    spy.mockRestore()
  })

  // golden: 固定日時の New card を 1 回 rate した出力値 pin (ts-fsrs 5.x default
  // params)。ts-fsrs 更新等で学習スケジュールの実挙動が変わったとき silent に
  // 通さず、ここで割って意図確認するための検知線。値は実測採取 (推測値ではない)。
  it.each([
    [1, '2026-01-01T00:01:00.000Z', 1, 0.212, 6.4133],
    [2, '2026-01-01T00:06:00.000Z', 1, 1.2931, 5.11217071],
    [3, '2026-01-01T00:10:00.000Z', 1, 2.3065, 2.11810397],
    [4, '2026-01-09T00:00:00.000Z', 2, 8.2956, 1],
  ] as const)(
    'golden: rate(newCard, %i) @2026-01-01 → due %s / state %i',
    (ratingInt, dueIso, state, stability, difficulty) => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const { card } = rate(newCard(), ratingInt, now)
      expect(card.due.toISOString()).toBe(dueIso)
      expect(card.state).toBe(state)
      expect(card.reps).toBe(1)
      expect(card.lapses).toBe(0)
      expect(card.stability).toBeCloseTo(stability, 4)
      expect(card.difficulty).toBeCloseTo(difficulty, 4)
    },
  )
})
