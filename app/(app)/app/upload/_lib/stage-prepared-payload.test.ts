import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { normalizePrepared, type NormalizePreparedResult } from '@/lib/ocr/normalize-prepared'
import { preparedPayloadSchema } from '@/lib/ocr/prepared-schema'
import { assemblePreparedPayload, computePreparedHash } from './stage-prepared-payload'

const rawCard = {
  title: '問1',
  question_text: 'リード文',
  options: [
    { id: 'a', text: '選択肢A', is_correct: true },
    { id: 'b', text: '選択肢B', is_correct: false },
  ],
  correct_answer_ids: ['a'],
}

function normalize(cards: unknown[]): NormalizePreparedResult {
  return normalizePrepared({ cards }, new Set(['s1']), randomUUID)
}

describe('assemblePreparedPayload', () => {
  it('wraps a normalizePrepared result into a schemaVersion:1 payload that passes preparedPayloadSchema', () => {
    const normalized = normalize([rawCard])
    expect(normalized.cards).toHaveLength(1)

    const payload = assemblePreparedPayload(normalized)

    expect(payload.schemaVersion).toBe(1)
    expect(payload.cards).toEqual(normalized.cards)
    expect(payload.cardsTotal).toBe(normalized.cardsTotal)
    expect(payload.cardsExcluded).toBe(normalized.cardsExcluded)
    expect(payload.figuresExcluded).toEqual(normalized.figuresExcluded)
    // 契約: parse() の戻り値そのもの(candidate をそのまま返さない・spec §5.4)。
    expect(() => preparedPayloadSchema.parse(payload)).not.toThrow()
  })

  it('empty cards[] still assembles to a valid (schema-passing) payload — caller decides the "empty" outcome, not this function', () => {
    const normalized = normalize([])
    expect(normalized.cards).toHaveLength(0)

    const payload = assemblePreparedPayload(normalized)
    expect(payload.cards).toEqual([])
    expect(payload.cardsTotal).toBe(0)
    expect(() => preparedPayloadSchema.parse(payload)).not.toThrow()
  })

  it('throws (loud) if fed a shape that cannot satisfy preparedPayloadSchema — a bug signal, not swallowed', () => {
    const brokenResult = {
      cards: [{ not: 'a prepared card' }],
      cardsTotal: 1,
      cardsExcluded: 0,
      figuresExcluded: {
        coordinate_null: 0,
        source_id_invalid: 0,
        malformed: 0,
        asset_id_invalid: 0,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adversarial input on purpose
    } as any
    expect(() => assemblePreparedPayload(brokenResult)).toThrow()
  })
})

describe('computePreparedHash', () => {
  it('is deterministic for identical payloads', () => {
    const normalized = normalize([rawCard])
    const payload = assemblePreparedPayload(normalized)
    expect(computePreparedHash(payload)).toBe(computePreparedHash(payload))
  })

  it('differs when the payload content differs', () => {
    const a = assemblePreparedPayload(normalize([rawCard]))
    const b = assemblePreparedPayload(normalize([rawCard, { ...rawCard, title: '問2' }]))
    expect(computePreparedHash(a)).not.toBe(computePreparedHash(b))
  })

  it('returns a 64-char hex sha256 digest', () => {
    const payload = assemblePreparedPayload(normalize([rawCard]))
    const hash = computePreparedHash(payload)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
