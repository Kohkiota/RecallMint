import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildEmptyCard } from './empty-card'
import type { CardOption } from '@/lib/db/schema'

// Import schemas from validation and update-card-field
import { optionSchema } from '@/lib/validation/card'

// Replicate the title, questionText, and sortKey schemas from update-card-field.ts
const titleSchema = z
  .string()
  .trim()
  .min(1, 'タイトルは必須です')
  .max(200, 'タイトルは 200 文字以内で入力してください')

const questionTextSchema = z
  .string()
  .max(10000, '問題文は 10000 文字以内で入力してください')
  .refine((s) => s.trim().length > 0, { message: '問題文は必須です' })

const sortKeySchema = z
  .string()
  .max(100, 'ソートキーは 100 文字以内で入力してください')
  .nullable()

describe('buildEmptyCard', () => {
  it('returns placeholder values for basic card creation', () => {
    const card = buildEmptyCard([], 0)

    expect(card).toEqual({
      title: '新規カード 1',
      sortKey: '1',
      questionText: '(問題文を入力してください)',
      options: [
        {
          id: '1',
          // Sprint I W5: uid は生成地点 mint(ランダム UUID)ゆえ型のみ検証。
          uid: expect.any(String),
          text: '(選択肢1)',
          is_correct: false,
        },
      ],
      correctAnswerIds: [],
    })
  })

  it('generates correct title based on existing count', () => {
    const card = buildEmptyCard([], 4)
    expect(card.title).toBe('新規カード 5')
  })

  it('generates correct sortKey based on existing keys', () => {
    const card = buildEmptyCard(['1', '2', '3'], 0)
    expect(card.sortKey).toBe('4')
  })

  it('title parses successfully against edit schema', () => {
    const card = buildEmptyCard([], 0)
    const result = titleSchema.safeParse(card.title)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('新規カード 1')
    }
  })

  it('questionText parses successfully against edit schema', () => {
    const card = buildEmptyCard([], 0)
    const result = questionTextSchema.safeParse(card.questionText)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('(問題文を入力してください)')
    }
  })

  it('options convert to edit-compatible format and validate', () => {
    const card = buildEmptyCard([], 0)

    // Convert from CardOption (snake_case is_correct) to optionSchema format (camelCase isCorrect)
    const convertedOptions = card.options.map((o: CardOption) => ({
      id: o.id,
      uid: o.uid,
      text: o.text,
      isCorrect: o.is_correct,
    }))

    const result = z
      .array(optionSchema)
      .min(1)
      .safeParse(convertedOptions)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(1)
      expect(result.data[0].id).toBe('1')
      expect(result.data[0].text).toBe('(選択肢1)')
      expect(result.data[0].isCorrect).toBe(false)
    }
  })

  it('correctAnswerIds is always empty array', () => {
    const card = buildEmptyCard(['1', '2'], 10)
    expect(card.correctAnswerIds).toEqual([])
  })

  it('options has exactly 1 placeholder option with non-empty text', () => {
    const card = buildEmptyCard([], 0)
    expect(card.options).toHaveLength(1)
    expect(card.options[0].text.trim().length).toBeGreaterThan(0)
    expect(card.options[0].is_correct).toBe(false)
  })

  it('works with various existingSortKeys inputs', () => {
    // null and empty strings should be filtered out
    const card1 = buildEmptyCard([null, '', '5'], 0)
    expect(card1.sortKey).toBe('6')

    // Numeric keys
    const card2 = buildEmptyCard(['001', '002', '009'], 0)
    expect(card2.sortKey).toBe('10')

    // Mixed keys (fallback)
    const card3 = buildEmptyCard(['03-02', '1'], 0)
    expect(card3.sortKey).toBe('3')
  })

  it('works with various existingCount inputs', () => {
    const card0 = buildEmptyCard([], 0)
    expect(card0.title).toBe('新規カード 1')

    const card99 = buildEmptyCard([], 99)
    expect(card99.title).toBe('新規カード 100')
  })

  it('full validation pipeline: all fields pass respective schemas', () => {
    const card = buildEmptyCard(['1', '2'], 5)

    // Validate title
    const titleResult = titleSchema.safeParse(card.title)
    expect(titleResult.success).toBe(true)

    // Validate sortKey
    const sortKeyResult = sortKeySchema.safeParse(card.sortKey)
    expect(sortKeyResult.success).toBe(true)

    // Validate questionText
    const qResult = questionTextSchema.safeParse(card.questionText)
    expect(qResult.success).toBe(true)

    // Validate options in edit format
    const convertedOptions = card.options.map((o: CardOption) => ({
      id: o.id,
      uid: o.uid,
      text: o.text,
      isCorrect: o.is_correct,
    }))
    const optResult = z.array(optionSchema).min(1).safeParse(convertedOptions)
    expect(optResult.success).toBe(true)

    // Validate correctAnswerIds
    expect(Array.isArray(card.correctAnswerIds)).toBe(true)
    expect(card.correctAnswerIds).toHaveLength(0)
  })
})
