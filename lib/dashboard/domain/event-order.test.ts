// event-order — 定義 doc §4-K の決定的順序規則と初見/復習分割の unit。

import { describe, expect, it } from 'vitest'
import { compareEvents, splitFirstAndReview } from './event-order'

function ev(overrides: {
  card_id: string
  event_id: string
  answered_at: string
  is_correct?: boolean
}) {
  return {
    is_correct: true,
    ...overrides,
  }
}

describe('compareEvents (answered_at ASC, event_id ASC)', () => {
  it('answered_at が異なれば昇順', () => {
    const a = ev({ card_id: 'c1', event_id: 'e2', answered_at: '2026-08-01T00:00:01Z' })
    const b = ev({ card_id: 'c1', event_id: 'e1', answered_at: '2026-08-01T00:00:00Z' })
    expect(compareEvents(a, b)).toBeGreaterThan(0)
    expect(compareEvents(b, a)).toBeLessThan(0)
  })

  it('answered_at が同値なら event_id 昇順(決定性のためのタイブレーク)', () => {
    const a = ev({ card_id: 'c1', event_id: 'b', answered_at: '2026-08-01T00:00:00Z' })
    const b = ev({ card_id: 'c1', event_id: 'a', answered_at: '2026-08-01T00:00:00Z' })
    expect(compareEvents(a, b)).toBeGreaterThan(0)
    expect(compareEvents(b, a)).toBeLessThan(0)
  })

  it('完全一致は 0', () => {
    const a = ev({ card_id: 'c1', event_id: 'a', answered_at: '2026-08-01T00:00:00Z' })
    expect(compareEvents(a, a)).toBe(0)
  })
})

describe('splitFirstAndReview (定義 doc §4-K/§4-L)', () => {
  it('card ごとの最初の 1 件(answered_at 最小)だけが初見、残りは復習', () => {
    const events = [
      ev({ card_id: 'c1', event_id: 'e2', answered_at: '2026-08-01T00:00:02Z', is_correct: false }),
      ev({ card_id: 'c1', event_id: 'e1', answered_at: '2026-08-01T00:00:01Z', is_correct: true }),
      ev({ card_id: 'c2', event_id: 'e3', answered_at: '2026-08-01T00:00:00Z', is_correct: true }),
    ]
    const { first, review } = splitFirstAndReview(events)
    expect(first.map((e) => e.event_id).sort()).toEqual(['e1', 'e3'])
    expect(review.map((e) => e.event_id)).toEqual(['e2'])
  })

  it('入力の並び順に依存しない(内部で card ごとに再ソートする)', () => {
    const eventsAsc = [
      ev({ card_id: 'c1', event_id: 'e1', answered_at: '2026-08-01T00:00:01Z' }),
      ev({ card_id: 'c1', event_id: 'e2', answered_at: '2026-08-01T00:00:02Z' }),
    ]
    const eventsDesc = [eventsAsc[1], eventsAsc[0]]
    expect(splitFirstAndReview(eventsAsc).first.map((e) => e.event_id)).toEqual(
      splitFirstAndReview(eventsDesc).first.map((e) => e.event_id),
    )
  })

  it('1 card 1 event のみなら review は空', () => {
    const events = [ev({ card_id: 'c1', event_id: 'e1', answered_at: '2026-08-01T00:00:00Z' })]
    const { first, review } = splitFirstAndReview(events)
    expect(first).toHaveLength(1)
    expect(review).toHaveLength(0)
  })

  it('同時刻の同一 card 2 event は event_id 昇順で初見が決まる(決定性)', () => {
    const events = [
      ev({ card_id: 'c1', event_id: 'zzz', answered_at: '2026-08-01T00:00:00Z' }),
      ev({ card_id: 'c1', event_id: 'aaa', answered_at: '2026-08-01T00:00:00Z' }),
    ]
    const { first } = splitFirstAndReview(events)
    expect(first[0].event_id).toBe('aaa')
  })
})
