import { describe, it, expect, vi } from 'vitest'
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

  it('now を渡すと scheduler.next に伝播する', () => {
    const card = newCard()
    const fixedNow = new Date('2026-06-01T00:00:00Z')
    const spy = vi.spyOn(scheduler, 'next')
    rate(card, 3, fixedNow)
    expect(spy).toHaveBeenCalledWith(card, fixedNow, expect.any(Number))
    spy.mockRestore()
  })
})
