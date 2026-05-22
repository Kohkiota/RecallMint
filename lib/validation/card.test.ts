import { describe, it, expect } from 'vitest'
import {
  updateCardInputSchema,
  parseUpdateCardInput,
  type UpdateCardInput,
} from './card'

// card 編集入力の validation。OCR 抽出 card を後から手で直すための schema なので、
// 「正答 0 個」(OCR が正答未記載で取り込んだ直後の状態) は valid 扱いにする点が肝。
describe('updateCardInputSchema', () => {
  const validInput: UpdateCardInput = {
    title: '問1',
    questionText: '次のうち正しいものはどれか。',
    options: [
      { id: 'a', text: '選択肢 A', isCorrect: true },
      { id: 'b', text: '選択肢 B', isCorrect: false },
    ],
    explanationText: 'A が正しい。',
  }

  it('case 1: 正常系 (全 field 揃)', () => {
    const result = updateCardInputSchema.safeParse(validInput)
    expect(result.success).toBe(true)
  })

  it('case 2: title 空 (trim 後 空) で reject', () => {
    const result = updateCardInputSchema.safeParse({ ...validInput, title: '   ' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('タイトルは必須です')
    }
  })

  it('case 3: title 200 文字ちょうどは OK / 201 文字で reject', () => {
    expect(
      updateCardInputSchema.safeParse({ ...validInput, title: 'a'.repeat(200) })
        .success,
    ).toBe(true)
    const over = updateCardInputSchema.safeParse({
      ...validInput,
      title: 'a'.repeat(201),
    })
    expect(over.success).toBe(false)
    if (!over.success) {
      expect(over.error.issues[0].message).toBe(
        'タイトルは 200 文字以内で入力してください',
      )
    }
  })

  it('case 4: questionText 空で reject', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      questionText: '',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('問題文は必須です')
    }
  })

  it('case 5: questionText 10000 文字ちょうどは OK / 10001 で reject', () => {
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        questionText: 'a'.repeat(10000),
      }).success,
    ).toBe(true)
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        questionText: 'a'.repeat(10001),
      }).success,
    ).toBe(false)
  })

  it('case 6: options 0 個で reject', () => {
    const result = updateCardInputSchema.safeParse({ ...validInput, options: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('選択肢は最低 1 個必要です')
    }
  })

  it('case 7: options 50 個は OK / 51 個で reject', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `o${i}`,
        text: `選択肢 ${i}`,
        isCorrect: false,
      }))
    expect(
      updateCardInputSchema.safeParse({ ...validInput, options: mk(50) }).success,
    ).toBe(true)
    const over = updateCardInputSchema.safeParse({
      ...validInput,
      options: mk(51),
    })
    expect(over.success).toBe(false)
    if (!over.success) {
      expect(over.error.issues[0].message).toBe('選択肢は最大 50 個までです')
    }
  })

  it('case 8: option.id 重複で reject', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      options: [
        { id: 'a', text: 'A', isCorrect: true },
        { id: 'a', text: 'B', isCorrect: false },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('選択肢の id が重複しています')
    }
  })

  it('case 9: option.id 空で reject', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      options: [{ id: '', text: 'A', isCorrect: true }],
    })
    expect(result.success).toBe(false)
  })

  it('case 10: option.text 空で reject / 1000 OK / 1001 reject', () => {
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        options: [{ id: 'a', text: '', isCorrect: true }],
      }).success,
    ).toBe(false)
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        options: [{ id: 'a', text: 'a'.repeat(1000), isCorrect: true }],
      }).success,
    ).toBe(true)
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        options: [{ id: 'a', text: 'a'.repeat(1001), isCorrect: true }],
      }).success,
    ).toBe(false)
  })

  it('case 11: option.explanation は省略可 / 2000 OK / 2001 reject', () => {
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        options: [{ id: 'a', text: 'A', isCorrect: true }],
      }).success,
    ).toBe(true)
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        options: [
          { id: 'a', text: 'A', isCorrect: true, explanation: 'x'.repeat(2000) },
        ],
      }).success,
    ).toBe(true)
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        options: [
          { id: 'a', text: 'A', isCorrect: true, explanation: 'x'.repeat(2001) },
        ],
      }).success,
    ).toBe(false)
  })

  it('case 12: explanationText は null 可 / 10001 で reject', () => {
    expect(
      updateCardInputSchema.safeParse({ ...validInput, explanationText: null })
        .success,
    ).toBe(true)
    expect(
      updateCardInputSchema.safeParse({
        ...validInput,
        explanationText: 'a'.repeat(10001),
      }).success,
    ).toBe(false)
  })

  it('case 13: 正答 0 個 (全 isCorrect false) は valid', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      options: [
        { id: 'a', text: 'A', isCorrect: false },
        { id: 'b', text: 'B', isCorrect: false },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('case 14: 正答 複数 (2 個以上 isCorrect true) は valid', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      options: [
        { id: 'a', text: 'A', isCorrect: true },
        { id: 'b', text: 'B', isCorrect: true },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('case 19: questionText が空白のみは reject', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      questionText: '   \n  ',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('問題文は必須です')
    }
  })

  it('case 20: questionText の前後空白は trim せず保持する', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      questionText: '  問題文  ',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.questionText).toBe('  問題文  ')
    }
  })

  it('case 21: option.text が空白のみは reject', () => {
    const result = updateCardInputSchema.safeParse({
      ...validInput,
      options: [{ id: 'a', text: '   ', isCorrect: true }],
    })
    expect(result.success).toBe(false)
  })
})

describe('parseUpdateCardInput', () => {
  const validInput: UpdateCardInput = {
    title: '問1',
    questionText: '問題文',
    options: [{ id: 'a', text: 'A', isCorrect: true }],
    explanationText: null,
  }

  it('case 15: 正常系は ok:true で data を返す', () => {
    const result = parseUpdateCardInput(validInput)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.title).toBe('問1')
    }
  })

  it('case 16: title 前後空白は trim される', () => {
    const result = parseUpdateCardInput({ ...validInput, title: '  問1  ' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.title).toBe('問1')
    }
  })

  it('case 17: 不正入力は ok:false で日本語 error を返す', () => {
    const result = parseUpdateCardInput({ ...validInput, title: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('タイトルは必須です')
    }
  })

  it('case 18: 全く形が違う入力でも ok:false (throw しない)', () => {
    const result = parseUpdateCardInput({ foo: 'bar' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(typeof result.error).toBe('string')
      expect(result.error.length).toBeGreaterThan(0)
    }
  })
})
