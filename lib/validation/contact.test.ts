import { describe, it, expect } from 'vitest'
import { contactSchema, CONTACT_CATEGORIES } from './contact'

describe('contactSchema', () => {
  const validInput = {
    email: 'taro@example.com',
    category: 'general' as const,
    subject: 'お問い合わせ',
    body: 'はじめまして。',
  }

  it('case 1: 正常 (4 必須 field 揃)', () => {
    const result = contactSchema.safeParse(validInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.email).toBe('taro@example.com')
      expect(result.data.category).toBe('general')
      expect(result.data.subject).toBe('お問い合わせ')
      expect(result.data.body).toBe('はじめまして。')
    }
  })

  it('case 2: email 形式不正で reject', () => {
    const result = contactSchema.safeParse({ ...validInput, email: 'not-an-email' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('メールアドレスの形式が正しくありません')
    }
  })

  it('case 3: email cap +1 (255) で reject', () => {
    const local = 'a'.repeat(243)
    const result = contactSchema.safeParse({
      ...validInput,
      email: `${local}@example.com`,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain('メールアドレスは 254 文字以内で入力してください')
    }
  })

  it('case 4: category enum 外で reject', () => {
    const result = contactSchema.safeParse({ ...validInput, category: 'spam' })
    expect(result.success).toBe(false)
  })

  it('case 5: subject 空文字で reject', () => {
    const result = contactSchema.safeParse({ ...validInput, subject: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('件名は必須です')
    }
  })

  it('case 6: subject cap +1 (201) で reject', () => {
    const subject201 = 'a'.repeat(201)
    const result = contactSchema.safeParse({ ...validInput, subject: subject201 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('件名は 200 文字以内で入力してください')
    }
  })

  it('case 7: body 空文字で reject', () => {
    const result = contactSchema.safeParse({ ...validInput, body: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('本文は必須です')
    }
  })

  it('case 8: body cap +1 (5001) で reject', () => {
    const body5001 = 'a'.repeat(5001)
    const result = contactSchema.safeParse({ ...validInput, body: body5001 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('本文は 5000 文字以内で入力してください')
    }
  })

  it('case 9: honeypot website は空文字 OK (parse 成功)', () => {
    const result = contactSchema.safeParse({ ...validInput, website: '' })
    expect(result.success).toBe(true)
  })

  it('case 10: honeypot website 値あり OK (parse 成功、silent reject は server action 側)', () => {
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

  it('case 12: CONTACT_CATEGORIES 全値で parse 成功', () => {
    for (const category of CONTACT_CATEGORIES) {
      const result = contactSchema.safeParse({ ...validInput, category })
      expect(result.success).toBe(true)
    }
  })

  it('case 13: name field は削除済 (Sprint A-3.2、個人情報最小化)', () => {
    // name を含めて parse → strict mode でない zod は extra field を strip
    // するだけだが、出力に name は含まれないことを確認
    const result = contactSchema.safeParse({ ...validInput, name: '山田太郎' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('name' in result.data).toBe(false)
    }
  })
})
