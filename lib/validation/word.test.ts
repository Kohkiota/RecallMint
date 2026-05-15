import { describe, it, expect } from 'vitest'
import { wordSchema } from './word'

describe('wordSchema', () => {
  it('case 1: 正常 (3 field 揃)', () => {
    const input = {
      word: 'apple',
      meaning: 'りんご',
      userExample: 'I ate an apple.',
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.word).toBe('apple')
      expect(result.data.meaning).toBe('りんご')
      expect(result.data.userExample).toBe('I ate an apple.')
    }
  })

  it('case 2: userExample 省略', () => {
    const input = {
      word: 'apple',
      meaning: 'りんご',
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.word).toBe('apple')
      expect(result.data.meaning).toBe('りんご')
      expect(result.data.userExample).toBeUndefined()
    }
  })

  it('case 3: word cap 上限 (64)', () => {
    const word64 = 'a'.repeat(64)
    const input = {
      word: word64,
      meaning: 'test',
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('case 4: word cap +1 (65)', () => {
    const word65 = 'a'.repeat(65)
    const input = {
      word: word65,
      meaning: 'test',
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('単語は 64 文字以内で入力してください')
    }
  })

  it('case 5: meaning cap +1 (101)', () => {
    const meaning101 = 'a'.repeat(101)
    const input = {
      word: 'test',
      meaning: meaning101,
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('意味は 100 文字以内で入力してください')
    }
  })

  it('case 6: userExample cap +1 (301)', () => {
    const userExample301 = 'a'.repeat(301)
    const input = {
      word: 'test',
      meaning: 'test',
      userExample: userExample301,
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('例文は 300 文字以内で入力してください')
    }
  })

  it('case 7: 空 word', () => {
    const input = {
      word: '',
      meaning: 'x',
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('単語は必須です')
    }
  })

  it('case 8: 空 meaning', () => {
    const input = {
      word: 'x',
      meaning: '',
    }
    const result = wordSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('意味は必須です')
    }
  })
})
