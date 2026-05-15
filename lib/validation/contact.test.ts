import { describe, it, expect } from 'vitest'
import { contactSchema } from './contact'

describe('contactSchema', () => {
  const validInput = {
    name: '山田太郎',
    email: 'taro@example.com',
    subject: 'お問い合わせ',
    message: 'はじめまして。',
  }

  it('case 1: 正常 (4 必須 field 揃)', () => {
    const result = contactSchema.safeParse(validInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('山田太郎')
      expect(result.data.email).toBe('taro@example.com')
      expect(result.data.subject).toBe('お問い合わせ')
      expect(result.data.message).toBe('はじめまして。')
    }
  })

  it('case 2: name 必須 (空文字)', () => {
    const result = contactSchema.safeParse({ ...validInput, name: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('お名前は必須です')
    }
  })

  it('case 3: name cap 上限 (100) は OK', () => {
    const name100 = 'a'.repeat(100)
    const result = contactSchema.safeParse({ ...validInput, name: name100 })
    expect(result.success).toBe(true)
  })

  it('case 4: name cap +1 (101) で reject', () => {
    const name101 = 'a'.repeat(101)
    const result = contactSchema.safeParse({ ...validInput, name: name101 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('お名前は 100 文字以内で入力してください')
    }
  })

  it('case 5: email 形式不正で reject', () => {
    const result = contactSchema.safeParse({ ...validInput, email: 'not-an-email' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('メールアドレスの形式が正しくありません')
    }
  })

  it('case 6: email cap +1 (255) で reject', () => {
    // 254 char までは許容 → 255 char で reject。
    // local 243 char + '@example.com'(12) = 255 char
    const local = 'a'.repeat(243)
    const result = contactSchema.safeParse({
      ...validInput,
      email: `${local}@example.com`,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // 形式 OK だが長さ NG → max 違反 message
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain('メールアドレスは 254 文字以内で入力してください')
    }
  })

  it('case 7: subject cap +1 (201) で reject', () => {
    const subject201 = 'a'.repeat(201)
    const result = contactSchema.safeParse({ ...validInput, subject: subject201 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('件名は 200 文字以内で入力してください')
    }
  })

  it('case 8: message cap +1 (5001) で reject', () => {
    const message5001 = 'a'.repeat(5001)
    const result = contactSchema.safeParse({ ...validInput, message: message5001 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('本文は 5000 文字以内で入力してください')
    }
  })

  it('case 9: honeypot website は schema 上空文字 OK (parse 成功)', () => {
    const result = contactSchema.safeParse({ ...validInput, website: '' })
    expect(result.success).toBe(true)
  })

  it('case 10: honeypot website は schema 上値あり OK (parse 成功、 silent reject は server action 側)', () => {
    const result = contactSchema.safeParse({ ...validInput, website: 'http://spam.example.com' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.website).toBe('http://spam.example.com')
    }
  })

  it('case 11: honeypot website 省略 (undefined) も parse 成功', () => {
    const result = contactSchema.safeParse(validInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.website).toBeUndefined()
    }
  })
})
