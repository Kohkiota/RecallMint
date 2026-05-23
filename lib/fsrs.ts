import { createEmptyCard, fsrs, Rating, type Card } from 'ts-fsrs'

// Scheduler singleton with default parameters. MVP keeps defaults; future
// per-user parameter optimization is out of scope (plan YAGNI list).
export const scheduler = fsrs()

/**
 * 0 = Manual / 1 = Again / 2 = Hard / 3 = Good / 4 = Easy
 * The app uses 1..4 (no Manual) on the UI side. We map to the lib's `Rating`
 * enum here so callers stay decoupled from the upstream enum shape.
 */
export type RatingInt = 1 | 2 | 3 | 4

const RATING_MAP = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
} as const

export function newCard(): Card {
  return createEmptyCard()
}

export function rate(card: Card, rating: RatingInt, now: Date = new Date()) {
  const enumVal = RATING_MAP[rating]
  if (enumVal === undefined) {
    throw new Error(`invalid rating: ${rating} (must be 1..4)`)
  }
  return scheduler.next(card, now, enumVal)
}
