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
    expect(payload.cardsExcludedReasons).toEqual(normalized.cardsExcludedReasons)
    // 契約: parse() の戻り値そのもの(candidate をそのまま返さない・spec §5.4)。
    expect(() => preparedPayloadSchema.parse(payload)).not.toThrow()
  })

  it('card 除外理由の内訳を **normalize の実値のまま** 透過する(0 埋め・取り違えを許さない)', () => {
    // 3 区分を相異なる件数で同時に踏ませる(malformed 2 / invariant_failed 1 /
    // card_id_invalid 1)。 全 0 へ潰す実装や区分を入れ替える実装はここで落ちる。
    const dupSeed = randomUUID()
    let issued = 0
    const factory = () => {
      issued += 1
      // 呼出順: malformed 2 枚は factory を消費しない(構造破損は id 発行前に落ちる)。
      // 3 枚目(invariant_failed)= cardId#1 + uid#2,#3 / 4 枚目(生存)= cardId#4 +
      // uid#5,#6 / 5 枚目 = cardId#7 + uid#8,#9。 #4 と #7 を同値にして cardId 衝突
      // だけを作る(option uid は毎回新規のまま)。
      if (issued === 4 || issued === 7) return dupSeed
      return randomUUID()
    }
    const normalized = normalizePrepared(
      {
        cards: [
          { ...rawCard, question_text: 123 }, // malformed
          { ...rawCard, options: 'not-an-array' }, // malformed
          { ...rawCard, question_text: '   ' }, // invariant_failed
          { ...rawCard, title: 'survivor' }, // 生存(cardId=dupSeed)
          { ...rawCard, title: 'dup' }, // card_id_invalid(cardId=dupSeed)
        ],
      },
      new Set(['s1']),
      factory,
    )
    expect(normalized.cardsExcludedReasons).toEqual({
      malformed: 2,
      invariant_failed: 1,
      card_id_invalid: 1,
    })

    const payload = assemblePreparedPayload(normalized)
    expect(payload.cardsExcludedReasons).toEqual(normalized.cardsExcludedReasons)
    expect(payload.cardsExcluded).toBe(4)
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
