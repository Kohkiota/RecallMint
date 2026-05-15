import { describe, it, expect } from 'vitest'
import { submitContact } from './actions'

describe('submitContact', () => {
  const validInput = {
    name: '山田太郎',
    email: 'taro@example.com',
    subject: 'お問い合わせ',
    message: 'はじめまして。',
  }

  it('zod 違反 (subject 空) → ok:false + error message', async () => {
    const result = await submitContact({ ...validInput, subject: '' })
    expect(result).toEqual({ ok: false, error: '件名は必須です' })
  })

  it('honeypot trip (website 値あり) → ok:true (silent reject)', async () => {
    const result = await submitContact({
      ...validInput,
      website: 'http://spam.example.com',
    })
    expect(result).toEqual({ ok: true })
  })

  it('正常系 → ok:true (Sprint A-2 stub、 DB INSERT は Sprint A-3+)', async () => {
    const result = await submitContact(validInput)
    expect(result).toEqual({ ok: true })
  })

  it('honeypot 空文字 (送信時 default) は通常の送信扱い', async () => {
    const result = await submitContact({ ...validInput, website: '' })
    expect(result).toEqual({ ok: true })
  })
})
