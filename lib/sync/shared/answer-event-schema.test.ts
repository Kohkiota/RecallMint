import { describe, it, expect } from 'vitest'
import { answerEventWireSchema } from './answer-event-schema'

function uuid(): string {
  return crypto.randomUUID()
}

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: uuid(),
    card_id: uuid(),
    selected_answer_ids: ['opt-a'],
    is_correct: true,
    rating: 3,
    answered_at: '2026-04-22T12:00:00.000Z',
    ...overrides,
  }
}

describe('answerEventWireSchema', () => {
  it('parses a valid minimal event (session_id / elapsed_ms omitted)', () => {
    const result = answerEventWireSchema.safeParse(validEvent())
    expect(result.success).toBe(true)
  })

  it('parses a valid event with all optional fields present', () => {
    const result = answerEventWireSchema.safeParse(
      validEvent({ session_id: uuid(), elapsed_ms: 1500 }),
    )
    expect(result.success).toBe(true)
  })

  it('rejects when rating is missing (rating 必須)', () => {
    const { rating: _rating, ...rest } = validEvent()
    const result = answerEventWireSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects a rating outside 1-4', () => {
    const result = answerEventWireSchema.safeParse(validEvent({ rating: 5 }))
    expect(result.success).toBe(false)
  })

  it('accepts elapsed_ms at the 86_400_000 upper bound', () => {
    const result = answerEventWireSchema.safeParse(
      validEvent({ elapsed_ms: 86_400_000 }),
    )
    expect(result.success).toBe(true)
  })

  it('rejects elapsed_ms one above the upper bound', () => {
    const result = answerEventWireSchema.safeParse(
      validEvent({ elapsed_ms: 86_400_001 }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a negative elapsed_ms', () => {
    const result = answerEventWireSchema.safeParse(validEvent({ elapsed_ms: -1 }))
    expect(result.success).toBe(false)
  })

  it('accepts selected_answer_ids at the 50-item cap', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `opt-${i}`)
    const result = answerEventWireSchema.safeParse(
      validEvent({ selected_answer_ids: ids }),
    )
    expect(result.success).toBe(true)
  })

  it('rejects selected_answer_ids one over the 50-item cap', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `opt-${i}`)
    const result = answerEventWireSchema.safeParse(
      validEvent({ selected_answer_ids: ids }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a non-uuid event_id', () => {
    const result = answerEventWireSchema.safeParse(
      validEvent({ event_id: 'not-a-uuid' }),
    )
    expect(result.success).toBe(false)
  })
})
